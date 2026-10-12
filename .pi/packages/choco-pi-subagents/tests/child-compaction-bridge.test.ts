/**
 * Child background-compaction attachment through the REAL runner.
 *
 * Every test drives `runAgent()` / `resumeAgent()` against the installed Pi
 * SDK with a scripted provider registered through `ModelRuntime`; no request
 * leaves the process. `PI_CODING_AGENT_DIR` points at a temporary agent
 * directory holding two probe extensions (alpha, beta), so the real
 * `~/.pi/agent` is never read. The runner's own `createResourceLoader` seam
 * is used only to observe the loader (and, for the nested case, to capture a
 * child context); the bridge itself is appended by the runner.
 *
 * The coordinator is a fake built against the frozen `CoordinatorApi`; the
 * registry is the real frozen `registry.ts`.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, afterEach, before } from "node:test";

import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type CompactionEntry,
  type CompactionEntryDraft,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  ModelRuntime,
  type SessionEntry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import type {
  ArbitrationResult,
  CandidateState,
  CoordinatorApi,
  ReasonCode,
} from "../../choco-pi-compaction/src/background/contract.ts";
import {
  getCoordinator,
  getRegistry,
  release,
  setCoordinator,
} from "../../choco-pi-compaction/src/background/registry.ts";
import { registerAgents } from "../src/agent-types.ts";
import {
  captureMainSessionFork,
  getGraceTurns,
  resumeAgent,
  runAgent,
  type RunOptions,
  setGraceTurns,
} from "../src/agent-runner.ts";
import {
  CHILD_COMPACTION_EXTENSION_NAME,
  CHILD_OWNER_KEY_PREFIX,
  type ChildCoordinatorAttachment,
  type ChildCoordinatorContext,
  type ChildCompactionProvider,
  publishChildCompactionProvider,
} from "../src/child-compaction-bridge.ts";
import { isChildSessionId, unregisterChildSessionId } from "../src/child-context.ts";
import { emitChildSessionShutdown } from "../src/child-session-cleanup.ts";
import type { AgentConfig } from "../src/types.ts";
import registerCompaction from "../../choco-pi-compaction/src/index.ts";
import chocoPiHooks from "../../choco-pi-hooks/src/extension.ts";

// ---------------------------------------------------------------------------
// Host fixture (real SDK, scripted provider, temporary directories)
// ---------------------------------------------------------------------------

const PROVIDER = "child-fake";
const SUMMARIZER_MARKER = "context summarization assistant";
const INLINE_PATH = `<inline:${CHILD_COMPACTION_EXTENSION_NAME}>`;
const PROBE_KEY = Symbol.for("choco-pi:child-compaction-probe");

function fakeModel(contextWindow: number): Model<"anthropic-messages"> {
  return {
    id: "child-fake-model",
    name: "Child fake model",
    api: "anthropic-messages",
    provider: PROVIDER,
    baseUrl: "https://child-fake.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 1_000,
  };
}

interface ReplyOptions {
  readonly toolCall?: boolean;
  readonly usageInput?: number;
}

function reply(text: string, options: ReplyOptions = {}): AssistantMessage {
  return {
    role: "assistant",
    content: options.toolCall
      ? [
          { type: "text", text },
          {
            type: "toolCall",
            id: `call-${text}`,
            name: "read",
            arguments: { path: "missing-file.txt" },
          },
        ]
      : [{ type: "text", text }],
    api: "anthropic-messages",
    provider: PROVIDER,
    model: "child-fake-model",
    usage: {
      input: options.usageInput ?? 10,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: (options.usageInput ?? 10) + 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: options.toolCall ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

type Responder = (context: TranscriptContext) => Promise<AssistantMessage>;

/** Scripted stream: summarizer requests answer at once, others defer to the responder. */
function scriptedStream(input: {
  readonly context: TranscriptContext;
  readonly signal: AbortSignal | undefined;
  readonly responder: Responder;
  readonly onSummarizerCall: () => void;
}): AssistantMessageEventStream {
  const { context, signal } = input;
  const stream = createAssistantMessageEventStream();
  if (getCurrentSystemPrompt(context.messages).includes(SUMMARIZER_MARKER)) {
    input.onSummarizerCall();
    queueMicrotask(() => {
      stream.push({ type: "done", reason: "stop", message: reply("HOST-SUMMARY") });
    });
    return stream;
  }
  let settled = false;
  const onAbort = (): void => {
    if (settled) return;
    settled = true;
    const aborted: AssistantMessage = { ...reply(""), content: [], stopReason: "aborted" };
    aborted.errorMessage = "Request was aborted";
    stream.push({ type: "error", reason: "aborted", error: aborted });
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  void input.responder(structuredClone(context)).then((message) => {
    signal?.removeEventListener("abort", onAbort);
    if (settled) return;
    settled = true;
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
  });
  return stream;
}

interface Host {
  readonly session: AgentSession;
  readonly manager: SessionManager;
  readonly pi: ExtensionAPI;
  ctx(): ExtensionContext;
  summarizerCalls(): number;
  setResponder(responder: Responder): void;
  dispose(): Promise<void>;
}

async function createHost(options: {
  readonly dir: string;
  readonly persistent: boolean;
  readonly contextWindow: number;
  readonly extensions?: readonly ExtensionFactory[];
}): Promise<Host> {
  let responder: Responder = async () => reply("DEFAULT");
  let summarizerCalls = 0;
  const countSummarizerCall = (): void => {
    summarizerCalls++;
  };
  const model = fakeModel(options.contextWindow);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
    modelsPath: null,
  });
  runtime.registerProvider(PROVIDER, {
    api: model.api,
    apiKey: "non-secret-placeholder",
    models: [model],
    streamSimple: (
      _model: Model<string>,
      context: TranscriptContext,
      streamOptions?: SimpleStreamOptions,
    ): AssistantMessageEventStream =>
      scriptedStream({
        context,
        signal: streamOptions?.signal,
        responder,
        onSummarizerCall: countSummarizerCall,
      }),
  });
  let pi: ExtensionAPI | undefined;
  let ctx: ExtensionContext | undefined;
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 16_384 },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: options.dir,
    agentDir: options.dir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (api) => {
        pi = api;
        api.on("session_start", (_event, context) => {
          ctx = context;
        });
        api.on("agent_settled", (_event, context) => {
          ctx = context;
        });
      },
      ...(options.extensions ?? []),
    ],
  });
  await loader.reload();
  const manager = options.persistent
    ? SessionManager.create(options.dir, options.dir)
    : SessionManager.inMemory(options.dir);
  const { session } = await createAgentSession({
    cwd: options.dir,
    agentDir: options.dir,
    model,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: manager,
    settingsManager: settings,
    noTools: "builtin",
  });
  await session.bindExtensions({});
  const boundPi = pi;
  assert.ok(boundPi && ctx, "host extension context captured");
  return {
    session,
    manager,
    pi: boundPi,
    ctx() {
      assert.ok(ctx);
      return ctx;
    },
    summarizerCalls: () => summarizerCalls,
    setResponder(next) {
      responder = next;
    },
    async dispose() {
      session.dispose();
    },
  };
}

