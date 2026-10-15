/**
 * Background compaction wired into the real host.
 *
 * Every scenario drives the installed SDK (`createAgentSession`) with a
 * scripted fake provider and the package's real extension entry. Background
 * summarization uses an injected text summarizer bound to the session's
 * provider scope, so no request leaves the process and the host summarizer is
 * counted separately.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Api, Model, TranscriptContext } from "@earendil-works/pi-ai";
import {
  type CompactionEntry,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import {
  type ChildCoordinatorContext,
  resolveChildCompactionProvider,
} from "../../choco-pi-subagents/src/child-compaction-bridge.ts";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";

import { getCoordinator } from "../src/background/registry.ts";
import type { CompactCommandHost } from "../src/background-host/host-command.ts";
import { TEXT_BACKEND_ID, type TextSummarizer } from "../src/background/text-backend.ts";
import type { AnthropicSupportEntry } from "../src/anthropic/capability.ts";
import registerCompaction, {
  type BackgroundAdoptionNotice,
  getBackgroundAdoptionSignal,
  mainOwnerKey,
} from "../src/index.ts";
import {
  compactionEntries,
  createHost,
  fakeModel,
  type Host,
  type HostOptions,
  mentions,
  PREFIX_A,
  reply,
  type Responder,
} from "./host-boundary-fixture.ts";

const CHECKPOINT = "BACKGROUND-CHECKPOINT";
const SUMMARY = [
  "## Goal",
  CHECKPOINT,
  "## Constraints & Preferences",
  "- None",
  "## Progress",
  "### Done",
  "- Seeded",
  "### In Progress",
  "- Working",
  "### Blocked",
  "",
  "## Key Decisions",
  "- None",
  "## Next Steps",
  "1. Continue",
  "## Critical Context",
  "- None",
].join("\n");

const ENABLED_SIDECAR = JSON.stringify({
  enabled: true,
  text: true,
  prepareAt: 0.5,
  hysteresis: 0.1,
  reserveTokens: 0,
  retryBaseMs: 0,
  cooldownMs: 0,
  timeoutMs: 20_000,
  maxOutputTokens: 1_000,
});
const CONTEXT_WINDOW = 100_000;
const HIGH_USAGE = 60_000;

/** Pi's (patched) typed-command handler, invoked the way the interactive mode does. */
interface TypedCompactPrototype {
  handleCompactCommand: (
    this: CompactCommandHost & { clearStatusIndicator(): void },
    customInstructions?: string,
  ) => Promise<void>;
}

/** Type `/compact` into the TUI: run the prototype method on the rig's session. */
async function typeCompact(rig: Rig, customInstructions?: string): Promise<void> {
  const prototype: object = InteractiveMode.prototype;
  // SAFETY: the test reaches the private method the bridge swaps.
  const handler = (prototype as TypedCompactPrototype).handleCompactCommand;
  await handler.call({ session: rig.session, clearStatusIndicator: () => {} }, customInstructions);
}
/** Background on, but the usage threshold is never crossed: only /compact starts a preparation. */
const MANUAL_ONLY_SIDECAR = JSON.stringify({
  enabled: true,
  text: true,
  prepareAt: 0.99,
  hysteresis: 0,
  reserveTokens: 0,
  retryBaseMs: 0,
  cooldownMs: 0,
  timeoutMs: 20_000,
  maxOutputTokens: 1_000,
});

interface Gate {
  open(): void;
  readonly opened: Promise<void>;
}

function gate(initiallyOpen = true): Gate {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (initiallyOpen) resolve();
  return { open: () => resolve(), opened: promise };
}

interface CompactEvent {
  readonly reason: string;
  readonly fromExtension: boolean;
  readonly entryId: string;
}

interface Rig {
  readonly session: Host["session"];
  readonly manager: SessionManager;
  readonly ownerKey: string;
  readonly calls: TranscriptContext[];
  readonly hostSummarizerCalls: TranscriptContext[];
  readonly compactEvents: CompactEvent[];
  readonly notices: BackgroundAdoptionNotice[];
  backgroundCalls(): number;
  /** Prompt text of every background summarizer pass, in order. */
  readonly backgroundPrompts: string[];
  aborts(): number;
  dispose(): Promise<void>;
}

