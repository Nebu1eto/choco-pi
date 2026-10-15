import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { InMemoryModelsStore, type Api, type Credential, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  defineTool,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  BackgroundCompactionSidecarSchema,
  DEFAULT_BACKGROUND_COMPACTION_SETTINGS,
  type BackgroundCompactionSettings,
} from "../../../.pi/packages/choco-pi-compaction/src/background/contract.ts";
import {
  getCoordinator,
  getRegistry,
  release,
} from "../../../.pi/packages/choco-pi-compaction/src/background/registry.ts";
import { crossFieldProblem } from "../../../.pi/packages/choco-pi-compaction/src/background/settings.ts";
import { mainOwnerKey } from "../../../.pi/packages/choco-pi-compaction/src/index.ts";
import { installAdoptionProbe } from "./adoption-probe.ts";
import { digest, InputSchema, Recorder, statusArtifact, writeArtifact } from "./artifacts.ts";
import { requireLiveRun } from "./budget.ts";
import { installConsumerProbe } from "./consumer-probe.ts";
import { loadWorktreeProfilePlan, type WorktreeProfilePlan } from "./esm-entry-loaders.ts";
import {
  FAKE_ANTHROPIC_KEY,
  FAKE_ANTHROPIC_MODEL,
  FAKE_MODEL,
  FAKE_OFFLINE_KEY,
  STEP_TOOL,
  stepResultText,
} from "./fake-sse.ts";
import {
  prepareRuntimeDirs,
  ReadOnlyMemoryCredentials,
  scopeProcessEnv,
  type EnvScope,
  type RuntimeDirs,
} from "./host-env.ts";
import { registerOfflineProvider } from "./host-provider.ts";
import { LiveLedger } from "./live-ledger.ts";
import {
  credentialSecrets,
  isAnthropicModel,
  LIVE_PROVIDER_MIRRORS,
  LIVE_SEEDED_MODELS,
  parseLiveSpec,
  readLiveCredential,
} from "./live-source.ts";
import { liveFetch, requestOrigin } from "./live-transport.ts";
import { seedPrefix, type SeedToolResults } from "./host-seed.ts";
import { HostState, type ForegroundObserver, type ResponseOverride } from "./host-state.ts";
import {
  installAnthropicFakeFactory,
  NATIVE_SIGNATURE,
  scriptedLaneFetch,
} from "./native-factory.ts";
import { WORKTREE } from "./profile.ts";
import { installTextFakeFactory } from "./text-factory.ts";
import { capturePayload, recordBranch } from "./transport-capture.ts";

export { WORKTREE } from "./profile.ts";

export interface LaunchOptions {
  scratchRoot: string;
  failureOut?: string;
  scenario: string;
  factories?: readonly ExtensionFactory[];
  settings?: Partial<BackgroundCompactionSettings>;
  profile?: "boundary-only" | "worktree";
  cycles?: number;
  seedBytes?: number;
  /** Seeded step-tool exchanges (count x chars of tool output) before the first turn. */
  seedToolResults?: SeedToolResults;
  seedNamespace?: string;
  /** Host compaction keepRecentTokens, which production reads for the snapshot cut (default 1). */
  keepRecentTokens?: number;
  /** Enable Pi's own compaction (needed for host overflow recovery); default off. */
  hostCompaction?: boolean;
  /**
   * Serve the Anthropic model (offline: the OAuth-shaped mirror over the
   * production capturing stream and a scripted lane) with background compaction
   * off, for the foreground server-side path.
   */
  anthropicForeground?: boolean;
  /** Extra keys merged into the isolated agent `settings.json` (e.g. context presets). */
  agentSettings?: Readonly<Record<string, string>>;
  /**
   * Seed every live catalog mirror into the in-memory models store and apply the
   * worktree `.pi/models.json` overrides (the real agent dir symlinks it), copied
   * into the isolated agent dir. Both tiers.
   */
  catalog?: boolean;
  /** Offline: serve this model instead of the default fixture (harness-offline provider only). */
  offlineModel?: Model<"anthropic-messages">;
  /**
   * Live: allow a non-Anthropic model served by its own provider transport (for
   * Codex, choco-pi-codex's WebSocket, which global fetch does not see).
   */
  providerOwnedTransport?: boolean;
  /** Live tier: real provider transport for this approved provider/model. */
  live?: LiveLaunch;
  /** Reuse a caller-owned runtime tree (agent/project/sessions/home) across launches. */
  runtimeRoot?: string;
  /** Reopen this persisted session through SessionManager.open instead of seeding. */
  resumeSessionFile?: string;
  /** Keep the runtime tree on cleanup (always kept for a caller-owned runtimeRoot). */
  preserveRuntime?: boolean;
}

