/**
 * With background compaction off (the shipped default, a malformed sidecar,
 * or the master switch off) the extension behaves exactly like the summarizer
 * alone: same provider requests, same entries, no coordinator. The adoption
 * signal slot exists from registration (so consumers loaded earlier can bind
 * at their session_start) but stays inert: no owner answers and no notice is
 * published.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Message, TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { resolveChildCompactionProvider } from "../../choco-pi-subagents/src/child-compaction-bridge.ts";
import { getCoordinator } from "../src/background/registry.ts";
import registerCompaction, {
  type BackgroundAdoptionNotice,
  type CompactionSessionState,
  createBeforeCompactHandler,
  getBackgroundAdoptionSignal,
  mainOwnerKey,
} from "../src/index.ts";
import { createHost, reply } from "./host-boundary-fixture.ts";

const RETRY = { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 };

/** The extension as it was before background compaction: summarizer only. */
function summarizerOnly(pi: ExtensionAPI): void {
  let state: CompactionSessionState = {
    generation: 0,
    retryPolicy: RETRY,
    codexCompaction: undefined,
  };
  pi.on("session_start", () => {
    state = { ...state, generation: state.generation + 1 };
  });
  pi.on("session_shutdown", () => {
    state = { ...state, generation: state.generation + 1 };
  });
  pi.on(
    "session_before_compact",
    createBeforeCompactHandler(() => state),
  );
}

/** Model-visible request content, without per-run timestamps or temp paths. */
interface RequestPart {
  readonly role: string;
  readonly parts: readonly string[];
}

function partsOf(message: Message): string[] {
  if (!Array.isArray(message.content)) return [message.content];
  return message.content.map((part) => {
    if (part.type === "text") return `text:${part.text}`;
    if (part.type === "toolCall") return `call:${part.id}:${part.name}`;
    if (part.type === "thinking") return `thinking:${part.thinking}`;
    return part.type;
  });
}

function project(context: TranscriptContext): RequestPart[] {
  return context.messages.map((message) => ({
    role: message.role,
    // System prompts embed the temporary cwd; their identity is the role and text.
    parts: message.role === "system" ? [] : partsOf(message),
  }));
}

interface Trace {
  readonly requests: RequestPart[][];
  readonly entries: string[];
  readonly sessionKey: string;
}

async function run(extension: ExtensionFactory): Promise<Trace> {
  const host = await createHost({
    extensions: [extension],
    contextWindow: 100_000,
    respond: async (index) =>
      index < 2
        ? reply(`R${index}`, { tool: true, usageInput: 90_000 })
        : reply(`R${index}`, { usageInput: 90_000 }),
  });
  try {
    await host.session.prompt("GO");
    await host.session.prompt("NEXT");
    await host.session.compact();
    await host.session.prompt("AFTER");
    const requests = host.calls.map(project);
    const entries = host.manager.getBranch().map((entry) => {
      if (entry.type === "compaction") return `compaction:${entry.summary}`;
      if (entry.type === "custom") return `custom:${entry.customType}`;
      return entry.type;
    });
    return { requests, entries, sessionKey: mainOwnerKey(host.manager.getSessionId()) };
  } finally {
    await host.dispose();
  }
}

/** What the background side exposed while one feature-off variant ran. */
interface OffObservation {
  coordinatorSeen: boolean;
  adoptionClaimed: boolean;
  providerEnabled: boolean | undefined;
}

/** The full extension with the given sidecar paths, instrumented to record any background activity. */
function observedExtension(paths: readonly string[], observed: OffObservation): ExtensionFactory {
  const background = { settingsPaths: () => paths };
  return (pi) => {
    registerCompaction(pi, {
      retryPolicy: RETRY,
      compactionPolicy: () => ({ keepRecentTokens: 1, reserveTokens: 0 }),
      background,
    });
    pi.on("agent_settled", (_event, ctx) => {
      observed.coordinatorSeen ||=
        getCoordinator(mainOwnerKey(ctx.sessionManager.getSessionId())) !== undefined;
      observed.providerEnabled = resolveChildCompactionProvider()?.isEnabled();
    });
    pi.on("session_before_compact", async (event, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      observed.adoptionClaimed ||= await getBackgroundAdoptionSignal().willAdopt(sessionId, event);
    });
  };
}

test(
  "feature off is indistinguishable from the summarizer alone",
  { timeout: 30_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "choco-pi-background-off-"));
    try {
      const malformed = join(dir, "malformed.json");
      const switchedOff = join(dir, "off.json");
      await writeFile(malformed, "{ not json");
      await writeFile(switchedOff, JSON.stringify({ enabled: false, text: true }));
      const baseline = await run(summarizerOnly);
      const notices: BackgroundAdoptionNotice[] = [];
      const unsubscribe = getBackgroundAdoptionSignal().subscribe((notice) => notices.push(notice));
      const variants = [
        { name: "missing", paths: [join(dir, "absent.json")] },
        { name: "malformed", paths: [malformed] },
        { name: "master switch off", paths: [switchedOff] },
      ];
      for (const { name, paths } of variants) {
        const observed: OffObservation = {
          coordinatorSeen: false,
          adoptionClaimed: false,
          providerEnabled: undefined,
        };
        const trace = await run(observedExtension(paths, observed));
        assert.deepEqual(trace.requests, baseline.requests, `${name}: identical provider requests`);
        assert.deepEqual(trace.entries, baseline.entries, `${name}: identical session entries`);
        assert.equal(observed.coordinatorSeen, false, `${name}: no coordinator`);
        assert.equal(observed.adoptionClaimed, false, `${name}: no adoption owner answers`);
        assert.equal(
          observed.providerEnabled,
          false,
          `${name}: children stay on the existing path`,
        );
      }
      unsubscribe();
      assert.ok(
        baseline.entries.some((entry) => entry.startsWith("compaction:")),
        "the manual compaction itself still ran",
      );
      assert.deepEqual(notices, [], "no adoption notice is published while the feature is off");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
