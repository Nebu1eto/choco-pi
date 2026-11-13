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
  AgentSession,
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
  CandidateRecord,
  CandidateState,
  CoordinatorApi,
  ReasonCode,
} from "../../choco-pi-compaction/src/background/contract.ts";
import { isCandidateRecord } from "../../choco-pi-compaction/src/background/contract.ts";
import {
  getCoordinator,
  getRegistry,
  release,
  setCoordinator,
} from "../../choco-pi-compaction/src/background/registry.ts";
import { registerSessionNativeRefresher } from "../../choco-pi-compaction/src/background-host/native-refresh.ts";
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
  getChildCompactionBridge,
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
  /** Outcome of simulated recovery at creation; undefined when nothing was recovered. */
  readonly recovered: () => "ready" | "discarded" | undefined;
  makeReady(candidateId: string, firstKeptEntryId?: string): void;
  markPreparing(): void;
  markInstalled(): void;
  /** Simulated `recoverChildCandidates`: newest valid record, revalidated by prefix. */
  recoverFromBranch(): void;
}

interface FakeProviderOptions {
  readonly enabled?: boolean;
  /** Ready candidate at creation; the retained entry defaults to the first user message. */
  readonly readyAtCreation?: { readonly candidateId: string; readonly firstKeptEntryId?: string };
  /** Hold creation until this promise settles (stale-after-await tests). */
  readonly creationGate?: Promise<void>;
  /** Report "preparing" from status() so only host-routed arbitration can adopt. */
  readonly hideReadyFromStatus?: boolean;
  /** Recover persisted candidate records from the child branch at creation. */
  readonly recoverFromBranch?: boolean;
  /** Reject creation attempts while this returns true (the attempt number is 1-based). */
  readonly rejectCreation?: (attempt: number) => boolean;
  /** Make a candidate ready when this boundary is observed (before the bridge checks status). */
  readonly readyAtBoundary?: {
    readonly kind: "turn_end" | "agent_before_settle";
    readonly candidateId: string;
  };
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
  let recovered: "ready" | "discarded" | undefined;

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
      // Like the real coordinator: there is no adopting -> canceled edge; a proposal fails closed.
      else if (state === "adopting") state = "discarded-stale";
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
    recovered: () => recovered,
    makeReady(candidateId, firstKeptEntryId) {
      candidate = { id: candidateId, firstKeptEntryId };
      state = "ready";
    },
    markPreparing() {
      state = "preparing";
    },
    markInstalled() {
      state = "installed";
    },
    recoverFromBranch() {
      const branch = context.sessionManager.getBranch();
      const records: CandidateRecord[] = [];
      for (const entry of branch) {
        if (entry.type !== "custom" || entry.customType !== "choco-compaction-candidate") continue;
        const data: unknown = entry.data;
        if (isCandidateRecord(data)) records.push(data);
      }
      const newest = records.at(-1);
      if (newest === undefined) return;
      if (
        prefixFingerprint(branch, newest.identity.cutEntryId) === newest.identity.prefixFingerprint
      ) {
        candidate = { id: newest.candidateId, firstKeptEntryId: undefined };
        state = "ready";
        recovered = "ready";
      } else {
        state = "discarded-stale";
        recovered = "discarded";
      }
    },
  };
}

/** Fingerprint of the branch up to and including `cutEntryId`; "" when it is off the branch. */
function prefixFingerprint(branch: readonly SessionEntry[], cutEntryId: string): string {
  const index = branch.findIndex((entry) => entry.id === cutEntryId);
  if (index < 0) return "";
  return branch
    .slice(0, index + 1)
    .map((entry) => entry.id)
    .join(">");
}

/** A schema-valid persisted candidate whose prefix ends at `cutEntryId` on `branch`. */
function candidateRecord(
  context: ChildCoordinatorContext,
  candidateId: string,
  cutEntryId: string,
  fingerprint = prefixFingerprint(context.sessionManager.getBranch(), cutEntryId),
): CandidateRecord {
  const details = { strategy: "local-reconciled" as const };
  const record: CandidateRecord = {
    customType: "choco-compaction-candidate",
    schemaVersion: 1,
    candidateId,
    backendId: "text",
    identity: {
      cutEntryId,
      prefixFingerprint: fingerprint,
      priorCheckpointId: null,
      priorCheckpointVersion: null,
      ownerKey: context.ownerKey,
      ownerGeneration: context.ownerGeneration,
      providerScope: { provider: PROVIDER, model: "child-fake-model" },
    },
    createdAt: Date.now(),
    checkpoint: {
      candidateId,
      backendId: "text",
      schemaVersion: 1,
      draft: { type: "compaction", summary: CHECKPOINT_SUMMARY, firstKeptEntryId: null, details },
      details,
      usage: { input: 0, output: 0 },
      reasonCodes: ["prepared"],
    },
  };
  assert.ok(isCandidateRecord(record), "fixture record is schema-valid");
  return record;
}

