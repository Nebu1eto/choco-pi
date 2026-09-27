/**
 * Real pi-coding-agent host for the "On usage limit" end-to-end tests: a parent
 * `AgentSession` with scripted fake providers registered under the real
 * provider ids (`openai-codex`, `anthropic`), an isolated agent dir, project
 * dir and session dir, and a network guard that records and refuses `fetch`.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

import type { OnUsageLimit } from "../../.pi/extensions/lib/usage-limit-contract.ts";
import {
  isFunction,
  isJsonRecord,
  isString,
  reinterpretHostValue,
  type RuntimeValue,
} from "../../.pi/extensions/lib/runtime-values.ts";
import type { AgentRecord } from "../../.pi/packages/choco-pi-subagents/src/types.ts";

// SAFETY: Custom provider API identifiers are runtime strings accepted by registerProvider.
const E2E_API = "usage-limit-e2e-api" as Api;

function fakeModel(provider: string, id: string): Model<Api> {
  return {
    id,
    name: id,
    api: E2E_API,
    provider,
    baseUrl: "http://127.0.0.1.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 2_000,
  };
}

export const CODEX_MODEL = fakeModel("openai-codex", "e2e-codex");
export const CLAUDE_MODEL = fakeModel("anthropic", "e2e-claude");
/** Registered and authenticated, but excluded from `enabledModels` when scope is on. */
export const OUTSIDE_MODEL = fakeModel("e2e-outside", "e2e-outside");
const FAKE_MODELS = [CODEX_MODEL, CLAUDE_MODEL, OUTSIDE_MODEL];

export const CODEX_LIMIT_TEXT = "Codex usage limit reached (plus plan). Resets in ~5m.";
export const ANTHROPIC_LIMIT_TEXT =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"Error"}}';

export const E2E_AGENT_TYPE = "e2e-worker";

export type ScriptedReply = { kind: "text"; text: string } | { kind: "error"; message: string };