function probeLog(): string[] {
  const registry: typeof globalThis & { [PROBE_KEY]?: string[] } = globalThis;
  registry[PROBE_KEY] ??= [];
  return registry[PROBE_KEY];
}

function probeExtensionSource(name: string): string {
  return [
    `const key = Symbol.for("choco-pi:child-compaction-probe");`,
    `export default function (pi) {`,
    `  (globalThis[key] ??= []).push("${name}:load");`,
    `  pi.on("session_start", () => { globalThis[key].push("${name}:bind"); });`,
    `}`,
    ``,
  ].join("\n");
}

function compactions(entries: readonly SessionEntry[]): CompactionEntry[] {
  return entries.filter((entry): entry is CompactionEntry => entry.type === "compaction");
}

/** Whether `entry` is the user message whose text contains `needle`. */
function isUserPromptWith(entry: SessionEntry, needle: string): boolean {
  if (entry.type !== "message" || entry.message.role !== "user") return false;
  const content = entry.message.content;
  const text = Array.isArray(content)
    ? content.map((part) => (part.type === "text" ? part.text : "")).join("")
    : content;
  return text.includes(needle);
}

function childKeys(): string[] {
  return [...getRegistry().coordinators.keys()].filter((key) =>
    key.startsWith(CHILD_OWNER_KEY_PREFIX),
  );
}

// ---------------------------------------------------------------------------
// Fake child coordinator against the frozen CoordinatorApi
// ---------------------------------------------------------------------------

interface FakeChild {
  readonly context: ChildCoordinatorContext;
  readonly coordinator: CoordinatorApi;
  readonly calls: string[];
  readonly cancels: (ReasonCode | undefined)[];
  readonly boundaries: string[];
  readonly acks: CompactionEntry[];
  readonly disposals: () => number;
  readonly state: () => CandidateState;
  makeReady(candidateId: string, firstKeptEntryId?: string): void;
  markInstalled(): void;
}