/** The runner-facing attachment for one fake child: records boundaries and commits. */
function fakeAttachment(
  child: FakeChild,
  readyAtBoundary?: FakeProviderOptions["readyAtBoundary"],
): ChildCoordinatorAttachment {
  return {
    coordinator: child.coordinator,
    observeBoundary: (boundary) => {
      child.boundaries.push(boundary.kind);
      if (readyAtBoundary?.kind === boundary.kind && child.state() === "idle") {
        child.makeReady(readyAtBoundary.candidateId);
      }
    },
    acknowledgeCommit: (entry) => {
      child.calls.push("acknowledgeCommit");
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
      if (options.rejectCreation?.(attempts) === true) {
        throw new Error(`provider rejected creation ${attempts}`);
      }
      const child = createFakeChild(context, options.hideReadyFromStatus === true);
      children.push(child);
      if (options.creationGate) await options.creationGate;
      if (options.readyAtCreation) {
        child.makeReady(
          options.readyAtCreation.candidateId,
          options.readyAtCreation.firstKeptEntryId,
        );
      }
      if (options.recoverFromBranch) child.recoverFromBranch();
      return fakeAttachment(child, options.readyAtBoundary);
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
    /** Loaded after the runner's inline factories, so their handlers run after the bridge's. */
    readonly trailingFactories?: readonly ExtensionFactory[];
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
          ...(options.trailingFactories ?? []),
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
    let liveSession: AgentSession | undefined;
    const pending = runChild(agentConfig("cancel"), {
      run: {
        signal: controller.signal,
        onSessionCreated: (session) => {
          liveSession = session;
        },
      },
    });
    await requested.promise;
    const child = fake.children[0];
    assert.ok(child);
    assert.equal(getCoordinator(child.context.ownerKey), child.coordinator, "attached mid-run");
    child.markPreparing();
    assert.ok(liveSession);
    const bridge = getChildCompactionBridge(liveSession);
    assert.ok(bridge);
    assert.equal(bridge.isPreparing(), true, "preparing while attached");
    controller.abort();
    const run = await pending;
    assert.equal(getCoordinator(child.context.ownerKey), undefined, "registry entry removed");
    assert.deepEqual(child.cancels, ["canceled"]);
    assert.equal(child.disposals(), 1);
    assert.equal(child.context.signal.aborted, true);
    // Quiesced, not disposed: the session keeps its bridge for a resume.
    assert.equal(getChildCompactionBridge(run.session), bridge, "WeakMap keeps the bridge");
    assert.equal(bridge.isPreparing(), false, "a quiesced bridge reads as idle");
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
    assert.equal(child.context.signal.aborted, true);
    const bridge = getChildCompactionBridge(run.session);
    assert.ok(bridge, "a timed-out child keeps its bridge for a resume");
    assert.equal(bridge.isPreparing(), false);
    assert.deepEqual(childKeys(), []);
    // Resume reattaches a fresh coordinator under the same owner key.
    current.setResponder(async () => reply("AFTER-TIMEOUT"));
    await resumeAgent(run.session, "continue");
    const next = fake.children[1];
    assert.ok(next, "resume created a new coordinator");
    assert.equal(next.context.ownerKey, child.context.ownerKey);
    assert.equal(next.context.ownerGeneration, child.context.ownerGeneration + 1);
    assert.equal(getCoordinator(next.context.ownerKey), next.coordinator);
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

// ---------------------------------------------------------------------------
// Quiesce, reattach, and the agent_before_settle route
// ---------------------------------------------------------------------------

/** Start a child, run `whileRunning` once its first request is in flight, then cancel it. */
async function cancelMidRun(
  name: string,
  fake: ReturnType<typeof fakeProvider>,
  whileRunning: (child: FakeChild, session: AgentSession) => void = () => {},
): Promise<{ readonly run: ChildRun; readonly child: FakeChild }> {
  const current = requireHost();
  const controller = new AbortController();
  const requested = Promise.withResolvers<void>();
  current.setResponder(
    () =>
      new Promise<AssistantMessage>(() => {
        requested.resolve();
      }),
  );
  let liveSession: AgentSession | undefined;
  const pending = runChild(agentConfig(name), {
    run: {
      signal: controller.signal,
      onSessionCreated: (session) => {
        liveSession = session;
      },
    },
  });
  await requested.promise;
  const child = fake.children[0];
  assert.ok(child);
  assert.ok(liveSession);
  whileRunning(child, liveSession);
  controller.abort();
  const run = await pending;
  assert.equal(child.disposals(), 1, "quiesce disposed the coordinator");
  return { run, child };
}

/** The child user message carrying `needle` on the session's current branch. */
function promptEntry(session: AgentSession, needle: string): SessionEntry {
  const entry = session.sessionManager.getBranch().find((item) => isUserPromptWith(item, needle));
  assert.ok(entry, `prompt "${needle}" on the branch`);
  return entry;
}

test("reattach after cancel recovers a persisted candidate whose prefix still matches", async () => {
  const fake = fakeProvider({ recoverFromBranch: true });
  unpublish = publishChildCompactionProvider(fake.provider);
  const { run, child } = await cancelMidRun("reattach-match", fake, (first, session) => {
    const cut = promptEntry(session, "child prompt");
    void first.context.appendRecord(candidateRecord(first.context, "persisted", cut.id));
  });
  assert.equal(getCoordinator(child.context.ownerKey), undefined);
  assert.equal(fake.attempts(), 1);

  requireHost().setResponder(async () => reply("RESUMED"));
  const resumed: { reason: string; tokensBefore: number }[] = [];
  const result = await resumeAgent(run.session, "continue", {
    onCompaction: (info) => resumed.push({ ...info }),
  });
  assert.equal(result.failure, undefined);
  assert.equal(fake.attempts(), 2, "resume reattached exactly once");
  const next = fake.children[1];
  assert.ok(next);
  assert.notEqual(next.coordinator, child.coordinator);
  assert.equal(next.context.ownerKey, child.context.ownerKey);
  assert.equal(next.context.ownerGeneration, child.context.ownerGeneration + 1);
  assert.equal(next.context.signal.aborted, false, "fresh abort controller");
  assert.equal(next.recovered(), "ready", "the persisted candidate recovered to ready");
  assert.equal(getCoordinator(next.context.ownerKey), next.coordinator, "re-registered");
  const committed = compactions(run.session.sessionManager.getBranch()).filter(
    (entry) => entry.summary === CHECKPOINT_SUMMARY,
  );
  assert.equal(committed.length, 1, "the recovered candidate committed during the resume");
  assert.equal(resumed.length, 1);
  assert.equal(next.acks.length, 1);

  // A normal settle keeps the reattached coordinator; a second reattach is a no-op.
  const bridge = getChildCompactionBridge(run.session);
  assert.ok(bridge);
  await bridge.reattach();
  assert.equal(fake.attempts(), 2);
});

test("reattach after cancel discards a persisted candidate whose branch diverged", async () => {
  const fake = fakeProvider({ recoverFromBranch: true });
  unpublish = publishChildCompactionProvider(fake.provider);
  const { run, child } = await cancelMidRun("reattach-diverged", fake, (first, session) => {
    const cut = promptEntry(session, "child prompt");
    void first.context.appendRecord(candidateRecord(first.context, "persisted", cut.id));
  });
  const cut = promptEntry(run.session, "child prompt");
  assert.ok(cut.parentId, "the cut has an ancestor to branch from");
  // Moving the leaf above the cut also takes the record (its descendant) off the branch.
  run.session.sessionManager.branch(cut.parentId);

  requireHost().setResponder(async () => reply("RESUMED"));
  const resumed: { reason: string; tokensBefore: number }[] = [];
  await resumeAgent(run.session, "continue", {
    onCompaction: (info) => resumed.push({ ...info }),
  });
  const next = fake.children[1];
  assert.ok(next);
  assert.equal(next.context.ownerGeneration, child.context.ownerGeneration + 1);
  assert.equal(next.recovered(), undefined, "no record remains on the diverged branch");
  assert.equal(next.state(), "idle");
  assert.equal(compactions(run.session.sessionManager.getBranch()).length, 0);
  assert.deepEqual(resumed, []);
  assert.ok(!next.calls.includes("arbitrateHostCompaction"), "nothing ready to arbitrate");
});

test("reattach discards a persisted candidate whose prefix no longer validates", async () => {
  const fake = fakeProvider({ recoverFromBranch: true });
  unpublish = publishChildCompactionProvider(fake.provider);
  const { run } = await cancelMidRun("reattach-stale", fake, (first) => {
    const record = candidateRecord(first.context, "stale", "not-on-branch", "fp-elsewhere");
    void first.context.appendRecord(record);
  });
  requireHost().setResponder(async () => reply("RESUMED"));
  await resumeAgent(run.session, "continue");
  const next = fake.children[1];
  assert.ok(next);
  assert.equal(next.recovered(), "discarded", "the record was found and refused");
  assert.equal(next.state(), "discarded-stale");
  assert.equal(compactions(run.session.sessionManager.getBranch()).length, 0);
});

test("a preparation that completes after quiesce appends nothing and adopts nothing", async () => {
  const fake = fakeProvider();
  unpublish = publishChildCompactionProvider(fake.provider);
  const { run, child } = await cancelMidRun("late-prepare", fake, (first) => {
    first.markPreparing();
  });
  const manager = run.session.sessionManager;
  const entriesAfterQuiesce = manager.getEntries().length;
  const callsAfterQuiesce = child.calls.length;

  // The old coordinator's preparation resolves late: persisting and anchoring are refused.
  const cut = promptEntry(run.session, "child prompt");
  assert.throws(
    () => child.context.appendRecord(candidateRecord(child.context, "late", cut.id)),
    /no longer current/,
  );
  assert.equal(child.context.appendAnchor(), "");
  child.makeReady("late");
  assert.equal(manager.getEntries().length, entriesAfterQuiesce, "nothing appended");

  const bridge = getChildCompactionBridge(run.session);
  assert.ok(bridge);
  const adoptions: unknown[] = [];
  const stop = bridge.onAdoption((info) => adoptions.push(info));
  try {
    requireHost().setResponder(async () => reply("RESUMED"));
    const resumed: unknown[] = [];
    await resumeAgent(run.session, "continue", { onCompaction: (info) => resumed.push(info) });
    assert.deepEqual(adoptions, [], "no adoption listener fired");
    assert.deepEqual(resumed, []);
  } finally {
    stop();
  }
  assert.deepEqual(child.calls.slice(callsAfterQuiesce), [], "the old coordinator is never asked");
  assert.equal(compactions(manager.getBranch()).length, 0);
  assert.equal(fake.children[1]?.calls.includes("arbitrateHostCompaction"), false);
});

test("second quiesce is a no-op; disposal is once; reattach after disposal is a no-op", async () => {
  const fake = fakeProvider();
  unpublish = publishChildCompactionProvider(fake.provider);
  const { run, child } = await cancelMidRun("dispose-once", fake);
  const bridge = getChildCompactionBridge(run.session);
  assert.ok(bridge);
  bridge.settle({ canceled: true, timedOut: false });
  bridge.settle({ canceled: false, timedOut: true });
  assert.equal(child.disposals(), 1, "a repeated quiesce disposes nothing");
  assert.deepEqual(child.cancels, ["canceled"]);

  // Reattach, then retire the record: the fresh coordinator is disposed exactly once.
  await bridge.reattach();
  const next = fake.children[1];
  assert.ok(next);
  assert.equal(getCoordinator(next.context.ownerKey), next.coordinator);
  await disposeChild(run.session);
  assert.equal(next.disposals(), 1);
  assert.equal(next.context.signal.aborted, true);
  assert.equal(getCoordinator(next.context.ownerKey), undefined);
  assert.equal(getChildCompactionBridge(run.session), undefined, "disposal drops the bridge");

  bridge.settle({ canceled: true, timedOut: false });
  bridge.dispose();
  await bridge.reattach();
  assert.equal(fake.attempts(), 2, "no coordinator created after disposal");
  assert.equal(next.disposals(), 1);
  assert.equal(child.disposals(), 1);
  assert.deepEqual(childKeys(), []);
});

test("a candidate ready at agent_before_settle commits before the run settles", async () => {
  const fake = fakeProvider({
    readyAtBoundary: { kind: "agent_before_settle", candidateId: "settle-candidate" },
  });
  unpublish = publishChildCompactionProvider(fake.provider);
  const run = await runChild(agentConfig("settle-route"));
  const child = fake.children[0];
  assert.ok(child);
  assert.deepEqual(child.boundaries, ["turn_end", "agent_before_settle"]);
  assert.deepEqual(
    child.calls.filter((call) => call === "arbitrateHostCompaction"),
    ["arbitrateHostCompaction"],
    "arbitrated once, at agent_before_settle",
  );
  const committed = compactions(run.session.sessionManager.getBranch()).filter(
    (entry) => entry.summary === CHECKPOINT_SUMMARY,
  );
  assert.equal(committed.length, 1, "the ready candidate committed at agent_before_settle");
  assert.equal(child.acks.length, 1);
  assert.equal(child.state(), "installed");
  assert.deepEqual(
    run.compactionCallbacks.map((info) => info.reason),
    ["threshold"],
  );
});

type TranscriptMessage = TranscriptContext["messages"][number];

/** One provider-request message as `role:text`, tool calls rendered as `toolCall`. */
function requestLine(message: TranscriptMessage): string {
  const content = message.content;
  const text = Array.isArray(content)
    ? content.map((part) => (part.type === "text" ? part.text : part.type)).join("|")
    : content;
  return `${message.role}:${text}`;
}

/**
 * Pi SDK 1.3.0 ends a turn after every assistant response and its tool batch,
 * so one long tool-cycling task crosses a `turn_end` per cycle. No mid-turn
 * projection exists in the bridge; this pins the SDK behavior that makes it
 * unnecessary.
 */
test("a multi-tool child adopts at the next tool-cycle boundary and the next provider request starts with the summary", async () => {
  const fake = fakeProvider();
  unpublish = publishChildCompactionProvider(fake.provider);
  const requests: string[][] = [];
  let cutEntryId: string | undefined;
  let index = 0;
  requireHost().setResponder(async (context) => {
    requests.push(context.messages.filter((message) => message.role !== "system").map(requestLine));
    const n = index++;
    if (n === 2) {
      // Ready while the third request is in flight; the cut is STEP1's assistant entry.
      const child = fake.children[0];
      assert.ok(child);
      const cut = child.context.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
        .at(-1);
      assert.ok(cut);
      cutEntryId = cut.id;
      child.makeReady("tool-cycle", cut.id);
    }
    return n < 5 ? reply(`STEP${n}`, { toolCall: true }) : reply("DONE");
  });
  const run = await runChild(agentConfig("tool-cycles"), { prompt: "CYCLE-PROMPT" });
  const child = fake.children[0];
  assert.ok(child);
  assert.ok(cutEntryId);
  assert.equal(run.responseText, "DONE");
  assert.equal(requests.length, 6, "five tool cycles and a final answer");
  assert.deepEqual(
    child.boundaries,
    [...Array.from({ length: 6 }, () => "turn_end"), "agent_before_settle"],
    "one turn_end per tool cycle",
  );

  // Requests up to the one in flight when the candidate became ready are uncompacted.
  for (const request of requests.slice(0, 3)) {
    assert.equal(request[0], "user:CYCLE-PROMPT");
  }
  // The next request (after STEP2's turn_end) and every later one start with the summary.
  for (const request of requests.slice(3)) {
    const [summary, firstKept] = request;
    assert.ok(summary?.startsWith("user:The conversation history before this point"));
    assert.ok(summary.includes(CHECKPOINT_SUMMARY));
    assert.equal(firstKept, "assistant:STEP1|toolCall", "transcript resumes at the cut");
    assert.ok(!request.some((line) => line.includes("CYCLE-PROMPT")), "prompt covered");
    assert.ok(!request.some((line) => line.startsWith("assistant:STEP0")), "STEP0 covered");
  }

  assert.deepEqual(
    child.calls.filter((call) => call === "arbitrateHostCompaction"),
    ["arbitrateHostCompaction"],
    "arbitrated once",
  );
  assert.deepEqual(
    child.calls.filter((call) => call === "acknowledgeCommit"),
    ["acknowledgeCommit"],
    "committed once",
  );
  const committed = compactions(run.session.sessionManager.getBranch());
  assert.equal(committed.length, 1, "one compaction entry on the branch");
  assert.equal(committed[0]?.summary, CHECKPOINT_SUMMARY);
  assert.equal(committed[0]?.firstKeptEntryId, cutEntryId);
  assert.deepEqual(
    run.compactionCallbacks.map((info) => info.reason),
    ["threshold"],
  );
});

// ---------------------------------------------------------------------------
// Native compaction state refresh on reattach, and commit-then-cancel ordering
// ---------------------------------------------------------------------------

test("reattach replays the child's registered native compaction state exactly once", async () => {
  const fake = fakeProvider();
  unpublish = publishChildCompactionProvider(fake.provider);
  const { run, child } = await cancelMidRun("native-refresh", fake);
  const childId = run.session.sessionManager.getSessionId();
  const seen: { readonly sessionId: string; readonly attached: boolean }[] = [];
  const unrelated: string[] = [];
  const unregister = registerSessionNativeRefresher(childId, "bridge-test", (ctx) => {
    seen.push({
      sessionId: ctx.sessionManager.getSessionId(),
      attached: getCoordinator(child.context.ownerKey) !== undefined,
    });
  });
  const unregisterUnrelated = registerSessionNativeRefresher("unrelated", "bridge-test", () => {
    unrelated.push("unrelated");
  });
  try {
    const bridge = getChildCompactionBridge(run.session);
    assert.ok(bridge);
    await bridge.reattach();
    assert.deepEqual(seen, [{ sessionId: childId, attached: true }], "after the new attachment");
    assert.deepEqual(unrelated, [], "only the child's own refreshers run");
    await bridge.reattach();
    assert.equal(seen.length, 1, "an attached bridge does not refresh again");
    assert.equal(fake.attempts(), 2);
  } finally {
    unregister();
    unregisterUnrelated();
  }
});

test("a failing native refresh is reported and never rejects reattach", async () => {
  const fake = fakeProvider();
  unpublish = publishChildCompactionProvider(fake.provider);
  const { run, child } = await cancelMidRun("native-refresh-fails", fake);
  const childId = run.session.sessionManager.getSessionId();
  const unregister = registerSessionNativeRefresher(childId, "bridge-test", () => {
    throw new Error("native replay exploded");
  });
  const unregisterStale = registerSessionNativeRefresher(childId, "bridge-test-stale", () => {
    throw new Error("This extension ctx is stale after session replacement or reload.");
  });
  try {
    const bridge = getChildCompactionBridge(run.session);
    assert.ok(bridge);
    const errorsBefore = run.activity.filter((name) => name.startsWith("extension-error:")).length;
    await bridge.reattach();
    const errors = run.activity
      .filter((name) => name.startsWith("extension-error:"))
      .slice(errorsBefore);
    assert.equal(errors.length, 1, "one report; the stale-context failure is contained");
    assert.match(errors[0] ?? "", /native state refresh failed: Error: native replay exploded/);
    const next = fake.children[1];
    assert.ok(next);
    assert.equal(getCoordinator(child.context.ownerKey), next.coordinator, "still attached");
  } finally {
    unregister();
    unregisterStale();
  }
});

test("a boundary commit followed by a cancel in the same tick is acknowledged before dispose", async () => {
  const fake = fakeProvider();
  unpublish = publishChildCompactionProvider(fake.provider);
  const run = await runChild(agentConfig("commit-then-cancel"));
  const child = fake.children[0];
  assert.ok(child);
  const bridge = getChildCompactionBridge(run.session);
  assert.ok(bridge);
  child.makeReady("same-tick");
  const callsBefore = child.calls.length;
  let cancelled = false;
  const stop = run.session.subscribe((event) => {
    if (cancelled || event.type !== "entry_appended" || event.entry.type !== "compaction") return;
    cancelled = true;
    bridge.settle({ canceled: true, timedOut: false });
  });
  try {
    requireHost().setResponder(async () => reply("RESUMED"));
    await resumeAgent(run.session, "continue");
  } finally {
    stop();
  }
  assert.equal(cancelled, true, "the cancel ran in the commit's tick");
  assert.deepEqual(child.calls.slice(callsBefore), [
    "arbitrateHostCompaction",
    "acknowledgeCommit",
    "cancel",
    "dispose",
  ]);
  assert.equal(child.state(), "installed");
  assert.equal(getCoordinator(child.context.ownerKey), undefined);

  await bridge.reattach();
  const next = fake.children[1];
  assert.ok(next, "the quiesced bridge reattached");
  assert.equal(next.context.ownerGeneration, child.context.ownerGeneration + 1);
  assert.equal(getCoordinator(next.context.ownerKey), next.coordinator);
});

test("a host-routed commit whose cancel preempts its acknowledgment is acknowledged, then replayed on resume", async () => {
  const manualAgentDir = join(rootDir, "agent-manual-compact");
  await mkdir(manualAgentDir, { recursive: true });
  await writeFile(
    join(manualAgentDir, "settings.json"),
    JSON.stringify({
      compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 16_384 },
      retry: { enabled: false },
    }),
  );
  process.env.PI_CODING_AGENT_DIR = manualAgentDir;
  try {
    const fake = fakeProvider();
    unpublish = publishChildCompactionProvider(fake.provider);
    let preempt: (() => void) | undefined;
    // Loaded before the bridge, so its session_compact handler runs first.
    const preempting: ExtensionFactory = (pi) => {
      pi.on("session_compact", () => {
        preempt?.();
      });
    };
    const run = await runChild(agentConfig("preempted-commit"), {
      packageFactories: [preempting],
    });
    const child = fake.children[0];
    assert.ok(child);
    const bridge = getChildCompactionBridge(run.session);
    assert.ok(bridge);
    preempt = () => {
      preempt = undefined;
      bridge.settle({ canceled: true, timedOut: false });
    };
    child.makeReady("preempted");
    const callsBefore = child.calls.length;
    await run.session.compact();
    assert.equal(preempt, undefined, "the cancel ran inside the commit's session_compact");
    assert.deepEqual(child.calls.slice(callsBefore), [
      "arbitrateManualCompact",
      "acknowledgeCommit",
      "cancel",
      "dispose",
    ]);
    assert.equal(child.acks.length, 1, "acknowledged once; the bridge's late handler is a no-op");
    assert.equal(child.state(), "installed");
    assert.equal(getCoordinator(child.context.ownerKey), undefined);
    const committed = (): number =>
      compactions(run.session.sessionManager.getBranch()).filter(
        (entry) => entry.summary === CHECKPOINT_SUMMARY,
      ).length;
    assert.equal(committed(), 1);

    // Resume: reattach and replay the native checkpoint before the prompt.
    const order: string[] = [];
    const unregister = registerSessionNativeRefresher(
      run.session.sessionManager.getSessionId(),
      "bridge-test",
      (ctx) => {
        order.push(`refresh:${ctx.sessionManager.getSessionId()}`);
      },
    );
    try {
      requireHost().setResponder(async () => {
        order.push("prompt");
        return reply("RESUMED");
      });
      const result = await resumeAgent(run.session, "continue");
      assert.equal(result.failure, undefined);
    } finally {
      unregister();
    }
    assert.deepEqual(order, [`refresh:${run.session.sessionManager.getSessionId()}`, "prompt"]);
    const next = fake.children[1];
    assert.ok(next);
    assert.equal(next.context.ownerGeneration, child.context.ownerGeneration + 1);
    assert.equal(committed(), 1, "the acknowledged checkpoint is not committed again");
  } finally {
    process.env.PI_CODING_AGENT_DIR = agentDir;
  }
});

// ---------------------------------------------------------------------------
// A normal settle between a host-route proposal and the host's append
// ---------------------------------------------------------------------------

/** Agent settings that let a short child session be compacted by hand. */
async function useManualCompactSettings(name: string): Promise<void> {
  const dir = join(rootDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "settings.json"),
    JSON.stringify({
      compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 16_384 },
      retry: { enabled: false },
    }),
  );
  process.env.PI_CODING_AGENT_DIR = dir;
}