export type ProviderRequest = {
  provider: string;
  modelId: string;
  /**
   * Text of the last non-assistant message in the request context, skipping the
   * `<system-reminder>` status message the subagents runner appends to child turns.
   */
  lastText: string;
};

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function messageText(content: Context["messages"][number]["content"]): string {
  if (isString(content)) return content;
  return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function assistantMessage(model: Model<Api>, reply: ScriptedReply): AssistantMessage {
  return {
    role: "assistant",
    content: reply.kind === "text" ? [{ type: "text", text: reply.text }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: reply.kind === "text" ? "stop" : "error",
    ...(reply.kind === "error" && { errorMessage: reply.message }),
    timestamp: Date.now(),
  };
}

function replyStream(model: Model<Api>, reply: ScriptedReply) {
  const stream = createAssistantMessageEventStream();
  const message = assistantMessage(model, reply);
  stream.push({ type: "start", partial: message });
  if (reply.kind === "text") {
    stream.push({ type: "text_start", contentIndex: 0, partial: message });
    stream.push({ type: "text_end", contentIndex: 0, content: reply.text, partial: message });
    stream.push({ type: "done", reason: "stop", message });
  } else {
    stream.push({ type: "error", reason: "error", error: message });
  }
  stream.end();
  return stream;
}

/** Scripted per-model replies; an empty script answers `ok`. */
export class ScriptedProviders {
  readonly requests: ProviderRequest[] = [];
  private readonly scripts = new Map<string, ScriptedReply[]>();

  script(model: Model<Api>, ...replies: ScriptedReply[]): void {
    const key = modelKey(model);
    this.scripts.set(key, [...(this.scripts.get(key) ?? []), ...replies]);
  }

  requestsFor(model: Model<Api>): ProviderRequest[] {
    return this.requests.filter(
      (request) => request.provider === model.provider && request.modelId === model.id,
    );
  }

  private readonly providerIds: readonly string[];

  constructor(providerIds: readonly string[]) {
    this.providerIds = providerIds;
  }

  readonly factory: ExtensionFactory = (pi) => {
    for (const provider of this.providerIds) {
      pi.registerProvider(provider, {
        baseUrl: "http://127.0.0.1.invalid",
        apiKey: "inert",
        api: E2E_API,
        authHeader: false,
        models: FAKE_MODELS.filter((model) => model.provider === provider),
        streamSimple: (activeModel, context) => {
          const prompts = context.messages
            .filter((message) => message.role !== "assistant")
            .map((message) => messageText(message.content))
            .filter((text) => !text.startsWith("<system-reminder>"));
          this.requests.push({
            provider: activeModel.provider,
            modelId: activeModel.id,
            lastText: prompts.at(-1) ?? "",
          });
          const reply = this.scripts.get(modelKey(activeModel))?.shift() ?? {
            kind: "text",
            text: "ok",
          };
          return replyStream(activeModel, reply);
        },
      });
    }
  };
}

type ManagerRegistry = {
  getRecord(id: string): AgentRecord | undefined;
};

/** The subagents manager registry entry published under `pi-subagents:manager`. */
export function managerRegistry(): ManagerRegistry {
  const slots = reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(globalThis);
  const entry = slots[Symbol.for("pi-subagents:manager")];
  if (!isJsonRecord(entry) || !isFunction(entry.getRecord)) {
    throw new Error("pi-subagents:manager registry is not published.");
  }
  return reinterpretHostValue<ManagerRegistry>(entry);
}

/** Keys of the process-global usage-limit policy map, or undefined when absent. */
export function usageLimitPolicyOwners(): string[] | undefined {
  const slots = reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(globalThis);
  const map = slots[Symbol.for("choco-pi.usage-limit-policy")];
  if (!(map instanceof Map)) return undefined;
  return [...reinterpretHostValue<Map<string, RuntimeValue>>(map).keys()];
}

export type UsageLimitE2eOptions = {
  preference: OnUsageLimit;
  parentModel: Model<Api>;
  /** Parent-session extensions loaded before the capture extension. */
  factories: readonly ExtensionFactory[];
  /** Parent-session retry settings (defaults to retries disabled). */
  retry?: { enabled: boolean; maxRetries?: number; baseDelayMs?: number };
  /** `<cwd>/.pi/subagents.json` contents. */
  subagentsSettings?: Record<string, RuntimeValue>;
  /** `<cwd>/.pi/settings.json` contents (child sessions and scope checks). */
  projectSettings?: Record<string, RuntimeValue>;
  /** Extra files under `<cwd>/.pi/extensions/`, keyed by file name. */
  projectExtensions?: Record<string, string>;
  /** Fake providers neither registered nor given credentials. */
  omitProviders?: readonly string[];
};

/** Real provider credentials in the caller's shell would authenticate built-in providers. */
const SCRUBBED_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "SYNTHETIC_API_KEY",
] as const;

export type UsageLimitE2e = {
  root: string;
  cwd: string;
  agentDir: string;
  session: AgentSession;
  pi: ExtensionAPI;
  providers: ScriptedProviders;
  /** Payloads of `subagents:usage_limit` events on the parent event bus. */
  usageEvents: RuntimeValue[];
  /** URLs passed to the guarded `fetch`; every call is refused. */
  fetchCalls: string[];
  close(): Promise<void>;
};

const FALLBACK_OVERRIDE = {
  tiers: {
    e2e: { primary: [modelKey(CLAUDE_MODEL), modelKey(CODEX_MODEL)], secondary: [] },
  },
  lastResort: [],
};

const AGENT_FILE = `---
description: Usage-limit end-to-end worker
default_model: ${modelKey(CODEX_MODEL)}
prompt_mode: replace
extensions: true
skills: false
output_transcript: false
---

Answer the task in one line.
`;

/**
 * Builds the host. Changes the process cwd (the subagents extension reads its
 * agents and settings from `process.cwd()`), `PI_CODING_AGENT_DIR`,
 * `PI_CODING_AGENT_SESSION_DIR` and `globalThis.fetch`; `close()` restores all.
 */
export async function createUsageLimitE2e(options: UsageLimitE2eOptions): Promise<UsageLimitE2e> {
  const root = await mkdtemp(join(tmpdir(), "choco-usage-limit-e2e-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const sessionDir = join(root, "sessions");
  const projectPi = join(cwd, ".pi");
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(join(projectPi, "agents"), { recursive: true }),
    mkdir(join(projectPi, "extensions"), { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ agentOnUsageLimit: options.preference }),
    ),
    writeFile(join(agentDir, "model-fallbacks.json"), JSON.stringify(FALLBACK_OVERRIDE)),
    writeFile(join(projectPi, "agents", `${E2E_AGENT_TYPE}.md`), AGENT_FILE),
    writeFile(join(projectPi, "subagents.json"), JSON.stringify(options.subagentsSettings ?? {})),
    writeFile(join(projectPi, "settings.json"), JSON.stringify(options.projectSettings ?? {})),
    ...Object.entries(options.projectExtensions ?? {}).map(([name, source]) =>
      writeFile(join(projectPi, "extensions", name), source),
    ),
  ]);

  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  const previousFetch = globalThis.fetch;
  const previousEnv = SCRUBBED_ENV.map((name) => [name, process.env[name]] as const);
  const fetchCalls: string[] = [];
  for (const name of SCRUBBED_ENV) delete process.env[name];
  process.chdir(cwd);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  globalThis.fetch = async (input) => {
    fetchCalls.push(input instanceof Request ? input.url : String(input));
    throw new Error("Network access is disabled in usage-limit end-to-end tests.");
  };
  const restore = (): void => {
    globalThis.fetch = previousFetch;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
    for (const [name, value] of previousEnv) {
      if (value !== undefined) process.env[name] = value;
    }
    process.chdir(previousCwd);
  };

  try {
    const omitted = new Set(options.omitProviders ?? []);
    const providerIds = [...new Set(FAKE_MODELS.map((model) => model.provider))].filter(
      (provider) => !omitted.has(provider),
    );
    const providers = new ScriptedProviders(providerIds);
    const usageEvents: RuntimeValue[] = [];
    let captured: ExtensionAPI | undefined;
    const capture: ExtensionFactory = (pi) => {
      captured = pi;
      pi.events.on("subagents:usage_limit", (payload) => {
        usageEvents.push(reinterpretHostValue<RuntimeValue>(payload));
      });
    };
    const settings = SettingsManager.inMemory({
      retry: options.retry ?? { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [providers.factory, ...options.factories, capture],
    });
    await loader.reload();
    const credentials = new InMemoryCredentialStore();
    for (const provider of providerIds) {
      await credentials.modify(provider, async () => ({ type: "api_key", key: "inert" }));
    }
    const modelRuntime = await ModelRuntime.create({
      credentials,
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
      refreshOnCreate: false,
      modelsPath: null,
    });
    const { session } = await createAgentSession({
      cwd,
      model: options.parentModel,
      modelRuntime,
      resourceLoader: loader,
      sessionManager: SessionManager.create(cwd, sessionDir),
      settingsManager: settings,
      noTools: "all",
    });
    await session.bindExtensions({});
    const pi = captured;
    if (!pi) throw new Error("Capture extension did not initialise.");
    return {
      root,
      cwd,
      agentDir,
      session,
      pi,
      providers,
      usageEvents,
      fetchCalls,
      close: async () => {
        try {
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
          session.dispose();
        } finally {
          restore();
          await rm(root, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    restore();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/** Polls `predicate` every 5 ms until it holds or `timeoutMs` passes. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
  label = "test condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

export async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

type ToolResult = { content: readonly { type: string; text?: string }[] };

export function resultText(result: ToolResult): string {
  return result.content.flatMap((item) => (item.text === undefined ? [] : [item.text])).join("\n");
}

let toolCallCounter = 0;

/** Executes a registered extension tool on the parent session. */
export async function runTool(
  session: AgentSession,
  name: string,
  params: Record<string, RuntimeValue>,
): Promise<ToolResult> {
  const definition = session.extensionRunner.getToolDefinition(name);
  if (!definition) throw new Error(`Tool ${name} is not registered.`);
  toolCallCounter += 1;
  const toolCallId = "usage-limit-e2e-" + String(toolCallCounter);
  return definition.execute(
    toolCallId,
    params,
    new AbortController().signal,
    () => undefined,
    session.extensionRunner.createContext(),
  );
}

/** Custom message entries of `customType` on the parent session. */
export function customEntries(session: AgentSession, customType: string): RuntimeValue[] {
  return session.sessionManager
    .getEntries()
    .filter(
      (entry) =>
        (entry.type === "custom_message" || entry.type === "custom") &&
        entry.customType === customType,
    );
}
