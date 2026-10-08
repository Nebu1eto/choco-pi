/**
 * choco-pi's tool-surface policy, shared by the root lean-surface extension and
 * the SDK sessions choco-pi creates itself.
 *
 * Discovery belongs to Pi's built-in `tool_search` (`builtin:tool-search`):
 * it searches `deferred` and `codemode` tools and loads the matches as
 * additive tool changes, which Pi anchors in the transcript instead of
 * rewriting the cached request prefix on providers that support it. This
 * module only decides which tools are declared without a search, and makes
 * sure `tool_search` itself is one of them.
 */
import {
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  type ExtensionAPI,
  type InlineExtension,
  SettingsManager,
  type ToolExposure,
} from "@earendil-works/pi-coding-agent";

/** Name of Pi's built-in discovery tool. */
export const TOOL_SEARCH_TOOL_NAME = "tool_search";

// Keep the minimum execution, orchestration, and discovery path available
// without requiring a preliminary tool search.
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
  // Starting a long-running command and reading its output is a serial,
  // decision-dependent flow. Keep those two calls native; terminal cleanup
  // and inventory remain available through the exec bridge.
  "shell_start",
  "shell_read",
  "find",
  "ls",
  "Agent",
  "get_subagent_result",
  "steer_subagent",
  "stop_subagent",
  "tool_search",
  // These tools can return native image artifacts or own an approval-gated
  // browser interaction, which cannot be represented faithfully by a plain
  // deferred schema call in every provider UI.
  "agent_browser",
  "view_image",
  "image_gen__imagegen",
] as const;

/**
 * Where the lean tool surface is published for other packages.
 *
 * choco-pi-subagents applies the same surface to every sub-agent and
 * choco-pi-mcp reads it, and a package must not import the profile, so each
 * side types this boundary independently over `Symbol.for`. The symbol name
 * predates the move to Pi's built-in search and stays stable for them.
 */
export const LEAN_SURFACE_SYMBOL = Symbol.for("choco-pi.tool-search.lean-surface");

/** Structural view of the surface a session starts with. */
export interface LeanSurfacePolicy {
  /** Tool names no session has to search for. */
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

/**
 * Whether activating a tool with this exposure declares it to the model.
 * A missing exposure is `direct`, as in Pi itself.
 */
export function isDeclarableExposure(exposure: ToolExposure | undefined): boolean {
  return exposure === undefined || exposure === "direct" || exposure === "model-only";
}

/**
 * Whether only `tool_search` can make a tool with this exposure active. Such a
 * tool is never activated on registration, so an active one was loaded by a
 * search (possibly restored from the transcript) and must stay declared.
 */
export function isSearchLoadedExposure(exposure: ToolExposure | undefined): boolean {
  return exposure === "deferred" || exposure === "codemode";
}

type ToolActivationHost = Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">;

/**
 * Add `tool_search` to the active set when it is registered and inactive. The
 * change is additive, so it never removes a tool another extension or the
 * transcript activated.
 */
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

/**
 * Pi's built-in `tool_search` for an SDK session choco-pi creates.
 *
 * SDK sessions do not load the CLI's built-in extensions, so this supplies the
 * same `builtin:tool-search` resource: like the CLI's, it honors
 * `-builtin:tool-search` in settings and `noExtensions`, and an extension that
 * registers its own `tool_search` replaces it. Pi registers the tool inactive;
 * this activates it at `session_start`, before the first request is built.
 */
export function sessionToolSearchExtension(): InlineExtension {
  const registerToolSearch = createToolSearchExtension();
  return {
    name: "tool-search",
    builtin: true,
    replaceable: true,
    factory: async (pi) => {
      await registerToolSearch(pi);
      pi.on("session_start", () => {
        activateToolSearch(pi);
      });
    },
  };
}

/**
 * The resource loader `createAgentSession` would build by default, plus Pi's
 * built-in `tool_search`. Used by every SDK session choco-pi starts with the
 * main harness (session bridge, review side chat), so deferred tools stay
 * discoverable from the first turn exactly as in the CLI session.
 */
export async function createToolSearchResourceLoader(
  cwd: string,
  options: { agentDir?: string; settingsManager?: SettingsManager } = {},
): Promise<DefaultResourceLoader> {
  const agentDir = options.agentDir ?? getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    // The same default DefaultResourceLoader and createAgentSession use.
    settingsManager: options.settingsManager ?? SettingsManager.create(cwd, agentDir),
    extensionFactories: [sessionToolSearchExtension()],
  });
  await loader.reload();
  return loader;
}