/**
 * A trailing `session_before_compact` handler: it runs after the bridge has
 * adopted (proposal recorded) and before the host appends the entry.
 */
interface SettleRace {
  readonly factory: ExtensionFactory;
  arm(settle: () => void): void;
  fired(): boolean;
}

function settleBeforeAppend(answer?: { readonly cancel: true }): SettleRace {
  let armed: (() => void) | undefined;
  let fired = false;
  return {
    factory: (pi) => {
      pi.on("session_before_compact", () => {
        if (armed === undefined) return undefined;
        const settle = armed;
        armed = undefined;
        fired = true;
        settle();
        return answer;
      });
    },
    arm(settle) {
      armed = settle;
    },
    fired: () => fired,
  };
}

test("a host-route proposal outlives a normal settle and is acknowledged once on commit", async () => {
  await useManualCompactSettings("agent-settle-race");
  try {
    const fake = fakeProvider();
    unpublish = publishChildCompactionProvider(fake.provider);
    const race = settleBeforeAppend();
    const run = await runChild(agentConfig("settle-race"), { trailingFactories: [race.factory] });
    const child = fake.children[0];
    assert.ok(child);
    const bridge = getChildCompactionBridge(run.session);
    assert.ok(bridge);
    race.arm(() => bridge.settle({ canceled: false, timedOut: false }));
    child.makeReady("raced");
    const callsBefore = child.calls.length;
    await run.session.compact();
    assert.equal(race.fired(), true, "settle ran between adoption and the host's append");
    assert.deepEqual(child.calls.slice(callsBefore), [
      "arbitrateManualCompact",
      "acknowledgeCommit",
    ]);
    assert.equal(child.acks.length, 1, "acknowledged exactly once");
    assert.equal(child.state(), "installed");
    assert.equal(
      compactions(run.session.sessionManager.getBranch()).filter(
        (entry) => entry.summary === CHECKPOINT_SUMMARY,
      ).length,
      1,
    );
    assert.equal(getCoordinator(child.context.ownerKey), child.coordinator, "still attached");

    // The proposal is spent: a replayed commit event and a later settle change nothing.
    const entry = compactions(run.session.sessionManager.getBranch()).at(-1);
    assert.ok(entry);
    await run.session.extensionRunner.emit({
      type: "session_compact",
      compactionEntry: entry,
      fromExtension: true,
      reason: "manual",
      willRetry: false,
    });
    bridge.settle({ canceled: false, timedOut: false });
    assert.equal(child.acks.length, 1);
    assert.deepEqual(
      child.calls.slice(callsBefore),
      ["arbitrateManualCompact", "acknowledgeCommit", "cancel"],
      "only the later settle's own cancel, a no-op on an installed candidate",
    );
    assert.equal(child.state(), "installed");
  } finally {
    process.env.PI_CODING_AGENT_DIR = agentDir;
  }
});