export interface LiveLaunch {
  readonly model: string;
  /** The real agent dir holding auth.json, resolved before any launcher scoped the env. */
  readonly sourceAgentDir: string;
}

/** Live inputs read once before the launcher scopes the process. */
interface LiveSource {
  readonly launch: LiveLaunch;
  readonly provider: string;
  readonly modelId: string;
  readonly credential: Credential;
  readonly expected: ReturnType<typeof requireLiveRun>;
}
interface LiveInputs extends LiveSource {
  readonly ledger: LiveLedger;
}

let launcherActive = false;

/** Resources owned by one launch, released by cleanup. */
class Owned {
  readonly releases: (() => void)[] = [];
  readonly children = new Set<AgentSession>();
  session: AgentSession | undefined;
  env: EnvScope | undefined;
  dirs: RuntimeDirs | undefined;
}

function copyOptions(input: LaunchOptions): LaunchOptions {
  return {
    ...input,
    factories: [...(input.factories ?? [])],
    settings: structuredClone(input.settings ?? {}),
    agentSettings: input.agentSettings === undefined ? undefined : { ...input.agentSettings },
    offlineModel:
      input.offlineModel === undefined ? undefined : structuredClone(input.offlineModel),
    live: input.live === undefined ? undefined : { ...input.live },
    seedToolResults: input.seedToolResults === undefined ? undefined : { ...input.seedToolResults },
  };
}

function protectedStringsOf(credential: Credential | undefined): string[] {
  const list = [FAKE_OFFLINE_KEY, FAKE_ANTHROPIC_KEY];
  return credential === undefined ? list : [...list, ...credentialSecrets(credential)];
}

function blockedFetch(state: HostState): typeof globalThis.fetch {
  return async (input) => {
    state.networkCalls++;
    state.recorder.record("network-blocked", {
      reason: "global-fetch-prohibited",
      origin: requestOrigin(input),
    });
    throw new Error("Network blocked in fake mode");
  };
}

function globalFetchFor(
  state: HostState,
  route: {
    readonly live: LiveInputs | undefined;
    readonly model: Model<Api>;
    readonly offline: Model<"anthropic-messages"> | undefined;
    readonly realFetch: typeof globalThis.fetch;
    readonly scriptedLane: boolean;
  },
): typeof globalThis.fetch {
  const { live, model, realFetch } = route;
  const block = blockedFetch(state);
  if (!live)
    return route.scriptedLane && route.offline
      ? scriptedLaneFetch(state.recorder, route.offline, block)
      : block;
  return liveFetch({
    state,
    origin: new URL(model.baseUrl).origin,
    endpoint: model.baseUrl,
    ledger: live.ledger,
    realFetch,
    block,
  });
}

/** Writes the given catalog mirrors into an in-memory store, one entry per provider. */
async function seededStore(models: readonly Model<Api>[]): Promise<InMemoryModelsStore> {
  const modelsStore = new InMemoryModelsStore();
  const byProvider = new Map<string, Model<Api>[]>();
  for (const model of models)
    byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model]);
  for (const [provider, list] of byProvider)
    // The runtime prefers a stored catalog only when it is newer than the built-in data.
    await modelsStore.write(provider, {
      models: list,
      checkedAt: Date.now(),
      lastModified: Date.now(),
    });
  return modelsStore;
}