interface RigOptions {
  /** Sidecar file text, written verbatim. */
  readonly sidecar: string;
  /** Extensions loaded before the compaction extension. */
  readonly firstExtensions?: readonly ExtensionFactory[];
  /** Extensions loaded after the compaction extension. */
  readonly extraExtensions?: readonly ExtensionFactory[];
  readonly respond: Responder;
  readonly dir: string;
  readonly manager?: SessionManager;
  readonly persistent?: boolean;
  readonly hostCompaction?: HostOptions["compaction"];
  readonly summarizerGate?: Gate;
  readonly baseUrl?: string;
  /** Admit the rig's fake model to the Anthropic native lane (no capture is ever produced). */
  readonly anthropicAllowList?: readonly AnthropicSupportEntry[];
}

function textSummarizer(
  model: Model<Api>,
  onCall: (promptText: string) => void,
  wait: Gate,
): TextSummarizer {
  return {
    scope: { provider: model.provider, model: model.id, baseUrl: model.baseUrl },
    summarize: async (request) => {
      onCall(request.promptText);
      await wait.opened;
      return {
        text: SUMMARY,
        usage: {
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 150,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        toolCallCount: 0,
      };
    },
  };
}

/** What the compaction extension under test reported. */
interface RigLog {
  readonly compactEvents: CompactEvent[];
  backgroundCalls: number;
  readonly backgroundPrompts: string[];
}

/** The real compaction extension reading `settingsFile`, with an injected background summarizer. */
function compactionExtension(
  settingsFile: string,
  log: RigLog,
  summarizerGate: Gate,
  anthropicAllowList?: readonly AnthropicSupportEntry[],
): ExtensionFactory {
  const background: NonNullable<Parameters<typeof registerCompaction>[1]>["background"] = {
    settingsPaths: () => [settingsFile],
    createTextSummarizer: (active: Model<Api>) =>
      textSummarizer(
        active,
        (promptText) => {
          log.backgroundCalls += 1;
          log.backgroundPrompts.push(promptText);
        },
        summarizerGate,
      ),
    anthropic: anthropicAllowList === undefined ? undefined : { allowList: anthropicAllowList },
  };
  return (pi: ExtensionAPI) => {
    registerCompaction(pi, {
      retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 },
      compactionPolicy: () => ({ keepRecentTokens: 1, reserveTokens: 0 }),
      background,
    });
    pi.on("session_compact", (event) => {
      log.compactEvents.push({
        reason: event.reason,
        fromExtension: event.fromExtension,
        entryId: event.compactionEntry.id,
      });
    });
  };
}

async function createRig(options: RigOptions): Promise<Rig> {
  const settingsFile = join(options.dir, "background-compaction.json");
  await writeFile(settingsFile, options.sidecar);
  const log: RigLog = { compactEvents: [], backgroundCalls: 0, backgroundPrompts: [] };
  const host = await createHost({
    dir: options.dir,
    contextWindow: CONTEXT_WINDOW,
    baseUrl: options.baseUrl,
    manager: options.manager,
    persistent: options.persistent,
    compaction: options.hostCompaction,
    respond: options.respond,
    extensions: [
      ...(options.firstExtensions ?? []),
      compactionExtension(
        settingsFile,
        log,
        options.summarizerGate ?? gate(),
        options.anthropicAllowList,
      ),
      ...(options.extraExtensions ?? []),
    ],
  });
  const sessionId = host.manager.getSessionId();
  const notices: BackgroundAdoptionNotice[] = [];
  const unsubscribe = getBackgroundAdoptionSignal().subscribe((notice) => {
    if (notice.sessionId === sessionId) notices.push(notice);
  });
  return {
    session: host.session,
    manager: host.manager,
    ownerKey: mainOwnerKey(sessionId),
    calls: host.calls,
    hostSummarizerCalls: host.summarizerCalls,
    compactEvents: log.compactEvents,
    notices,
    backgroundCalls: () => log.backgroundCalls,
    backgroundPrompts: log.backgroundPrompts,
    aborts: () => host.aborts(),
    async dispose() {
      unsubscribe();
      await host.dispose();
    },
  };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function stateOf(rig: Rig): string | undefined {
  return getCoordinator(rig.ownerKey)?.status().state;
}

function ownEntries(rig: Rig): CompactionEntry[] {
  return compactionEntries(rig.manager.getBranch()).filter((entry) => {
    const details: unknown = entry.details;
    return (
      details instanceof Object &&
      "ownerKey" in details &&
      details.ownerKey === rig.ownerKey &&
      "candidateId" in details
    );
  });
}

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-background-host-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A session_start hook that records UI notices instead of showing them. */
function recordNotices(notices: string[]): ExtensionFactory {
  return (pi) => {
    // Instrument the session's UI before the compaction extension starts.
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify = (message) => {
        notices.push(message);
      };
    });
  };
}