interface FakeProviderOptions {
  readonly enabled?: boolean;
  /** Ready candidate at creation; the retained entry defaults to the first user message. */
  readonly readyAtCreation?: { readonly candidateId: string; readonly firstKeptEntryId?: string };
  /** Hold creation until this promise settles (stale-after-await tests). */
  readonly creationGate?: Promise<void>;
  /** Report "preparing" from status() so only host-routed arbitration can adopt. */
  readonly hideReadyFromStatus?: boolean;
}

const CHECKPOINT_SUMMARY = "CHILD-CHECKPOINT";

function createFakeChild(context: ChildCoordinatorContext, hideReady = false): FakeChild {
  const calls: string[] = [];
  const cancels: (ReasonCode | undefined)[] = [];
  const boundaries: string[] = [];
  const acks: CompactionEntry[] = [];
  let disposals = 0;
  let state: CandidateState = "idle";
  let candidate: { readonly id: string; readonly firstKeptEntryId: string | undefined } | undefined;

  const retainedId = (): string | null => {
    if (candidate?.firstKeptEntryId) return candidate.firstKeptEntryId;
    const first = context.sessionManager
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "user");
    return first?.id ?? null;
  };

  const adopt = (): ArbitrationResult => {
    if (state !== "ready" || !candidate) return { action: "proceed" };
    state = "adopting";
    const draft: CompactionEntryDraft = {
      type: "compaction",
      summary: CHECKPOINT_SUMMARY,
      firstKeptEntryId: retainedId(),
      details: {
        strategy: "local-reconciled",
        candidateId: candidate.id,
        prefixFingerprint: `fp-${candidate.id}`,
        ownerKey: context.ownerKey,
      },
    };
    return { action: "adopt", candidateId: candidate.id, draft };
  };

  const coordinator: CoordinatorApi = {
    ownerKey: context.ownerKey,
    ownerGeneration: context.ownerGeneration,
    requestPreparation: async () => {
      calls.push("requestPreparation");
      return { accepted: false, reason: "busy" };
    },
    cancel: (reason) => {
      calls.push("cancel");
      cancels.push(reason);
      if (state === "queued" || state === "preparing" || state === "ready") state = "canceled";
    },
    status: () => ({
      ownerKey: context.ownerKey,
      ownerGeneration: context.ownerGeneration,
      state: hideReady && state === "ready" ? "preparing" : state,
    }),
    arbitrateHostCompaction: async () => {
      calls.push("arbitrateHostCompaction");
      return adopt();
    },
    arbitrateManualCompact: async () => {
      calls.push("arbitrateManualCompact");
      return adopt();
    },
    registerConsumer: () => () => {},
    registerParticipant: () => () => {},
    dispose: () => {
      calls.push("dispose");
      disposals++;
    },
  };

  return {
    context,
    coordinator,
    calls,
    cancels,
    boundaries,
    acks,
    disposals: () => disposals,
    state: () => state,
    makeReady(candidateId, firstKeptEntryId) {
      candidate = { id: candidateId, firstKeptEntryId };
      state = "ready";
    },
    markInstalled() {
      state = "installed";
    },
  };
}

/** The runner-facing attachment for one fake child: records boundaries and commits. */
function fakeAttachment(child: FakeChild): ChildCoordinatorAttachment {
  return {
    coordinator: child.coordinator,
    observeBoundary: (boundary) => {
      child.boundaries.push(boundary.kind);
    },
    acknowledgeCommit: (entry) => {
      child.acks.push(entry);
      if (child.state() === "adopting") child.markInstalled();
    },
  };
}

