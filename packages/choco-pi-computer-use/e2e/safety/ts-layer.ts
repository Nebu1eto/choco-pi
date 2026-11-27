import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createExtensionRuntime,
  type AgentToolResult,
  type ExtensionContext,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { isJsonObject, isString, type JsonObject, type JsonValue } from "../../src/json.ts";

async function createContext(cwd: string): Promise<ExtensionContext> {
  const runtime = await ModelRuntime.create({
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async () => undefined,
      delete: async () => undefined,
    },
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const runner = new ExtensionRunner(
    [],
    createExtensionRuntime(),
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(runtime),
  );
  return runner.createContext();
}

export interface ToolOutcome {
  text: string;
  details?: JsonValue;
  error?: string;
}

const DROPPED_KEYS = new Set([
  "outline",
  "image",
  "images",
  "jpegBase64",
  "screenshot",
  "tree",
  "nodes",
]);

export function sanitize(value: JsonValue | undefined): JsonValue | undefined {
  if (Array.isArray(value)) return value.map((item) => sanitize(item) ?? null);
  if (!isJsonObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (DROPPED_KEYS.has(key)) continue;
    out[key] = sanitize(item);
  }
  return out;
}

function textOf<T>(result: AgentToolResult<T>): string {
  return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function detailsOf<T>(result: AgentToolResult<T>): JsonValue | undefined {
  const raw = JSON.stringify(result.details ?? null);
  const parsed: JsonValue = JSON.parse(raw);
  return parsed;
}

export interface TsLayer {
  find(params: { pid: number }, signal: AbortSignal): Promise<ToolOutcome>;
  observe(root: string, signal: AbortSignal): Promise<ToolOutcome>;
  act(stateId: string, ref: string, signal: AbortSignal): Promise<ToolOutcome>;
  reset(): Promise<void>;
}

export interface TsEnv {
  socket: string;
  helperApp: string;
  foregroundGrant: string;
  agentDir: string;
  cwd: string;
}

export async function loadTsLayer(env: TsEnv): Promise<TsLayer> {
  process.env.PI_CU_SOCKET_PATH = env.socket;
  process.env.PI_COMPUTER_USE_HELPER_APP_PATH = env.helperApp;
  process.env.PI_COMPUTER_USE_FOREGROUND_GRANT = env.foregroundGrant;
  process.env.PI_CODING_AGENT_DIR = env.agentDir;
  process.env.PI_COMPUTER_USE_HEADLESS = "0";
  process.env.PI_COMPUTER_USE_BROWSER_USE = "0";
  process.env.PI_COMPUTER_USE_RESTORE_FOCUS = "1";
  delete process.env.PI_COMPUTER_USE_DELIVERY_POLICY;
  delete process.env.PI_COMPUTER_USE_EVENT_DELIVERY;
  delete process.env.PI_COMPUTER_USE_FOREGROUND_PROMPT;
  await mkdir(env.agentDir, { recursive: true });
  await mkdir(join(env.cwd, ".pi"), { recursive: true });
  const helper = await import("../../src/platform/macos/helper.ts");
  if (helper.HELPER_SOCKET_PATH !== env.socket)
    throw new Error(`TS helper socket is ${helper.HELPER_SOCKET_PATH}, expected ${env.socket}`);
  const bridge = await import("../../src/bridge.ts");
  const permissions = await import("../../src/platform/macos/permissions.ts");
  let ctx: ExtensionContext | undefined;
  const context = async (): Promise<ExtensionContext> => {
    ctx ??= await createContext(env.cwd);
    return ctx;
  };
  const run = async <T>(call: () => Promise<AgentToolResult<T>>): Promise<ToolOutcome> => {
    try {
      const result = await call();
      return { text: textOf(result), details: sanitize(detailsOf(result)) };
    } catch (error) {
      return { text: "", error: error instanceof Error ? error.message : String(error) };
    }
  };
  return {
    find: async (params, signal) =>
      run(async () =>
        bridge.executeFind("safety-find", params, signal, undefined, await context()),
      ),
    observe: async (root, signal) =>
      run(async () =>
        bridge.executeObserve("safety-observe", { root }, signal, undefined, await context()),
      ),
    act: async (stateId, ref, signal) =>
      run(async () =>
        bridge.executeAct(
          `safety-act-${ref}`,
          { stateId, actions: [{ action: "click", ref }] },
          signal,
          undefined,
          await context(),
        ),
      ),
    reset: async () => {
      await bridge.shutdownComputerUseSession().catch(() => undefined);
      await permissions.releaseMacosOwnership(AbortSignal.timeout(1_000)).catch(() => false);
      ctx = undefined;
    },
  };
}

export function rootRef(outcome: ToolOutcome, title: string): string | undefined {
  const details = outcome.details;
  if (!isJsonObject(details) || !Array.isArray(details.windows)) return undefined;
  for (const window of details.windows) {
    if (isJsonObject(window) && window.windowTitle === title && isString(window.windowRef))
      return window.windowRef;
  }
  return undefined;
}

export function stateIdOf(outcome: ToolOutcome): string | undefined {
  return /\bstate(?:_id)? ([0-9a-f-]{36})\b/i.exec(outcome.text)?.[1];
}

export function elementRef(outcome: ToolOutcome, label: string): string | undefined {
  for (const line of outcome.text.split("\n")) {
    const match = /^\s*(@e\d+)\b/.exec(line);
    if (match?.[1] && line.includes(label)) return match[1];
  }
  return undefined;
}
