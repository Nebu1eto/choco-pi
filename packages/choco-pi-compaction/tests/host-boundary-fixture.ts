import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
  type Usage,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type CompactionEntry,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  type ExtensionFactory,
  ModelRuntime,
  type SessionEntry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { obj, str } from "@earendil-works/pi-schema";

import { hostParams } from "./schema-bridge.ts";

const FAKE_PROVIDER = "fake-provider";
const FAKE_API_KEY = "non-secret-placeholder";
const SUMMARIZER_MARKER = "context summarization assistant";
export const PREFIX_A = "SEED-PREFIX-A";
const PREFIX_B = "SEED-PREFIX-B";
const PREFIX_C = "SEED-PREFIX-C";

export function fakeModel(contextWindow = 200_000): Model<"anthropic-messages"> {
  return {
    id: "fake-model",
    name: "Fake model",
    api: "anthropic-messages",
    provider: FAKE_PROVIDER,
    baseUrl: "https://fake-provider.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 1_000,
  };
}

function usageOf(input: number): Usage {
  return {
    input,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

interface ReplyOptions {
  readonly tool?: boolean;
  readonly usageInput?: number;
  readonly errorMessage?: string;
}

export function reply(text: string, options: ReplyOptions = {}): AssistantMessage {
  const model = fakeModel();
  const message: AssistantMessage = {
    role: "assistant",
    content: options.tool
      ? [
          { type: "text", text },
          { type: "toolCall", id: `call-${text}`, name: "step", arguments: { label: text } },
        ]
      : [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usageOf(options.usageInput ?? 10),
    stopReason: options.errorMessage ? "error" : options.tool ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
  if (options.errorMessage) message.errorMessage = options.errorMessage;
  return message;
}

export type Responder = (index: number, context: TranscriptContext) => Promise<AssistantMessage>;

interface HostCompactionSettings {
  readonly enabled: boolean;
  readonly keepRecentTokens: number;
  readonly reserveTokens: number;
}

export interface HostOptions {
  readonly extensions: readonly ExtensionFactory[];
  readonly respond?: Responder;
  readonly persistent?: boolean;
  readonly compaction?: HostCompactionSettings;
  readonly contextWindow?: number;
  readonly baseUrl?: string;
  readonly dir?: string;
  readonly manager?: SessionManager;
  readonly modelIdentity?: { readonly api: Api; readonly provider: string; readonly id: string };
}

export interface Host {
  readonly session: AgentSession;
  readonly manager: SessionManager;
  readonly calls: TranscriptContext[];
  readonly summarizerCalls: TranscriptContext[];
  readonly events: string[];
  aborts(): number;
  dispose(): Promise<void>;
}

const STEP_TOOL = defineTool({
  name: "step",
  label: "step",
  description: "deterministic step",
  parameters: hostParams(obj({ label: str() })),
  async execute(_id, params) {
    return { content: [{ type: "text", text: `result-${params.label}` }], details: {} };
  },
});

interface ProviderLog {
  readonly calls: TranscriptContext[];
  readonly summarizerCalls: TranscriptContext[];
  aborts: number;
  mainIndex: number;
}

interface MainStream {
  readonly stream: AssistantMessageEventStream;
  settled: boolean;
}

function abortedReply(): AssistantMessage {
  const aborted: AssistantMessage = { ...reply(""), content: [], stopReason: "aborted" };
  aborted.errorMessage = "Request was aborted";
  return aborted;
}

function settleWithReply(main: MainStream, message: AssistantMessage): void {
  if (main.settled) return;
  main.settled = true;
  if (message.stopReason === "stop" || message.stopReason === "toolUse") {
    main.stream.push({ type: "done", reason: message.stopReason, message });
    return;
  }
  main.stream.push({ type: "error", reason: "error", error: { ...message, stopReason: "error" } });
}

function settleWithFailure(main: MainStream, error: Error): void {
  if (main.settled) return;
  main.settled = true;
  const failed = reply(error.message, { errorMessage: error.message });
  main.stream.push({ type: "error", reason: "error", error: failed });
}

function answerSummarizer(): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "done", reason: "stop", message: reply("HOST-SUMMARY") });
  });
  return stream;
}