interface SettledContext {
  ctx: ExtensionContext | undefined;
}

/** Records the context of the latest agent_settled event. */
function recordSettledContext(holder: SettledContext): ExtensionFactory {
  return (pi) => {
    pi.on("agent_settled", (_event, ctx) => {
      holder.ctx = ctx;
    });
  };
}

interface RigRef {
  current: Rig | undefined;
}

/** R0 crosses the threshold; R1 waits for the ready candidate so its boundary adopts. */
function boundaryResponder(ref: RigRef): Responder {
  return async (index) => {
    if (index === 0) return reply("R0", { tool: true, usageInput: HIGH_USAGE });
    if (index !== 1) return reply(`R${index}`, { usageInput: 20_000 });
    const current = ref.current;
    assert.ok(current);
    await waitFor(() => stateOf(current) === "ready", "ready candidate");
    return reply("R1", { tool: true, usageInput: HIGH_USAGE + 1_000 });
  };
}

interface IdleProbe {
  rig: Rig | undefined;
  entryBeforeFirstNext: boolean;
}

/** Records whether the checkpoint was committed before the next prompt's first request. */
function idleResponder(probe: IdleProbe): Responder {
  return async (index) => {
    if (index === 1 && probe.rig) probe.entryBeforeFirstNext = ownEntries(probe.rig).length === 1;
    return reply(`R${index}`, { usageInput: index === 0 ? HIGH_USAGE : 20_000 });
  };
}

const replyHigh: Responder = async (index) => reply(`R${index}`, { usageInput: HIGH_USAGE });

/** Mark a session ID as a subagent child (through the subagents manager slot) while run executes. */
async function asChildSession(childId: string, run: () => Promise<void>): Promise<void> {
  const key = Symbol.for("pi-subagents:manager");
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, {
    value: { isChildSessionId: (id: string) => id === childId },
    configurable: true,
  });
  try {
    await run();
  } finally {
    if (previous) Object.defineProperty(globalThis, key, previous);
    else Reflect.deleteProperty(globalThis, key);
  }
}

async function withRig(options: RigOptions, run: (rig: Rig) => Promise<void>): Promise<void> {
  const rig = await createRig(options);
  try {
    await run(rig);
  } finally {
    await rig.dispose();
  }
}

interface ChildBinding {
  readonly child: SessionManager;
  readonly signal: AbortSignal;
  readonly records: unknown[];
}

function childContext(rig: Rig, binding: ChildBinding): ChildCoordinatorContext {
  const { child, records } = binding;
  return {
    ownerKey: `subagent-child:${child.getSessionId()}`,
    ownerGeneration: 1,
    childSessionId: child.getSessionId(),
    parentSessionId: rig.manager.getSessionId(),
    mainSessionFork: false,
    readOnly: false,
    isolated: false,
    sessionManager: child,
    model: fakeModel(CONTEXT_WINDOW),
    appendRecord: (record) => {
      records.push(record);
    },
    appendAnchor: () => "",
    signal: binding.signal,
  };
}

test(
  "a malformed sidecar disables the feature and tells the user",
  { timeout: 20_000 },
  async () => {
    await withDir(async (dir) => {
      const notices: string[] = [];
      const rig = await createRig({
        dir,
        sidecar: "{ enabled: true",
        firstExtensions: [recordNotices(notices)],
        respond: async (index) => reply(`R${index}`, { usageInput: HIGH_USAGE }),
      });
      try {
        await rig.session.prompt("GO");
        assert.equal(getCoordinator(rig.ownerKey), undefined, "disabled: no coordinator");
        assert.equal(rig.backgroundCalls(), 0);
        assert.equal(notices.length, 1, notices.join("\n"));
        assert.ok(notices[0]?.includes("not valid JSON"));
        assert.ok(notices[0]?.includes("background compaction is disabled"));
      } finally {
        await rig.dispose();
      }
    });
  },
);

test("main session gets one coordinator; shutdown releases it", { timeout: 20_000 }, async () => {
  await withDir(async (dir) => {
    const rig = await createRig({
      dir,
      sidecar: ENABLED_SIDECAR,
      respond: async (index) => reply(`R${index}`),
    });
    try {
      const coordinator = getCoordinator(rig.ownerKey);
      assert.ok(coordinator, "coordinator registered under the main owner key");
      assert.equal(coordinator.ownerKey, rig.ownerKey);
      assert.equal(stateOf(rig), "idle");
      const provider = resolveChildCompactionProvider();
      assert.ok(provider, "child provider published");
      assert.equal(provider.isEnabled(), true);
    } finally {
      await rig.dispose();
    }
    assert.equal(getCoordinator(rig.ownerKey), undefined, "released on shutdown");
    assert.equal(resolveChildCompactionProvider(), undefined, "provider unpublished");
  });
});