test("a host-route proposal whose compaction fails after a normal settle is canceled once", async () => {
  await useManualCompactSettings("agent-settle-race-failed");
  try {
    const fake = fakeProvider();
    unpublish = publishChildCompactionProvider(fake.provider);
    const race = settleBeforeAppend({ cancel: true });
    const run = await runChild(agentConfig("settle-race-failed"), {
      trailingFactories: [race.factory],
    });
    const child = fake.children[0];
    assert.ok(child);
    const bridge = getChildCompactionBridge(run.session);
    assert.ok(bridge);
    race.arm(() => bridge.settle({ canceled: false, timedOut: false }));
    child.makeReady("raced-failed");
    const callsBefore = child.calls.length;
    await assert.rejects(run.session.compact(), /Compaction cancelled/);
    assert.equal(race.fired(), true);
    assert.deepEqual(
      child.calls.slice(callsBefore),
      ["arbitrateManualCompact", "cancel"],
      "the deferred cancel ran at session_compact_failed",
    );
    assert.equal(child.acks.length, 0);
    assert.equal(child.state(), "discarded-stale");
    assert.equal(compactions(run.session.sessionManager.getBranch()).length, 0);
  } finally {
    process.env.PI_CODING_AGENT_DIR = agentDir;
  }
});

// ---------------------------------------------------------------------------
// Session creation fails after the bridge exists
// ---------------------------------------------------------------------------