interface CatalogPlan {
  /** Seed every live mirror (not only the live subject). */
  readonly all: boolean;
  /** Isolated copy of the worktree models.json, or null for none. */
  readonly modelsPath: string | null;
}

async function liveRuntime(
  credentials: ReadOnlyMemoryCredentials,
  live: LiveInputs,
  catalog: CatalogPlan,
) {
  await credentials.seedAndSeal(live.provider, live.credential);
  const seeded = catalog.all
    ? LIVE_SEEDED_MODELS
    : LIVE_SEEDED_MODELS.filter(
        (model) => model.provider === live.provider && model.id === live.modelId,
      );
  // Loads the in-memory store; allowModelNetwork=false keeps catalogs off the network.
  const runtime = await ModelRuntime.create({
    credentials,
    modelsStore: await seededStore(seeded),
    allowModelNetwork: false,
    modelsPath: catalog.modelsPath,
  });
  // An extension-owned provider (Synthetic) exists only once its extension
  // registers it; register its static mirror so the live model resolves first.
  const mirror = LIVE_PROVIDER_MIRRORS.get(live.provider);
  if (mirror && !runtime.getModel(live.provider, live.modelId))
    runtime.registerProvider(live.provider, mirror);
  return runtime;
}

async function createRuntime(
  credentials: ReadOnlyMemoryCredentials,
  live: LiveInputs | undefined,
  catalog: CatalogPlan,
) {
  if (live) return liveRuntime(credentials, live, catalog);
  credentials.seal();
  if (catalog.all)
    return ModelRuntime.create({
      credentials,
      modelsStore: await seededStore(LIVE_SEEDED_MODELS),
      allowModelNetwork: false,
      modelsPath: catalog.modelsPath,
    });
  return ModelRuntime.create({
    credentials,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
    modelsPath: null,
  });
}

function liveModel(
  runtime: ModelRuntime,
  live: LiveInputs,
  providerOwnedTransport: boolean,
): Model<Api> {
  const model = runtime.getModel(live.provider, live.modelId);
  if (!model)
    throw new Error(`Live model ${live.launch.model} unavailable in the isolated runtime`);
  if (!isAnthropicModel(model) && !providerOwnedTransport)
    throw new Error("Live driver serves anthropic-messages models only");
  return model;
}

function readLiveSource(options: LaunchOptions): LiveSource | undefined {
  const launch = options.live;
  if (!launch) return undefined;
  const expected = requireLiveRun(options.scenario, launch.model);
  const { provider, modelId } = parseLiveSpec(launch.model);
  const credential = readLiveCredential(provider, launch.sourceAgentDir);
  return { launch, provider, modelId, credential, expected };
}

function trustedSettings(policy: {
  readonly keepRecentTokens: number;
  readonly hostCompaction: boolean;
}): SettingsManager {
  const { keepRecentTokens, hostCompaction } = policy;
  return SettingsManager.inMemory(
    {
      compaction: { enabled: hostCompaction, keepRecentTokens, reserveTokens: 16384 },
      retry: { enabled: false },
      defaultProjectTrust: "always",
      cacheWarming: "off",
      extensions: ["-builtin:codemode"],
    },
    { projectTrusted: true },
  );
}

async function writeConfig(
  dirs: RuntimeDirs,
  sidecarText: string,
  settings: SettingsManager,
  agentSettings: Readonly<Record<string, string>> | undefined,
): Promise<void> {
  const hostSettingsText = `${JSON.stringify(settings.getSettings())}\n`;
  const agentSettingsText =
    agentSettings === undefined
      ? hostSettingsText
      : `${JSON.stringify({ ...settings.getSettings(), ...agentSettings })}\n`;
  const sidecarPath = join(dirs.projectDir, ".pi", "extensions", "background-compaction.json");
  await Promise.all([
    writeFile(sidecarPath, sidecarText, { mode: 0o600 }),
    writeFile(join(dirs.projectDir, ".pi", "settings.json"), hostSettingsText, { mode: 0o600 }),
    writeFile(join(dirs.agentDir, "settings.json"), agentSettingsText, { mode: 0o600 }),
  ]);
}