test(
  "boundary adoption commits a draft mid-run with no host event and one notice",
  { timeout: 20_000 },
  async () => {
    await withDir(async (dir) => {
      const ref: RigRef = { current: undefined };
      const rig = await createRig({
        dir,
        sidecar: ENABLED_SIDECAR,
        respond: boundaryResponder(ref),
      });
      ref.current = rig;
      try {
        await rig.session.prompt("GO");
        const own = ownEntries(rig);
        assert.equal(own.length, 1, "exactly one background checkpoint");
        const entry = own[0];
        assert.ok(entry);
        assert.ok(entry.summary.includes(CHECKPOINT));
        assert.ok(
          rig.manager.getBranch().some((item) => item.id === entry.firstKeptEntryId),
          "retained entry is on the branch",
        );
        assert.equal(rig.compactEvents.length, 0, "a boundary draft emits no session_compact");
        assert.equal(rig.aborts(), 0);
        assert.equal(rig.hostSummarizerCalls.length, 0);
        assert.equal(rig.backgroundCalls(), 1);
        const last = rig.calls.at(-1);
        assert.ok(mentions(last, CHECKPOINT), "the next request carries the checkpoint");
        assert.equal(mentions(last, PREFIX_A), false, "and no longer the summarized prefix");
        assert.equal(stateOf(rig), "installed");
        assert.deepEqual(
          rig.notices.map((notice) => [notice.route, notice.committedEntryId]),
          [["boundary", entry.id]],
        );
      } finally {
        await rig.dispose();
      }
    });
  },
);

test(
  "idle route adopts before the next prompt's first request without an abort",
  { timeout: 20_000 },
  async () => {
    await withDir(async (dir) => {
      const summarizerGate = gate(false);
      const probe: IdleProbe = { rig: undefined, entryBeforeFirstNext: false };
      const rig = await createRig({
        dir,
        sidecar: ENABLED_SIDECAR,
        summarizerGate,
        respond: idleResponder(probe),
      });
      probe.rig = rig;
      try {
        await rig.session.prompt("GO");
        assert.equal(stateOf(rig), "preparing", "preparation runs in the background");
        summarizerGate.open();
        await waitFor(() => stateOf(rig) === "ready", "ready candidate");
        await rig.session.prompt("NEXT");
        assert.equal(
          probe.entryBeforeFirstNext,
          true,
          "entry committed before the first NEXT request",
        );
        const own = ownEntries(rig);
        assert.equal(own.length, 1);
        const entry = own[0];
        assert.ok(entry);
        assert.equal(rig.aborts(), 0);
        assert.equal(rig.hostSummarizerCalls.length, 0, "the host summarizer never ran");
        assert.deepEqual(rig.compactEvents, [
          { reason: "manual", fromExtension: true, entryId: entry.id },
        ]);
        const signal = getBackgroundAdoptionSignal();
        const sessionId = rig.manager.getSessionId();
        assert.equal(signal.isAdoption(sessionId, entry), true, "consumers can tell adoption");
        assert.deepEqual(
          rig.notices.map((notice) => [notice.route, notice.committedEntryId]),
          [["host", entry.id]],
        );
        const first = rig.calls.at(1);
        assert.ok(mentions(first, CHECKPOINT));
        assert.equal(mentions(first, PREFIX_A), false);
        assert.equal(stateOf(rig), "installed");
      } finally {
        await rig.dispose();
      }
    });
  },
);

test(
  "idle route fails closed when the host refuses; a later boundary still adopts",
  { timeout: 20_000 },
  async () => {
    await withDir(async (dir) => {
      const summarizerGate = gate(false);
      const rig = await createRig({
        dir,
        sidecar: ENABLED_SIDECAR,
        summarizerGate,
        // The host's own preparation finds nothing to compact under this policy.
        hostCompaction: { enabled: false, keepRecentTokens: 1_000_000, reserveTokens: 16_384 },
        respond: async (index) =>
          index === 1
            ? reply("R1", { tool: true, usageInput: HIGH_USAGE })
            : reply(`R${index}`, { usageInput: index === 0 ? HIGH_USAGE : 20_000 }),
      });
      try {
        await rig.session.prompt("GO");
        summarizerGate.open();
        await waitFor(() => stateOf(rig) === "ready", "ready candidate");
        await rig.session.prompt("NEXT");
        assert.equal(rig.aborts(), 0, "the refused trigger aborted nothing");
        assert.equal(rig.hostSummarizerCalls.length, 0);
        assert.equal(rig.compactEvents.length, 0, "no host compaction happened");
        const own = ownEntries(rig);
        assert.equal(own.length, 1, "the boundary route adopted instead");
        assert.equal(rig.notices[0]?.route, "boundary");
        assert.equal(rig.backgroundCalls(), 1, "no second paid preparation");
      } finally {
        await rig.dispose();
      }
    });
  },
);