interface SubscriptionCensus {
  /** Subscriptions still open, per session bound during the run. */
  readonly live: Map<AgentSession, number>;
  /** Subscriptions ever opened, per session. */
  readonly opened: Map<AgentSession, number>;
}

/** Subscriptions per session bound while `run` executes, via the class prototype. */
async function withSubscriptionCensus(run: () => Promise<void>): Promise<SubscriptionCensus> {
  const live = new Map<AgentSession, number>();
  const opened = new Map<AgentSession, number>();
  const original = AgentSession.prototype.subscribe;
  const originalBind = AgentSession.prototype.bindExtensions;
  AgentSession.prototype.bindExtensions = function (this: AgentSession, bindings) {
    live.set(this, live.get(this) ?? 0);
    return originalBind.call(this, bindings);
  };
  AgentSession.prototype.subscribe = function (this: AgentSession, listener) {
    const unsubscribe = original.call(this, listener);
    live.set(this, (live.get(this) ?? 0) + 1);
    opened.set(this, (opened.get(this) ?? 0) + 1);
    let done = false;
    return () => {
      if (!done) {
        done = true;
        live.set(this, (live.get(this) ?? 1) - 1);
      }
      unsubscribe();
    };
  };
  try {
    await run();
  } finally {
    AgentSession.prototype.subscribe = original;
    AgentSession.prototype.bindExtensions = originalBind;
  }
  return { live, opened };
}