function streamMain(
  log: ProviderLog,
  respond: Responder,
  request: { readonly context: TranscriptContext; readonly signal: AbortSignal | undefined },
): AssistantMessageEventStream {
  const main: MainStream = { stream: createAssistantMessageEventStream(), settled: false };
  const index = log.mainIndex++;
  const onAbort = (): void => {
    log.aborts++;
    if (main.settled) return;
    main.settled = true;
    main.stream.push({ type: "error", reason: "aborted", error: abortedReply() });
  };
  request.signal?.addEventListener("abort", onAbort, { once: true });
  void respond(index, request.context).then(
    (message) => {
      request.signal?.removeEventListener("abort", onAbort);
      settleWithReply(main, message);
    },
    (error: Error) => settleWithFailure(main, error),
  );
  return main.stream;
}

function scriptedStream(log: ProviderLog, respond: Responder) {
  return (
    _model: Model<string>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const snapshot = structuredClone(context);
    log.calls.push(snapshot);
    if (getCurrentSystemPrompt(context.messages).includes(SUMMARIZER_MARKER)) {
      log.summarizerCalls.push(snapshot);
      return answerSummarizer();
    }
    return streamMain(log, respond, { context, signal: options?.signal });
  };
}

function seededManager(dir: string, persistent: boolean): SessionManager {
  const manager = persistent ? SessionManager.create(dir, dir) : SessionManager.inMemory(dir);
  manager.appendMessage({ role: "user", content: PREFIX_A, timestamp: Date.now() });
  manager.appendMessage(reply(PREFIX_B));
  manager.appendMessage({ role: "user", content: PREFIX_C, timestamp: Date.now() });
  return manager;
}

async function createRuntime(
  model: Model<Api>,
  stream: ReturnType<typeof scriptedStream>,
): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
    modelsPath: null,
  });
  runtime.registerProvider(model.provider, {
    api: model.api,
    apiKey: FAKE_API_KEY,
    models: [model],
    streamSimple: stream,
  });
  return runtime;
}

async function createLoader(
  dir: string,
  settings: SettingsManager,
  extensions: readonly ExtensionFactory[],
): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [(pi) => pi.registerTool(STEP_TOOL), ...extensions],
  });
  await loader.reload();
  return loader;
}

export async function createHost(options: HostOptions): Promise<Host> {
  const ownsDir = options.dir === undefined;
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "choco-pi-compaction-host-")));
  const model: Model<Api> = { ...fakeModel(options.contextWindow), ...options.modelIdentity };
  if (options.baseUrl !== undefined) model.baseUrl = options.baseUrl;
  const log: ProviderLog = { calls: [], summarizerCalls: [], aborts: 0, mainIndex: 0 };
  const respond = options.respond ?? (async (index: number) => reply(`R${index}`));
  const runtime = await createRuntime(model, scriptedStream(log, respond));
  const compaction = options.compaction ?? {
    enabled: false,
    keepRecentTokens: 1,
    reserveTokens: 16_384,
  };
  const settings = SettingsManager.inMemory({ compaction, retry: { enabled: false } });
  const loader = await createLoader(dir, settings, options.extensions);
  const manager = options.manager ?? seededManager(dir, options.persistent === true);
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    model,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: manager,
    settingsManager: settings,
    noTools: "builtin",
  });
  await session.bindExtensions({});
  const events: string[] = [];
  session.subscribe((event) => {
    events.push(event.type);
  });
  return {
    session,
    manager,
    calls: log.calls,
    summarizerCalls: log.summarizerCalls,
    events,
    aborts: () => log.aborts,
    async dispose() {
      session.dispose();
      if (ownsDir) await rm(dir, { recursive: true, force: true });
    },
  };
}

export function mentions(context: TranscriptContext | undefined, text: string): boolean {
  return JSON.stringify(context?.messages ?? []).includes(text);
}

export function compactionEntries(entries: readonly SessionEntry[]): CompactionEntry[] {
  return entries.filter((entry): entry is CompactionEntry => entry.type === "compaction");
}