test(
  "manual compaction with custom instructions discards the plain candidate and prepares a focused one",
  { timeout: 20_000 },
  async () => {
    await withDir(async (dir) => {
      const summarizerGate = gate(false);
      const rig = await createRig({
        dir,
        sidecar: ENABLED_SIDECAR,
        summarizerGate,
        respond: async (index) =>
          reply(`R${index}`, { usageInput: index === 0 ? HIGH_USAGE : 20_000 }),
      });
      try {
        await rig.session.prompt("GO");
        summarizerGate.open();
        await waitFor(() => stateOf(rig) === "ready", "ready candidate");
        const plain = getCoordinator(rig.ownerKey)?.status().candidateId;
        await assert.rejects(rig.session.compact("Focus on the audit"), /Compaction cancelled/);
        await waitFor(() => stateOf(rig) === "installed", "focused candidate installed");
        const status = getCoordinator(rig.ownerKey)?.status();
        assert.notEqual(status?.candidateId, plain, "the plain candidate was not adopted");
        assert.equal(status?.customInstructions, "Focus on the audit");
        assert.equal(rig.hostSummarizerCalls.length, 0, "the foreground summarizer never ran");
        assert.ok(
          rig.backgroundPrompts.some((prompt) =>
            prompt.includes("Additional focus: Focus on the audit"),
          ),
          "the text lane applied the instructions",
        );
        assert.equal(ownEntries(rig).length, 1);
      } finally {
        await rig.dispose();
      }
    });
  },
);

test(
  "a plain /compact continues in the background and is adopted once ready while idle",
  { timeout: 20_000 },
  async () => {
    await withDir(async (dir) => {
      const summarizerGate = gate(false);
      const notices: string[] = [];
      const rig = await createRig({
        dir,
        sidecar: MANUAL_ONLY_SIDECAR,
        summarizerGate,
        firstExtensions: [recordNotices(notices)],
        respond: async (index) =>
          reply(`R${index}`, { usageInput: index === 0 ? HIGH_USAGE : 20_000 }),
      });
      try {
        await rig.session.prompt("GO");
        assert.equal(stateOf(rig), "idle", "the threshold never started a preparation");
        // The host compaction returns at once instead of blocking on the summarizer.
        await assert.rejects(rig.session.compact(), /Compaction cancelled/);
        assert.equal(stateOf(rig), "preparing", "the manual request runs in the background");
        assert.equal(rig.hostSummarizerCalls.length, 0, "the foreground summarizer never ran");
        assert.equal(rig.compactEvents.length, 0, "nothing was committed yet");
        assert.ok(
          notices.some((notice) => notice.includes("continuing in the background")),
          "the user is told the compaction continues",
        );
        // A second /compact during the same preparation attaches to it.
        await assert.rejects(rig.session.compact(), /Compaction cancelled/);
        assert.equal(rig.backgroundCalls(), 1, "no second paid preparation");
        summarizerGate.open();
        await waitFor(() => stateOf(rig) === "installed", "installed candidate");
        const own = ownEntries(rig);
        assert.equal(own.length, 1, "the ready checkpoint was adopted without a prompt");
        const entry = own[0];
        assert.ok(entry);
        assert.deepEqual(rig.compactEvents, [
          { reason: "manual", fromExtension: true, entryId: entry.id },
        ]);
        assert.deepEqual(
          rig.notices.map((notice) => [notice.route, notice.committedEntryId]),
          [["host", entry.id]],
        );
        assert.equal(rig.hostSummarizerCalls.length, 0);
        await rig.session.prompt("NEXT");
        const last = rig.calls.at(-1);
        assert.ok(mentions(last, CHECKPOINT), "the next request carries the checkpoint");
        assert.equal(mentions(last, PREFIX_A), false);
      } finally {
        await rig.dispose();
      }
    });
  },
);