/** A trailing extension that makes `bindExtensions` reject through the runner's own onError. */
const BIND_FAILURE = "bind-extensions-failure";
const failingStart: ExtensionFactory = (pi) => {
  pi.on("session_start", () => {
    throw new Error(BIND_FAILURE);
  });
};

async function failChildCreation(name: string): Promise<SubscriptionCensus> {
  return withSubscriptionCensus(async () => {
    await assert.rejects(
      runChild(agentConfig(name), {
        trailingFactories: [failingStart],
        run: {
          // The runner forwards extension errors here; throwing propagates out of bindExtensions.
          onToolActivity: (event) => {
            if (event.toolName.startsWith("extension-error:")) throw new Error(BIND_FAILURE);
          },
        },
      }),
      new RegExp(BIND_FAILURE),
    );
  });
}

test("a bindExtensions failure disposes the bridge once and leaves no slot or subscription", async () => {
  const baseline = await failChildCreation("bind-failure-baseline");
  const baselineSessions = [...baseline.live.keys()];
  assert.equal(baselineSessions.length, 1, "one child session was created");
  const baselineSession = baselineSessions[0];
  assert.ok(baselineSession);
  baselineSession.dispose();

  const gate = Promise.withResolvers<void>();
  const fake = fakeProvider({ creationGate: gate.promise });
  unpublish = publishChildCompactionProvider(fake.provider);
  const census = await failChildCreation("bind-failure");
  const sessions = [...census.live.keys()];
  assert.equal(sessions.length, 1);
  const session = sessions[0];
  assert.ok(session);
  const childId = session.sessionManager.getSessionId();
  assert.equal(isChildSessionId(childId), false, "the child id was unregistered");
  assert.equal(getChildCompactionBridge(session), undefined, "the bridge left the WeakMap");
  assert.equal(
    (census.opened.get(session) ?? 0) - (baseline.opened.get(baselineSession) ?? 0),
    1,
    "the bridge subscribed to the child session",
  );
  assert.equal(
    census.live.get(session),
    baseline.live.get(baselineSession),
    "the bridge left no session subscription behind",
  );

  // The bridge's session_start ran before the failing handler, so creation was in flight.
  assert.equal(fake.attempts(), 1);
  const child = fake.children[0];
  assert.ok(child);
  assert.equal(child.context.signal.aborted, true, "the attempt was aborted by dispose");
  gate.resolve();
  await flush();
  assert.equal(child.disposals(), 1, "the late coordinator is disposed exactly once");
  assert.equal(getCoordinator(`${CHILD_OWNER_KEY_PREFIX}${childId}`), undefined);
  assert.deepEqual(childKeys(), []);

  // The shutdown a retiring manager would emit is a no-op on the disposed bridge.
  await emitChildSessionShutdown(session);
  assert.equal(child.disposals(), 1);
  assert.equal(fake.attempts(), 1);
  session.dispose();
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
test("a rejected reattach leaves the bridge idle so a later resume retries creation", async () => {
  const fake = fakeProvider({ rejectCreation: (attempt) => attempt === 2 });
  unpublish = publishChildCompactionProvider(fake.provider);
  const { run, child } = await cancelMidRun("reattach-retry", fake);
  const bridge = getChildCompactionBridge(run.session);
  assert.ok(bridge);
  bridge.settle({ canceled: true, timedOut: false });
  assert.equal(child.disposals(), 1);

  // The provider rejects the second attempt: reattach reports and resolves.
  await bridge.reattach();
  assert.equal(fake.attempts(), 2);
  assert.equal(fake.children.length, 1, "no coordinator was created by the rejected attempt");
  assert.deepEqual(childKeys(), [], "the rejected attempt registered nothing");

  // A later resume must retry; before the fix the failed attempt stayed "creating".
  await bridge.reattach();
  assert.equal(fake.attempts(), 3, "creation is retried after a rejected attempt");
  const next = fake.children[1];
  assert.ok(next, "the retry created a coordinator");
  assert.equal(getCoordinator(next.context.ownerKey), next.coordinator);
  assert.equal(next.context.ownerGeneration, 3, "each attempt took a generation");
  await disposeChild(run.session);
  assert.equal(next.disposals(), 1);
  assert.deepEqual(childKeys(), []);
});