function fakeProvider(options: FakeProviderOptions = {}) {
  const children: FakeChild[] = [];
  let attempts = 0;
  const provider: ChildCompactionProvider = {
    version: 1,
    isEnabled: () => options.enabled ?? true,
    createChildCoordinator: async (context) => {
      attempts++;
      const child = createFakeChild(context, options.hideReadyFromStatus === true);
      children.push(child);
      if (options.creationGate) await options.creationGate;
      if (options.readyAtCreation) {
        child.makeReady(
          options.readyAtCreation.candidateId,
          options.readyAtCreation.firstKeptEntryId,
        );
      }
      return fakeAttachment(child);
    },
  };
  return { provider, children, attempts: () => attempts };
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

type Mode = "isolated" | "readOnly" | "denylist";

function agentConfig(name: string, mode?: Mode): AgentConfig {
  const base: AgentConfig = {
    name,
    description: "child compaction probe",
    builtinToolNames: ["read"],
    extensions: true,
    skills: false,
    systemPrompt: "child compaction probe",
    promptMode: "replace",
    persistSession: false,
  };
  if (mode === "denylist") return { ...base, excludeExtensions: ["beta"] };
  return base;
}

let rootDir = "";
let agentDir = "";
let previousAgentDir: string | undefined;
let host: Host | undefined;
let unpublish: (() => void) | undefined;
const liveChildren: AgentSession[] = [];

before(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "choco-pi-child-compaction-"));
  agentDir = join(rootDir, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "alpha.ts"), probeExtensionSource("alpha"));
  await writeFile(join(agentDir, "extensions", "beta.ts"), probeExtensionSource("beta"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const hostDir = join(rootDir, "host");
  await mkdir(hostDir, { recursive: true });
  host = await createHost({ dir: hostDir, persistent: true, contextWindow: 200_000 });
});

afterEach(async () => {
  unpublish?.();
  unpublish = undefined;
  for (const session of liveChildren.splice(0)) await disposeChild(session);
  host?.setResponder(async () => reply("DEFAULT"));
});

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await host?.dispose();
  await rm(rootDir, { recursive: true, force: true });
});

/** Mirror AgentManager.removeRecord: session_shutdown, then dispose. */
async function disposeChild(session: AgentSession): Promise<void> {
  const index = liveChildren.indexOf(session);
  if (index >= 0) liveChildren.splice(index, 1);
  unregisterChildSessionId(session.sessionManager.getSessionId());
  await emitChildSessionShutdown(session);
  session.dispose();
}

function requireHost(): Host {
  assert.ok(host);
  return host;
}

interface ChildRun {
  readonly session: AgentSession;
  readonly responseText: string;
  readonly aborted: boolean;
  readonly loadedPaths: string[];
  readonly activeTools: string[];
  readonly allTools: string[];
  readonly probeEvents: string[];
  readonly compactionCallbacks: { reason: string; tokensBefore: number }[];
  readonly activity: string[];
}