test(
  "a plain /compact while a threshold preparation runs waits for it instead of summarizing",
  { timeout: 20_000 },
  async () => {
    await withDir(async (dir) => {
      const summarizerGate = gate(false);
      const rig = await createRig({
        dir,
        sidecar: ENABLED_SIDECAR,
        summarizerGate,
        respond: async (index) =>
          reply(`R${index}`, { usageInput: index === 0 ? HIGH_USAGE : 20_000 }),
      });
      try {
        await rig.session.prompt("GO");
        assert.equal(stateOf(rig), "preparing", "the threshold started a preparation");
        await assert.rejects(rig.session.compact(), /Compaction cancelled/);
        assert.equal(rig.backgroundCalls(), 1, "the running preparation is reused");
        assert.equal(rig.hostSummarizerCalls.length, 0);
        summarizerGate.open();
        await waitFor(() => stateOf(rig) === "installed", "installed candidate");
        assert.equal(ownEntries(rig).length, 1);
        assert.deepEqual(
          rig.compactEvents.map((event) => [event.reason, event.fromExtension]),
          [["manual", true]],
        );
      } finally {
        await rig.dispose();
      }
    });
  },
);

test(
  "a plain /compact with the Anthropic lane selected but no capture uses the text lane",
  { timeout: 20_000 },
  async () => {
    await withDir(async (dir) => {
      const model = fakeModel(CONTEXT_WINDOW);
      const rig = await createRig({
        dir,
        sidecar: JSON.stringify({ ...JSON.parse(MANUAL_ONLY_SIDECAR), anthropicNative: true }),
        anthropicAllowList: [
          {
            provider: model.provider,
            model: model.id,
            baseUrl: model.baseUrl,
            authMode: "api-key",
          },
        ],
        respond: async (index) =>
          reply(`R${index}`, { usageInput: index === 0 ? HIGH_USAGE : 20_000 }),
      });
      try {
        await rig.session.prompt("GO");
        assert.equal(getCoordinator(rig.ownerKey)?.status().state, "idle");
        await assert.rejects(rig.session.compact(), /Compaction cancelled/);
        await waitFor(() => stateOf(rig) === "installed", "installed candidate");
        assert.equal(rig.backgroundCalls(), 1, "the text lane prepared the checkpoint");
        assert.equal(rig.hostSummarizerCalls.length, 0);
        const own = ownEntries(rig);
        assert.equal(own.length, 1);
        assert.equal(
          getCoordinator(rig.ownerKey)?.status().backendId,
          TEXT_BACKEND_ID,
          "the Anthropic lane was skipped rather than failing with incompatible",
        );
      } finally {
        await rig.dispose();
      }
    });
  },
);

test(
  "the context-cap route adopts a ready candidate through the adoption signal",
  { timeout: 20_000 },
  async () => {
    await withDir(async (dir) => {
      const summarizerGate = gate(false);
      const settled: SettledContext = { ctx: undefined };
      const rig = await createRig({
        dir,
        sidecar: ENABLED_SIDECAR,
        summarizerGate,
        extraExtensions: [recordSettledContext(settled)],
        respond: async (index) =>
          reply(`R${index}`, { usageInput: index === 0 ? HIGH_USAGE : 20_000 }),
      });
      try {
        await rig.session.prompt("GO");
        summarizerGate.open();
        await waitFor(() => stateOf(rig) === "ready", "ready candidate");
        const ctx = settled.ctx;
        assert.ok(ctx);
        const outcome = Promise.withResolvers<boolean>();
        const started = getBackgroundAdoptionSignal().adoptReady(
          rig.manager.getSessionId(),
          ctx,
          outcome.resolve,
        );
        assert.equal(started, true);
        assert.equal(await outcome.promise, true, "adopted");
        assert.equal(ownEntries(rig).length, 1);
        assert.equal(rig.hostSummarizerCalls.length, 0, "the host summarizer never ran");
        assert.equal(rig.aborts(), 0);
        assert.deepEqual(
          rig.compactEvents.map((event) => [event.reason, event.fromExtension]),
          [["manual", true]],
        );
        assert.equal(
          getBackgroundAdoptionSignal().adoptReady(rig.manager.getSessionId(), ctx, () => {}),
          false,
          "nothing left to adopt",
        );
      } finally {
        await rig.dispose();
      }
    });
  },
);