/**
 * Live parity with a real session on the same credential: the user's
 * `SYSTEM.md` replaces Pi's default harness preamble. Read from the source agent
 * dir (not a secret: it resolves to the tracked profile prompt) and copied into
 * the isolated agent dir; recorded by digest only.
 */
async function copyLiveSystemPrompt(state: HostState, dirs: RuntimeDirs, live: LiveInputs) {
  let text: string;
  try {
    text = await readFile(join(live.launch.sourceAgentDir, "SYSTEM.md"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      state.recorder.record("live-parity", { systemPrompt: "pi-default", builtinTools: true });
      return;
    }
    throw error;
  }
  await writeFile(join(dirs.agentDir, "SYSTEM.md"), text, { mode: 0o600 });
  state.recorder.record("live-parity", {
    systemPrompt: "source-agent-SYSTEM.md",
    systemPromptDigest: digest(text),
    builtinTools: true,
  });
}

function openManager(options: LaunchOptions, dirs: RuntimeDirs): SessionManager {
  if (options.resumeSessionFile === undefined)
    return SessionManager.create(dirs.projectDir, dirs.sessionDir);
  return SessionManager.open(options.resumeSessionFile, dirs.sessionDir, dirs.projectDir);
}

function assistantCount(manager: SessionManager): number {
  return manager
    .getBranch()
    .filter((entry) => entry.type === "message" && entry.message.role === "assistant").length;
}

function stepTool() {
  return defineTool({
    name: STEP_TOOL,
    label: "harness step",
    description: "Deterministic offline tool",
    parameters: Type.Object({ label: Type.String() }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: stepResultText(params.label) }], details: {} };
    },
  });
}

interface ParentSlot {
  pi?: ExtensionAPI;
  ctx?: ExtensionContext;
}

type CapturedInput = Parameters<typeof capturePayload>[2];
type Adoption = Parameters<AdoptedHandler>[0];
type AdoptedHandler = NonNullable<ConsumerSpec["onAdopted"]>;
type ConsumerSpec = Parameters<
  NonNullable<ReturnType<typeof getCoordinator>>["registerConsumer"]
>[0];

function capturePrompt(state: HostState, manager: SessionManager, parsed: CapturedInput): void {
  recordBranch(state.recorder, manager.getBranch());
  const sessionId = manager.getSessionId();
  capturePayload(state.recorder, "before-provider", parsed, state.book.sync(sessionId), sessionId);
}

/** Tail harness extension: deterministic tool and payload capture. */
function harnessFactory(
  state: HostState,
  manager: SessionManager,
  observe: () => void,
  slot: ParentSlot,
): ExtensionFactory {
  return (pi) => {
    slot.pi = pi;
    pi.on("session_start", (_event, ctx) => {
      slot.ctx = ctx;
    });
    pi.registerTool(stepTool());
    // tool-search declares only always-active tools on its first commit; this tail
    // handler runs after it and keeps the harness tool declared.
    pi.on("before_agent_start", () => {
      const active = pi.getActiveTools();
      if (!active.includes(STEP_TOOL)) pi.setActiveTools([...active, STEP_TOOL]);
    });
    pi.on("before_provider_request", (event) => {
      observe();
      capturePrompt(state, manager, Value.Parse(InputSchema, event.payload));
    });
    pi.on("session_compact", (event) => {
      state.recorder.record("session_compact", Value.Parse(InputSchema, event));
    });
  };
}

function worktreeName(path: string): string {
  return relative(WORKTREE, resolve(path)).split("\\").join("/");
}

/** Host-loaded (JITI) extensions must be exactly the plan's host paths. */
function assertHostSet(loadedPaths: readonly string[], plan: WorktreeProfilePlan): void {
  const expected = new Set(plan.hostExtensionPaths.map(worktreeName));
  const loaded = new Set(loadedPaths.map(worktreeName).filter((name) => expected.has(name)));
  if (loaded.size !== expected.size)
    throw new Error(`Worktree host extension set incomplete (${loaded.size}/${expected.size})`);
}