async function runChild(
  config: AgentConfig,
  options: {
    readonly prompt?: string;
    readonly run?: Partial<RunOptions>;
    /** Loaded before the runner's inline factories, like path-loaded packages in production. */
    readonly packageFactories?: readonly ExtensionFactory[];
  } = {},
): Promise<ChildRun> {
  const current = requireHost();
  registerAgents(new Map([[config.name, config]]));
  let loader: DefaultResourceLoader | undefined;
  const probe = probeLog();
  const probeStart = probe.length;
  const compactionCallbacks: { reason: string; tokensBefore: number }[] = [];
  const activity: string[] = [];
  const runOptions: RunOptions = {
    pi: current.pi,
    onCompaction: (info) => compactionCallbacks.push({ ...info }),
    onToolActivity: (event) => activity.push(event.toolName),
    ...options.run,
    createResourceLoader: (loaderOptions) => {
      loader = new DefaultResourceLoader({
        ...loaderOptions,
        extensionFactories: [
          ...(options.packageFactories ?? []),
          ...(loaderOptions.extensionFactories ?? []),
        ],
      });
      return loader;
    },
  };
  const result = await runAgent(
    current.ctx(),
    config.name,
    options.prompt ?? "child prompt",
    runOptions,
  );
  liveChildren.push(result.session);
  assert.ok(loader, "runAgent reached the loader seam");
  return {
    session: result.session,
    responseText: result.responseText,
    aborted: result.aborted,
    loadedPaths: loader.getExtensions().extensions.map((extension) => extension.path),
    activeTools: result.session.getActiveToolNames().toSorted(),
    allTools: result.session
      .getAllTools()
      .map((tool) => tool.name)
      .toSorted(),
    probeEvents: probe.slice(probeStart),
    compactionCallbacks,
    activity,
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Feature switch
// ---------------------------------------------------------------------------

test("feature off: a disabled provider is never asked for a coordinator", async () => {
  const fake = fakeProvider({ enabled: false });
  unpublish = publishChildCompactionProvider(fake.provider);
  const run = await runChild(agentConfig("disabled"));
  assert.ok(!run.loadedPaths.includes(INLINE_PATH));
  assert.equal(fake.attempts(), 0);
  assert.deepEqual(childKeys(), []);
});

test("a corrupt provider slot is ignored rather than trusted", async () => {
  Object.defineProperty(globalThis, Symbol.for("choco-pi:compaction-child-provider"), {
    value: { version: 2, isEnabled: () => true, createChildCoordinator: () => undefined },
    configurable: true,
  });
  unpublish = () => {
    Reflect.deleteProperty(globalThis, Symbol.for("choco-pi:compaction-child-provider"));
  };
  const run = await runChild(agentConfig("corrupt"));
  assert.ok(!run.loadedPaths.includes(INLINE_PATH));
  assert.deepEqual(childKeys(), []);
});

// ---------------------------------------------------------------------------
// Binding under restricted modes: no-extension loaders (isolated, readOnly)
// and a filtered loader (denylist)
// ---------------------------------------------------------------------------

const MODES: readonly Mode[] = ["isolated", "readOnly", "denylist"];

for (const mode of MODES) {
  test(`${mode}: hidden attachment binds, tools unchanged, denied extension never binds`, async () => {
    const parentSessionId = requireHost().manager.getSessionId();
    const flags = { isolated: mode === "isolated", readOnly: mode === "readOnly" };
    const baseline = await runChild(agentConfig(`${mode}-base`, mode), { run: flags });
    await disposeChild(baseline.session);

    const fake = fakeProvider();
    unpublish = publishChildCompactionProvider(fake.provider);
    const run = await runChild(agentConfig(mode, mode), { run: flags });
    const childId = run.session.sessionManager.getSessionId();

    assert.ok(run.loadedPaths.includes(INLINE_PATH), "bridge loaded as an inline extension");
    assert.deepEqual(run.activeTools, baseline.activeTools, "no active tool added");
    assert.deepEqual(run.allTools, baseline.allTools, "no tool registered");
    assert.ok(!run.probeEvents.includes("beta:bind"), "denied extension never binds");
    assert.equal(
      run.probeEvents.includes("alpha:bind"),
      mode === "denylist",
      "the bridge does not widen the extension filter",
    );

    assert.equal(fake.children.length, 1);
    const child = fake.children[0];
    assert.ok(child);
    assert.equal(child.context.ownerKey, `${CHILD_OWNER_KEY_PREFIX}${childId}`);
    assert.equal(child.context.childSessionId, childId);
    assert.equal(child.context.parentSessionId, parentSessionId);
    assert.equal(child.context.isolated, flags.isolated);
    assert.equal(child.context.readOnly, flags.readOnly);
    assert.equal(child.context.mainSessionFork, false);
    assert.ok(child.boundaries.includes("turn_end"), "turn_end forwarded");
    assert.ok(child.boundaries.includes("agent_before_settle"), "agent_before_settle forwarded");
    assert.ok(
      !child.calls.includes("arbitrateHostCompaction"),
      "a candidate that is not ready is never arbitrated at a boundary",
    );

    // Settled, not disposed: still registered, preparation canceled.
    assert.equal(getCoordinator(child.context.ownerKey), child.coordinator);
    assert.deepEqual(child.cancels, ["canceled"]);
    assert.equal(child.disposals(), 0);
    assert.equal(child.context.signal.aborted, false);

    await disposeChild(run.session);
    assert.equal(getCoordinator(child.context.ownerKey), undefined, "released on disposal");
    assert.equal(child.disposals(), 1);
    assert.equal(child.context.signal.aborted, true);
    assert.deepEqual(childKeys(), []);
  });
}

// ---------------------------------------------------------------------------
// Child anchor seam: appends only through a current attachment
// ---------------------------------------------------------------------------

test("appendAnchor appends a child anchor while attached and nothing after detachment", async () => {
  const fake = fakeProvider();
  unpublish = publishChildCompactionProvider(fake.provider);
  const run = await runChild(agentConfig("anchor"));
  const child = fake.children[0];
  assert.ok(child);
  const manager = run.session.sessionManager;

  const anchorId = child.context.appendAnchor();
  assert.notEqual(anchorId, "", "a live attachment returns the anchor's entry ID");
  const anchor = manager.getEntry(anchorId);
  assert.equal(anchor?.type, "custom");
  assert.equal(
    anchor?.type === "custom" ? anchor.customType : undefined,
    "choco-compaction-anchor",
  );
  assert.equal(manager.getLeafId(), anchorId, "the anchor is the child's new leaf");

  await disposeChild(run.session);
  const entriesAfterDetach = manager.getEntries().length;
  assert.equal(child.context.appendAnchor(), "", "a detached attachment returns no ID");
  assert.equal(manager.getEntries().length, entriesAfterDetach, "nothing appended");
});

// ---------------------------------------------------------------------------
// mainSessionFork adoption never touches the parent
// ---------------------------------------------------------------------------

test("mainSessionFork child adoption leaves parent entries, leaf, projection and file unchanged", async () => {
  const current = requireHost();
  current.setResponder(async () => reply("PARENT-REPLY"));
  await current.session.prompt("PARENT-GO");
  const parentFile = current.manager.getSessionFile();
  assert.ok(parentFile);
  const kept = current.manager.getBranch().find((entry) => isUserPromptWith(entry, "PARENT-GO"));
  assert.ok(kept);
  const before = {
    entries: structuredClone(current.manager.getEntries()),
    leaf: current.manager.getLeafId(),
    context: structuredClone(current.manager.buildSessionContext().messages),
    file: await readFile(parentFile, "utf8"),
  };

  const fake = fakeProvider({
    readyAtCreation: { candidateId: "fork-candidate", firstKeptEntryId: kept.id },
  });
  unpublish = publishChildCompactionProvider(fake.provider);
  current.setResponder(async () => reply("BTW-ANSWER"));
  const fork = captureMainSessionFork(current.ctx());
  const run = await runChild(agentConfig("btw"), {
    prompt: "side question",
    run: { readOnly: true, mainSessionFork: fork },
  });
  const child = fake.children[0];
  assert.ok(child);
  assert.equal(run.session.sessionManager, fork.sessionManager);
  assert.notEqual(child.context.childSessionId, current.manager.getSessionId());
  assert.equal(child.context.mainSessionFork, true);
  assert.equal(child.context.ownerKey, `${CHILD_OWNER_KEY_PREFIX}${child.context.childSessionId}`);

  const committed = compactions(run.session.sessionManager.getBranch()).filter(
    (entry) => entry.summary === CHECKPOINT_SUMMARY,
  );
  assert.equal(committed.length, 1, "child committed exactly one checkpoint");
  assert.equal(committed[0]?.firstKeptEntryId, kept.id);
  assert.equal(child.acks.length, 1, "commit acknowledged once through entry_appended");
  assert.equal(run.compactionCallbacks.length, 1, "boundary adoption reported exactly once");
  assert.equal(run.compactionCallbacks[0]?.reason, "threshold");
  assert.equal(run.responseText, "BTW-ANSWER");

  assert.deepEqual(current.manager.getEntries(), before.entries, "parent entries unchanged");
  assert.equal(current.manager.getLeafId(), before.leaf, "parent leaf unchanged");
  assert.deepEqual(
    current.manager.buildSessionContext().messages,
    before.context,
    "parent projection unchanged",
  );
  assert.equal(await readFile(parentFile, "utf8"), before.file, "parent file bytes unchanged");
  assert.equal(compactions(current.manager.getEntries()).length, 0);
  assert.equal(run.session.sessionManager.isPersisted(), false);
});

test("a proposal whose retained entry is not on the child branch is never committed", async () => {
  const fake = fakeProvider({
    readyAtCreation: { candidateId: "off-branch", firstKeptEntryId: "not-an-entry-id" },
  });
  unpublish = publishChildCompactionProvider(fake.provider);
  const run = await runChild(agentConfig("off-branch"));
  const child = fake.children[0];
  assert.ok(child);
  assert.ok(child.calls.includes("arbitrateHostCompaction"), "the proposal was made");
  assert.equal(compactions(run.session.sessionManager.getBranch()).length, 0);
  assert.deepEqual(run.compactionCallbacks, []);
  assert.equal(child.acks.length, 0);
});

// ---------------------------------------------------------------------------
// Resume path gets the same adoption notification
// ---------------------------------------------------------------------------

test("resumeAgent forwards a boundary adoption to its own onCompaction once", async () => {
  const fake = fakeProvider();
  unpublish = publishChildCompactionProvider(fake.provider);
  const run = await runChild(agentConfig("resume"));
  const child = fake.children[0];
  assert.ok(child);
  assert.deepEqual(run.compactionCallbacks, [], "no adoption during the first run");

  child.makeReady("resume-candidate");
  const resumed: { reason: string; tokensBefore: number }[] = [];
  const result = await resumeAgent(run.session, "continue", {
    onCompaction: (info) => resumed.push({ ...info }),
  });
  assert.equal(result.failure, undefined);
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0]?.reason, "threshold");
  assert.deepEqual(run.compactionCallbacks, [], "the finished runAgent listener stays detached");
  assert.equal(child.acks.length, 1);
  assert.equal(
    compactions(run.session.sessionManager.getBranch()).filter(
      (entry) => entry.summary === CHECKPOINT_SUMMARY,
    ).length,
    1,
  );
});