test("plain /compact with a ready candidate adopts it", { timeout: 20_000 }, async () => {
  await withDir(async (dir) => {
    const summarizerGate = gate(false);
    const rig = await createRig({
      dir,
      sidecar: ENABLED_SIDECAR,
      summarizerGate,
      respond: async (index) => reply(`R${index}`, { usageInput: index === 0 ? HIGH_USAGE : 1 }),
    });
    try {
      await rig.session.prompt("GO");
      summarizerGate.open();
      await waitFor(() => stateOf(rig) === "ready", "ready candidate");
      await rig.session.compact();
      assert.equal(ownEntries(rig).length, 1);
      assert.equal(rig.hostSummarizerCalls.length, 0);
      assert.equal(stateOf(rig), "installed");
      assert.equal(rig.notices[0]?.route, "host");
    } finally {
      await rig.dispose();
    }
  });
});

test(
  "a typed /compact bypasses the host compaction entirely while a preparation runs",
  { timeout: 20_000 },
  async () => {
    await withDir(async (dir) => {
      const summarizerGate = gate(false);
      const notices: string[] = [];
      const rig = await createRig({
        dir,
        sidecar: MANUAL_ONLY_SIDECAR,
        summarizerGate,
        firstExtensions: [recordNotices(notices)],
        respond: async (index) =>
          reply(`R${index}`, { usageInput: index === 0 ? HIGH_USAGE : 20_000 }),
      });
      try {
        await rig.session.prompt("GO");
        const hostEvents: string[] = [];
        const unsubscribe = rig.session.subscribe((event) => {
          if (event.type === "compaction_start" || event.type === "compaction_end") {
            hostEvents.push(event.type);
          }
        });
        await typeCompact(rig);
        unsubscribe();
        assert.equal(stateOf(rig), "preparing", "the typed command started a preparation");
        assert.deepEqual(hostEvents, [], "no host compaction was started, so no cancel line");
        assert.equal(rig.compactEvents.length, 0);
        assert.equal(rig.aborts(), 0, "the agent was not aborted");
        assert.equal(rig.hostSummarizerCalls.length, 0);
        assert.equal(
          notices.some((notice) => notice.includes("continuing in the background")),
          true,
        );
        summarizerGate.open();
        await waitFor(() => stateOf(rig) === "installed", "installed candidate");
        assert.equal(ownEntries(rig).length, 1);
        assert.equal(rig.notices[0]?.route, "host");
      } finally {
        await rig.dispose();
      }
    });
  },
);

test(
  "a typed /compact with instructions or a ready candidate runs Pi's own handler",
  { timeout: 20_000 },
  async () => {
    await withDir(async (dir) => {
      const summarizerGate = gate(false);
      const rig = await createRig({
        dir,
        sidecar: ENABLED_SIDECAR,
        summarizerGate,
        respond: async (index) => reply(`R${index}`, { usageInput: index === 0 ? HIGH_USAGE : 1 }),
      });
      try {
        await rig.session.prompt("GO");
        summarizerGate.open();
        await waitFor(() => stateOf(rig) === "ready", "ready candidate");
        // Ready candidate: the host compaction runs and its hook adopts the checkpoint.
        await typeCompact(rig);
        assert.equal(stateOf(rig), "installed");
        assert.equal(ownEntries(rig).length, 1);
        assert.equal(rig.hostSummarizerCalls.length, 0);
        assert.deepEqual(
          rig.compactEvents.map((event) => [event.reason, event.fromExtension]),
          [["manual", true]],
        );
        // Custom instructions: the text lane with the focus applied, no host compaction.
        await rig.session.prompt("MORE");
        await typeCompact(rig, "Focus on the audit");
        await waitFor(() => stateOf(rig) === "installed", "focused candidate installed");
        assert.equal(rig.hostSummarizerCalls.length, 0);
        assert.equal(ownEntries(rig).length, 2);
        assert.ok(
          rig.backgroundPrompts.some((prompt) =>
            prompt.includes("Additional focus: Focus on the audit"),
          ),
        );
      } finally {
        await rig.dispose();
      }
    });
  },
);