function recordAdoption(state: HostState, ownerKey: string, adoption: Adoption): void {
  state.assertCurrent();
  const evidenceRef = state.recorder.record("consumer-notification", {
    consumer: "harness-recorder",
    ownerKey,
    ...adoption,
  });
  state.recorder.record("recorder-adoption-ref", { evidenceRef });
}

function observeCoordinatorsFor(state: HostState, attached: Set<string>, owned: Owned): void {
  state.assertCurrent();
  for (const coordinator of getRegistry().coordinators.values()) {
    const key = `${coordinator.ownerKey}:${coordinator.ownerGeneration}`;
    state.recorder.record("coordinator-status", statusArtifact(coordinator.status()));
    if (attached.has(key)) continue;
    attached.add(key);
    const onAdopted = (adoption: Adoption) => recordAdoption(state, coordinator.ownerKey, adoption);
    owned.releases.push(coordinator.registerConsumer({ id: "harness-recorder", onAdopted }));
  }
}

function collect(errors: Error[], step: () => void): void {
  try {
    step();
  } catch (cause) {
    errors.push(cause instanceof Error ? cause : new Error("Unexpected cleanup rejection"));
  }
}

async function shutdownSessions(owned: Owned, errors: Error[]): Promise<void> {
  const sessions = [...owned.children, owned.session].filter((session) => session !== undefined);
  const outcomes = await Promise.allSettled(
    sessions.map((session) =>
      session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
    ),
  );
  for (const outcome of outcomes) {
    if (outcome.status === "fulfilled") continue;
    const reason = outcome.reason;
    errors.push(
      reason instanceof Error ? reason : new Error("Unexpected session shutdown rejection"),
    );
  }
}

function dropNewFactories(initial: ReadonlyMap<string, unknown>): void {
  const factories = getRegistry().backendFactories;
  for (const [id] of factories) if (!initial.has(id)) factories.delete(id);
}

function onSessionEvent(state: HostState, event: AgentSessionEvent): void {
  state.recorder.record("session-event", Value.Parse(InputSchema, event));
  if (event.type !== "message_end" || event.message.role !== "assistant") return;
  if (event.message.stopReason !== "aborted") return;
  state.aborts++;
  state.recorder.record("abort", { stopReason: "aborted" });
}

function wrapNotify(state: HostState, session: AgentSession): () => void {
  const ui = session.extensionRunner.getUIContext();
  const original = ui.notify;
  ui.notify = (message, type) => {
    state.recorder.record("ui-notify", { origin: "sdk-shared-no-ui", message, type });
    return original.call(ui, message, type);
  };
  return () => {
    ui.notify = original;
  };
}

function emptyPlan(): WorktreeProfilePlan {
  return { factories: [], hostExtensionPaths: [] };
}

async function loadPlan(options: LaunchOptions): Promise<WorktreeProfilePlan> {
  return options.profile === "worktree" ? loadWorktreeProfilePlan() : emptyPlan();
}

/** Everything a launched host hands to its scenario. */
interface LaunchedParts {
  readonly options: LaunchOptions;
  readonly state: HostState;
  readonly live: LiveInputs | undefined;
  readonly owned: Owned;
  readonly slot: ParentSlot;
  readonly session: AgentSession;
  readonly manager: SessionManager;
  readonly credentials: ReadOnlyMemoryCredentials;
  readonly model: Model<Api>;
  readonly dirs: RuntimeDirs;
  readonly markers: ReturnType<HostState["book"]["attach"]>;
  readonly consumerProbe: ReturnType<typeof installConsumerProbe>;
  readonly adoptionProbe: ReturnType<typeof installAdoptionProbe>;
  readonly reregister: () => void;
  readonly observeCoordinators: () => void;
  readonly cleanup: () => Promise<void>;
}