// ---------------------------------------------------------------------------
// Host-routed adoption: delivered by compaction_end only, with no summarizer
// request and no compaction hook
// ---------------------------------------------------------------------------

/** Real compaction extension options for a child; background compaction stays unconfigured. */
function childCompactionOptions(): Parameters<typeof registerCompaction>[1] {
  return {
    retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 },
    compactionPolicy: () => ({ keepRecentTokens: 1, reserveTokens: 0 }),
    background: { settingsPaths: () => [] },
  };
}

/**
 * The subagents extension publishes this registry in production; children are
 * recognized by it. Returns a restore callback that removes only what it added.
 */
function publishChildManagerRegistry(): () => void {
  const managerKey = Symbol.for("pi-subagents:manager");
  if (Object.getOwnPropertyDescriptor(globalThis, managerKey) !== undefined) return () => {};
  const registry = { isChildSessionId: (id: string) => isChildSessionId(id) };
  Object.defineProperty(globalThis, managerKey, { value: registry, configurable: true });
  return () => {
    Reflect.deleteProperty(globalThis, managerKey);
  };
}

/** Production package set inside a non-isolated child: real compaction summarizer and real hooks. */
async function childPackages(root: string): Promise<{
  readonly factories: readonly ExtensionFactory[];
  readonly hookLog: () => Promise<string[]>;
  readonly restore: () => void;
}> {
  const home = join(root, "home");
  const log = join(root, "hooks.log");
  await mkdir(join(home, ".claude"), { recursive: true });
  const hook = (name: string) => [
    { hooks: [{ type: "command", command: `printf '${name}\\n' >> '${log}'` }] },
  ];
  await writeFile(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PreCompact: hook("PreCompact"), PostCompact: hook("PostCompact") } }),
  );
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const restoreManagerRegistry = publishChildManagerRegistry();
  const compaction: ExtensionFactory = (pi) => {
    registerCompaction(pi, childCompactionOptions());
  };
  return {
    factories: [compaction, chocoPiHooks],
    hookLog: async () => {
      const text = await readFile(log, "utf8").catch(() => "");
      return text.split("\n").filter((line) => line.length > 0);
    },
    restore: () => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      restoreManagerRegistry();
    },
  };
}