test(
  "reload binds the persisted ready candidate without a paid prepare",
  { timeout: 20_000 },
  async () => {
    await withDir(async (dir) => {
      const summarizerGate = gate(false);
      const first = await createRig({
        dir,
        persistent: true,
        sidecar: ENABLED_SIDECAR,
        summarizerGate,
        respond: async (index) =>
          reply(`R${index}`, { usageInput: index === 0 ? HIGH_USAGE : 20_000 }),
      });
      let file: string | undefined;
      let candidateId: string | undefined;
      try {
        await first.session.prompt("GO");
        summarizerGate.open();
        await waitFor(() => stateOf(first) === "ready", "ready candidate");
        candidateId = getCoordinator(first.ownerKey)?.status().candidateId;
        file = first.manager.getSessionFile();
        assert.equal(first.backgroundCalls(), 1);
      } finally {
        await first.dispose();
      }
      assert.ok(file);
      assert.ok(candidateId);
      const reopened = SessionManager.open(file, dir, dir);
      const second = await createRig({
        dir,
        manager: reopened,
        sidecar: ENABLED_SIDECAR,
        respond: async (index) => reply(`S${index}`, { usageInput: 20_000 }),
      });
      try {
        await waitFor(() => stateOf(second) === "ready", "recovered candidate");
        const status = getCoordinator(second.ownerKey)?.status();
        assert.equal(status?.candidateId, candidateId);
        assert.equal(status?.reason, "recovered");
        assert.equal(second.backgroundCalls(), 0, "recovery never prepares again");
        await second.session.prompt("AFTER-RELOAD");
        assert.equal(ownEntries(second).length, 1, "the recovered candidate was adopted");
        assert.equal(second.backgroundCalls(), 0);
        assert.equal(second.aborts(), 0);
      } finally {
        await second.dispose();
      }
    });
  },
);

test(
  "reload under a different provider scope discards the persisted candidate",
  { timeout: 20_000 },
  async () => {
    await withDir(async (dir) => {
      const summarizerGate = gate(false);
      const first = await createRig({
        dir,
        persistent: true,
        sidecar: ENABLED_SIDECAR,
        summarizerGate,
        respond: async (index) =>
          reply(`R${index}`, { usageInput: index === 0 ? HIGH_USAGE : 20_000 }),
      });
      let file: string | undefined;
      try {
        await first.session.prompt("GO");
        summarizerGate.open();
        await waitFor(() => stateOf(first) === "ready", "ready candidate");
        file = first.manager.getSessionFile();
      } finally {
        await first.dispose();
      }
      assert.ok(file);
      // The same session reopened against another endpoint of the provider.
      const second = await createRig({
        dir,
        manager: SessionManager.open(file, dir, dir),
        sidecar: ENABLED_SIDECAR,
        baseUrl: "https://elsewhere.invalid",
        respond: async (index) => reply(`S${index}`, { usageInput: 20_000 }),
      });
      try {
        await waitFor(() => stateOf(second) === "discarded-stale", "discarded candidate");
        assert.equal(getCoordinator(second.ownerKey)?.status().reason, "incompatible");
        await second.session.prompt("AFTER-RELOAD");
        assert.equal(ownEntries(second).length, 0, "nothing incompatible was adopted");
        assert.equal(second.backgroundCalls(), 0, "no paid preparation on reload");
      } finally {
        await second.dispose();
      }
    });
  },
);

test(
  "the extension is inert in a child session; the runner bridge owns attachment",
  { timeout: 20_000 },
  async () => {
    await withDir(async (dir) => {
      const manager = SessionManager.inMemory(dir);
      manager.appendMessage({ role: "user", content: PREFIX_A, timestamp: Date.now() });
      await asChildSession(manager.getSessionId(), () =>
        withRig({ dir, manager, sidecar: ENABLED_SIDECAR, respond: replyHigh }, async (rig) => {
          await rig.session.prompt("GO");
          assert.equal(getCoordinator(rig.ownerKey), undefined, "no main coordinator in a child");
          assert.equal(resolveChildCompactionProvider(), undefined, "a child publishes nothing");
          assert.equal(rig.backgroundCalls(), 0);
        }),
      );
    });
  },
);

test(
  "the published child provider builds a child coordinator under the child's owner",
  { timeout: 20_000 },
  async () => {
    await withDir(async (dir) => {
      const rig = await createRig({
        dir,
        sidecar: ENABLED_SIDECAR,
        respond: async (index) => reply(`R${index}`),
      });
      try {
        const provider = resolveChildCompactionProvider();
        assert.ok(provider);
        const child = SessionManager.inMemory(dir);
        const controller = new AbortController();
        const attachment = await provider.createChildCoordinator(
          childContext(rig, { child, signal: controller.signal, records: [] }),
        );
        assert.ok(attachment);
        assert.equal(attachment.coordinator.ownerKey, `subagent-child:${child.getSessionId()}`);
        assert.equal(attachment.coordinator.ownerGeneration, 1);
        assert.equal(getCoordinator(rig.ownerKey)?.ownerKey, rig.ownerKey, "main unaffected");
        controller.abort();
        assert.equal(
          (await attachment.coordinator.requestPreparation()).accepted,
          false,
          "a detached child coordinator refuses work",
        );
      } finally {
        await rig.dispose();
      }
    });
  },
);