/** The scenario-facing host handle; every accessor rechecks the launcher is current. */
function launchedHost(parts: LaunchedParts) {
  const { options, state, live, owned, slot, session, manager, dirs } = parts;
  const { consumerProbe, adoptionProbe, reregister, observeCoordinators } = parts;
  const recorder = state.recorder;
  const current = () => state.assertCurrent();
  const mainKey = mainOwnerKey(manager.getSessionId());
  return {
    session,
    manager,
    recorder,
    credentials: parts.credentials,
    mode: live ? ("live" as const) : ("fake" as const),
    /** Live launch inputs (model, source agent dir) for fresh-process workers. */
    live: options.live === undefined ? undefined : { ...options.live },
    /** Live: provider/model actually served; fake: the offline fixture. */
    model: `${parts.model.provider}/${parts.model.id}`,
    /** Waits for every in-flight usage read, then returns the real-usage ledger. */
    usage: async () => {
      if (!live) return undefined;
      await live.ledger.drain();
      return live.ledger.report();
    },
    /** Memory-only credential strings no artifact may contain. */
    protectedSecrets: () => (live ? credentialSecrets(live.credential) : []),
    root: dirs.root,
    /** Redacted artifact directory for this run (the CLI's --out), if any. */
    artifactDir: options.failureOut,
    agentDir: dirs.agentDir,
    projectDir: dirs.projectDir,
    sessionFile: () => manager.getSessionFile(),
    markers: parts.markers,
    wire: state.wire,
    parent: () => {
      current();
      if (!slot.pi || !slot.ctx) throw new Error("Parent extension context unavailable");
      return { pi: slot.pi, ctx: slot.ctx };
    },
    isCurrent: () => !state.disposed,
    registerChild: (child: AgentSession) => {
      current();
      owned.children.add(child);
      state.book.attach(child.sessionManager);
    },
    unregisterChild: (id: string, child: AgentSession) => {
      owned.children.delete(child);
      state.book.detach(id);
    },
    requestBranches: state.requestBranches,
    mainCoordinator: () => {
      current();
      return getCoordinator(mainKey);
    },
    coordinatorFor: (ownerKey: string) => {
      current();
      return getCoordinator(ownerKey);
    },
    setForegroundObserver: (observer: ForegroundObserver | undefined) => {
      current();
      state.foregroundObserver = observer;
    },
    setResponseOverride: (override: ResponseOverride | undefined) => {
      current();
      state.responseOverride = override;
    },
    /** Offline: `usage.input_tokens` of default foreground responses (undefined restores 10). */
    setReportedInputTokens: (tokens: number | undefined) => {
      current();
      state.reportedInputTokens = tokens;
    },
    reload: async () => {
      current();
      await session.reload();
      current();
      reregister();
      observeCoordinators();
    },
    notifications: consumerProbe.notifications,
    consumerRegistrations: consumerProbe.registrations,
    adoptionNotices: adoptionProbe.notices,
    signalConsumers: adoptionProbe.consumers,
    signalRegistrations: adoptionProbe.registrations,
    networkCalls: () => state.networkCalls,
    aborts: () => state.aborts,
    observeCoordinators,
    snapshot: () => {
      current();
      return recordBranch(recorder, manager.getBranch());
    },
    cleanup: parts.cleanup,
  };
}

