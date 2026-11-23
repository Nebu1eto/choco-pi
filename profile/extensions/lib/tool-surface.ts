import {
  DefaultResourceLoader,
  getAgentDir,
  type ExtensionAPI,
  type InlineExtension,
  SettingsManager,
  type ToolExposure,
} from "@earendil-works/pi-coding-agent";
import { createToolSearchToolDefinition } from "./tool-search-tool.ts";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";

export const ALWAYS_ACTIVE_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "exec",
  "wait",
  "apply_patch",
  "exec_command",
  "write_stdin",
  "shell_start",
  "shell_read",
  "find",
  "ls",
  "Agent",
  "get_subagent_result",
  "steer_subagent",
  "stop_subagent",
  "tool_search",
  "agent_browser",
  "view_image",
  "image_gen__imagegen",
] as const;

export const LEAN_SURFACE_SYMBOL = Symbol.for("choco-pi.tool-search.lean-surface");

export interface LeanSurfacePolicy {
  alwaysActive: () => string[];
}

export function publishLeanSurface(): void {
  const policy: LeanSurfacePolicy = { alwaysActive: () => [...ALWAYS_ACTIVE_TOOL_NAMES] };
  Object.defineProperty(globalThis, LEAN_SURFACE_SYMBOL, {
    configurable: true,
    writable: true,
    value: policy,
  });
}

export function isDeclarableExposure(exposure: ToolExposure | undefined): boolean {
  return exposure === undefined || exposure === "direct" || exposure === "model-only";
}

export function isSearchLoadedExposure(exposure: ToolExposure | undefined): boolean {
  return exposure === "deferred" || exposure === "codemode";
}

type ToolActivationHost = Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">;

export function activateToolSearch(pi: ToolActivationHost): boolean {
  const registered = pi
    .getAllTools()
    .find((tool) => tool.name === TOOL_SEARCH_TOOL_NAME && isDeclarableExposure(tool.exposure));
  if (!registered) return false;
  const active = pi.getActiveTools();
  if (active.includes(TOOL_SEARCH_TOOL_NAME)) return false;
  pi.setActiveTools([...active, TOOL_SEARCH_TOOL_NAME]);
  return true;
}

export function sessionToolSearchExtension(): InlineExtension {
  return {
    name: "choco-tool-search",
    replaceable: true,
    factory: (pi) => {
      pi.registerTool(createToolSearchToolDefinition({ host: pi }));
      pi.on("session_start", () => {
        activateToolSearch(pi);
      });
    },
  };
}

export async function createToolSearchResourceLoader(
  cwd: string,
  options: {
    agentDir?: string;
    settingsManager?: SettingsManager;
    extensionFactories?: readonly InlineExtension[];
  } = {},
): Promise<DefaultResourceLoader> {
  const agentDir = options.agentDir ?? getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: options.settingsManager ?? SettingsManager.create(cwd, agentDir),
    extensionFactories: [sessionToolSearchExtension(), ...(options.extensionFactories ?? [])],
  });
  await loader.reload();
  return loader;
}