test("host-routed child adoption skips the paid summarizer and Pre/PostCompact hooks", async () => {
  const thresholdAgentDir = join(rootDir, "agent-threshold-packages");
  await mkdir(thresholdAgentDir, { recursive: true });
  await writeFile(
    join(thresholdAgentDir, "settings.json"),
    JSON.stringify({
      compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 199_000 },
      retry: { enabled: false },
    }),
  );
  process.env.PI_CODING_AGENT_DIR = thresholdAgentDir;
  const packages = await childPackages(join(rootDir, "child-packages"));
  try {
    const current = requireHost();
    const fake = fakeProvider({
      readyAtCreation: { candidateId: "package-candidate" },
      hideReadyFromStatus: true,
    });
    unpublish = publishChildCompactionProvider(fake.provider);
    // Only the tool-call turn crosses the threshold, so the host compacts
    // exactly once, mid-run, inside the runner's onCompaction window.
    let index = 0;
    current.setResponder(async () =>
      index++ === 0 ? reply("STEP", { toolCall: true, usageInput: 5_000 }) : reply("DONE"),
    );
    const summarizerBefore = current.summarizerCalls();
    const run = await runChild(agentConfig("host-route-packages"), {
      packageFactories: packages.factories,
    });
    const child = fake.children[0];
    assert.ok(child);
    const committed = compactions(run.session.sessionManager.getBranch()).filter(
      (entry) => entry.summary === CHECKPOINT_SUMMARY,
    );
    assert.equal(committed.length, 1, "exactly one adoption committed");
    assert.equal(child.acks.length, 1);
    assert.deepEqual(
      run.compactionCallbacks.map((info) => info.reason),
      ["threshold"],
    );
    assert.equal(current.summarizerCalls(), summarizerBefore, "no summarizer request");
    assert.deepEqual(await packages.hookLog(), [], "no PreCompact or PostCompact hook");
  } finally {
    packages.restore();
    process.env.PI_CODING_AGENT_DIR = agentDir;
  }
});