export async function launch(input: LaunchOptions) {
  const options = copyOptions(input);
  if (launcherActive)
    throw new Error("Launchers require isolated processes; global fetch/env are scoped");
  if (!Value.Check(BackgroundCompactionSidecarSchema, options.settings ?? {}))
    throw new Error("Invalid scenario sidecar");
  // Read once, before scoping, so the Recorder redacts the credential from the start.
  const source = readLiveSource(options);
  launcherActive = true;
  const state = new HostState(new Recorder(protectedStringsOf(source?.credential)));
  const recorder = state.recorder;
  const live: LiveInputs | undefined = source && {
    ...source,
    ledger: new LiveLedger(recorder, source.expected),
  };
  const realFetch = globalThis.fetch;
  const consumerProbe = installConsumerProbe(recorder);
  const adoptionProbe = installAdoptionProbe(recorder);
  const initialFactories = new Map(getRegistry().backendFactories);
  const owned = new Owned();
  const attached = new Set<string>();
  const observeCoordinators = () => observeCoordinatorsFor(state, attached, owned);
  const current = () => state.assertCurrent();

  function stopOwnedCoordinators(errors: Error[]): void {
    for (const coordinator of consumerProbe.ownedCoordinators)
      collect(errors, () => {
        coordinator.dispose();
        release(coordinator.ownerKey, coordinator.ownerGeneration, coordinator);
      });
  }

  function releaseAll(errors: Error[]): void {
    const steps = [
      ...[...owned.releases].reverse(),
      () => dropNewFactories(initialFactories),
      () => consumerProbe.dispose(),
      () => adoptionProbe.dispose(),
      ...[...owned.children].map((child) => () => child.dispose()),
      () => owned.session?.dispose(),
    ];
    for (const step of steps) collect(errors, step);
  }

  async function releaseRuntime(): Promise<void> {
    owned.env?.restore();
    launcherActive = false;
    owned.children.clear();
    const dirs = owned.dirs;
    if (!dirs || !dirs.created || options.preserveRuntime === true) return;
    await rm(dirs.root, { recursive: true, force: true });
  }

  async function cleanup(): Promise<void> {
    if (state.disposed) return;
    state.disposed = true;
    const errors: Error[] = [];
    stopOwnedCoordinators(errors);
    try {
      await shutdownSessions(owned, errors);
      releaseAll(errors);
    } finally {
      await releaseRuntime();
    }
    if (errors.length) throw new AggregateError(errors, "Harness cleanup failed");
  }

  try {
    const dirs = await prepareRuntimeDirs(options.scratchRoot, options.runtimeRoot);
    owned.dirs = dirs;
    current();
    owned.env = scopeProcessEnv(dirs, blockedFetch(state));
    const sidecar = { ...DEFAULT_BACKGROUND_COMPACTION_SETTINGS, ...options.settings };
    const problem = crossFieldProblem(sidecar);
    if (problem) throw new Error(`Scenario sidecar rejected by production policy: ${problem}`);
    // Offline Anthropic mirror: the background native lane or the foreground server-side path.
    const anthropic = sidecar.anthropicNative || options.anthropicForeground === true;
    const apiKey = anthropic ? FAKE_ANTHROPIC_KEY : FAKE_OFFLINE_KEY;
    const sidecarText = JSON.stringify(sidecar);
    const settings = trustedSettings({
      keepRecentTokens: options.keepRecentTokens ?? 1,
      hostCompaction: options.hostCompaction ?? false,
    });
    await writeConfig(dirs, sidecarText, settings, options.agentSettings);
    const catalog: CatalogPlan = {
      all: options.catalog === true,
      modelsPath: options.catalog === true ? join(dirs.agentDir, "models.json") : null,
    };
    // The real agent dir's models.json is a symlink to the worktree copy.
    if (catalog.modelsPath !== null)
      await copyFile(join(WORKTREE, ".pi", "models.json"), catalog.modelsPath);
    if (live) await copyLiveSystemPrompt(state, dirs, live);
    current();
    const credentials = new ReadOnlyMemoryCredentials();
    const runtime = await createRuntime(credentials, live, catalog);
    current();
    const offline: Model<"anthropic-messages"> | undefined = live
      ? undefined
      : anthropic
        ? FAKE_ANTHROPIC_MODEL
        : (options.offlineModel ?? FAKE_MODEL);
    const model: Model<Api> = live
      ? liveModel(runtime, live, options.providerOwnedTransport === true)
      : (offline ?? FAKE_MODEL);
    globalThis.fetch = globalFetchFor(state, {
      live,
      model,
      offline,
      realFetch,
      scriptedLane: options.anthropicForeground === true,
    });
    const modelRegistry = new ModelRegistry(runtime);
    const manager = openManager(options, dirs);
    state.mainSessionId = manager.getSessionId();
    // A resumed session continues the request index, keeping labels unique.
    state.requestCounts.set(state.mainSessionId, assistantCount(manager));
    const markers = state.book.attach(manager);
    if (options.resumeSessionFile === undefined)
      markers.push(
        ...seedPrefix(manager, {
          namespace: options.seedNamespace,
          bytes: options.seedBytes,
          toolResults: options.seedToolResults,
          model,
        }),
      );
    state.issuedSignatures.add(NATIVE_SIGNATURE);
    if (sidecar.text) owned.releases.push(installTextFakeFactory(recorder, modelRegistry));
    // Live: production's default native factory, capture and lane transport run unmodified.
    if (sidecar.anthropicNative && offline)
      owned.releases.push(installAnthropicFakeFactory(recorder, offline, apiKey));
    const reregister = !offline
      ? () => {}
      : registerOfflineProvider(runtime, {
          state,
          model: offline,
          apiKey,
          nativeCapture: anthropic,
          toolCycles: options.cycles ?? 2,
        });
    const plan = await loadPlan(options);
    current();
    const slot: ParentSlot = {};
    const loader = new DefaultResourceLoader({
      cwd: dirs.projectDir,
      agentDir: dirs.agentDir,
      settingsManager: settings,
      noExtensions: options.profile !== "worktree",
      additionalExtensionPaths: plan.hostExtensionPaths,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        ...plan.factories.map((entry) => entry.factory),
        harnessFactory(state, manager, observeCoordinators, slot),
        ...(options.factories ?? []),
      ],
    });
    await loader.reload();
    current();
    const extensions = loader.getExtensions();
    if (extensions.errors.length) {
      recorder.record("extension-load-errors", Value.Parse(InputSchema, extensions.errors));
      throw new Error(`Extension load failed (${extensions.errors.length} errors)`);
    }
    const loadedPaths = extensions.extensions.map((extension) => extension.path);
    assertHostSet(loadedPaths, plan);
    recorder.record("configuration", {
      profile: options.profile ?? "boundary-only",
      sidecar,
      sidecarHash: digest(sidecarText),
      model: { provider: model.provider, id: model.id },
      nativeFactories: plan.factories.map((entry) => worktreeName(entry.path)),
      hostExtensions: plan.hostExtensionPaths.map(worktreeName),
      loadedExtensions: loadedPaths,
    });
    const { session } = await createAgentSession({
      cwd: dirs.projectDir,
      agentDir: dirs.agentDir,
      model,
      modelRuntime: runtime,
      thinkingLevel: sidecar.anthropicNative ? "medium" : "off",
      resourceLoader: loader,
      sessionManager: manager,
      settingsManager: settings,
      // Live keeps the built-in tools a real session declares (parity); offline omits them.
      noTools: live ? undefined : "builtin",
    });
    owned.session = session;
    current();
    owned.releases.push(session.subscribe((event) => onSessionEvent(state, event)));
    owned.releases.push(wrapNotify(state, session));
    await session.bindExtensions({
      onError: (error) => {
        recorder.record("extension-error", Value.Parse(InputSchema, error));
      },
    });
    current();
    reregister();
    observeCoordinators();
    return launchedHost({
      options,
      state,
      live,
      owned,
      slot,
      session,
      manager,
      credentials,
      model,
      dirs,
      markers,
      consumerProbe,
      adoptionProbe,
      reregister,
      observeCoordinators,
      cleanup,
    });
  } catch (error) {
    recorder.record("launcher-failure", {
      name: error instanceof Error ? error.name : "Unknown",
      message: error instanceof Error ? error.message : "Unexpected launcher failure",
    });
    if (options.failureOut)
      await writeArtifact(
        options.failureOut,
        "launcher-failure.json",
        Value.Parse(InputSchema, recorder.records),
      );
    await cleanup();
    throw error;
  }
}