// ---------------------------------------------------------------------------
// Cancellation and timeout
// ---------------------------------------------------------------------------

test("cancellation releases the child candidate and registry entry without parent mutation", async () => {
  const current = requireHost();
  const parentEntries = structuredClone(current.manager.getEntries());
  const parentKey = `parent:${current.manager.getSessionId()}`;
  const parentFake = createFakeChild(placeholderContext(parentKey));
  setCoordinator(parentKey, parentFake.coordinator);
  try {
    const fake = fakeProvider();
    unpublish = publishChildCompactionProvider(fake.provider);
    const controller = new AbortController();
    const requested = Promise.withResolvers<void>();
    current.setResponder(
      () =>
        new Promise<AssistantMessage>(() => {
          requested.resolve();
        }),
    );
    const pending = runChild(agentConfig("cancel"), { run: { signal: controller.signal } });
    await requested.promise;
    const child = fake.children[0];
    assert.ok(child);
    assert.equal(getCoordinator(child.context.ownerKey), child.coordinator, "attached mid-run");
    controller.abort();
    const run = await pending;
    assert.equal(getCoordinator(child.context.ownerKey), undefined, "registry entry removed");
    assert.deepEqual(child.cancels, ["canceled"]);
    assert.equal(child.disposals(), 1);
    assert.equal(child.context.signal.aborted, true);
    assert.deepEqual(run.compactionCallbacks, []);
    assert.deepEqual(childKeys(), []);
    assert.deepEqual(current.manager.getEntries(), parentEntries, "parent untouched");
    assert.deepEqual(parentFake.calls, [], "parent coordinator never touched by the child");
    assert.equal(getCoordinator(parentKey), parentFake.coordinator);
    // A later disposal is idempotent.
    await disposeChild(run.session);
    assert.equal(child.disposals(), 1);
  } finally {
    release(parentKey, parentFake.coordinator.ownerGeneration, parentFake.coordinator);
  }
});

test("turn-limit timeout releases the child candidate and registry entry", async () => {
  const current = requireHost();
  const previousGrace = getGraceTurns();
  setGraceTurns(1);
  try {
    const fake = fakeProvider();
    unpublish = publishChildCompactionProvider(fake.provider);
    let index = 0;
    current.setResponder(async () => reply(`LOOP-${index++}`, { toolCall: true }));
    const run = await runChild(agentConfig("timeout"), { run: { maxTurns: 1 } });
    assert.equal(run.aborted, true, "runner hard-aborted the child");
    const child = fake.children[0];
    assert.ok(child);
    assert.equal(getCoordinator(child.context.ownerKey), undefined);
    assert.deepEqual(child.cancels, ["canceled"]);
    assert.equal(child.disposals(), 1);
    assert.deepEqual(childKeys(), []);
  } finally {
    setGraceTurns(previousGrace);
  }
});

// ---------------------------------------------------------------------------
// Late coordinator creation after disposal (stale-after-await)
// ---------------------------------------------------------------------------

test("a coordinator created after the child is disposed is disposed and never registered", async () => {
  const gate = Promise.withResolvers<void>();
  const fake = fakeProvider({ creationGate: gate.promise });
  unpublish = publishChildCompactionProvider(fake.provider);
  const run = await runChild(agentConfig("late"));
  assert.equal(run.responseText, "DEFAULT", "child start was not blocked by creation");
  await disposeChild(run.session);
  gate.resolve();
  await flush();
  const child = fake.children[0];
  assert.ok(child);
  assert.equal(child.disposals(), 1);
  assert.equal(getCoordinator(child.context.ownerKey), undefined);
  assert.equal(child.context.signal.aborted, true);
  assert.deepEqual(childKeys(), []);
});

function placeholderContext(ownerKey: string): ChildCoordinatorContext {
  const manager = SessionManager.inMemory(rootDir);
  return {
    ownerKey,
    ownerGeneration: 1,
    childSessionId: ownerKey,
    parentSessionId: undefined,
    mainSessionFork: false,
    readOnly: false,
    isolated: false,
    sessionManager: manager,
    model: undefined,
    appendRecord: () => {
      throw new Error("placeholder");
    },
    appendAnchor: () => "",
    signal: new AbortController().signal,
  };
}
