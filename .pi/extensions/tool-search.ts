/**
 * Lean active-tool surface and provider prefix lock.
 *
 * Discovery is Pi's built-in `tool_search` (`builtin:tool-search`); this
 * extension registers no tool. It decides which tools are declared without a
 * search, activates `tool_search` with them, and locks the surface once the
 * first request of a session is built so the cached provider prefix stays
 * stable. After the lock, only `tool_search` changes the surface: its loads
 * are additive, so Pi anchors them in the transcript on providers that support
 * mid-conversation tool additions instead of rewriting the request prefix.
 */
import { isPrefixLocked, lockPrefix, publishPrefixLock, unlockPrefix } from "./lib/prefix-lock.ts";
import {
  ALWAYS_ACTIVE_TOOL_NAMES,
  isDeclarableExposure,
  isSearchLoadedExposure,
  publishLeanSurface,
  TOOL_SEARCH_TOOL_NAME,
} from "./lib/tool-surface.ts";
import type { ExtensionAPI, ToolExposure } from "@earendil-works/pi-coding-agent";
import { hasCanonicalSearch } from "../packages/choco-pi-web-search/index.ts";

export {
  ALWAYS_ACTIVE_TOOL_NAMES,
  LEAN_SURFACE_SYMBOL,
  type LeanSurfacePolicy,
} from "./lib/tool-surface.ts";

const DISABLED_TOOL_NAMES = new Set<string>(["grep"]);
const LEGACY_SEARCH_TOOL_NAMES = new Set<string>([
  "web_run",
  "web__run",
  "synthetic_web_search",
  "agent_browser_web_search",
]);

export default function toolSearch(pi: ExtensionAPI): void {
  publishLeanSurface();
  publishPrefixLock();
  let scheduledImmediate: ReturnType<typeof setImmediate> | undefined;
  let leanSurfaceInitialized = false;

  const withoutUnavailableTools = (names: readonly string[]): string[] => {
    const canonicalSearch = hasCanonicalSearch(pi.events);
    return names.filter(
      (name) =>
        !DISABLED_TOOL_NAMES.has(name) && (!canonicalSearch || !LEGACY_SEARCH_TOOL_NAMES.has(name)),
    );
  };

  /**
   * The always-active tools, then tools already active that must stay, then
   * `tool_search`. Before the first commit of a session only tools a search
   * loaded carry over; afterwards every declarable active tool does, so a
   * recommit never removes what another extension activated.
   */
  const computeLeanSurface = (): string[] => {
    const exposures = new Map<string, ToolExposure | undefined>(
      pi.getAllTools().map((tool) => [tool.name, tool.exposure]),
    );
    const available = new Set(withoutUnavailableTools([...exposures.keys()]));
    const surface: string[] = [];
    const included = new Set<string>();
    const include = (name: string): void => {
      if (included.has(name) || !available.has(name)) return;
      included.add(name);
      surface.push(name);
    };
    for (const name of ALWAYS_ACTIVE_TOOL_NAMES) {
      if (name !== TOOL_SEARCH_TOOL_NAME && isDeclarableExposure(exposures.get(name))) {
        include(name);
      }
    }
    for (const name of pi.getActiveTools()) {
      if (name === TOOL_SEARCH_TOOL_NAME || !exposures.has(name)) continue;
      const exposure = exposures.get(name);
      if (isSearchLoadedExposure(exposure)) include(name);
      else if (leanSurfaceInitialized && isDeclarableExposure(exposure)) include(name);
    }
    if (exposures.has(TOOL_SEARCH_TOOL_NAME)) {
      if (isDeclarableExposure(exposures.get(TOOL_SEARCH_TOOL_NAME)))
        include(TOOL_SEARCH_TOOL_NAME);
    }
    return surface;
  };

  const commitLeanSurface = (): void => {
    if (isPrefixLocked()) return;
    const names = computeLeanSurface();
    const active = pi.getActiveTools();
    leanSurfaceInitialized = true;
    if (active.length === names.length && active.every((name, index) => name === names[index])) {
      return;
    }
    pi.setActiveTools(names);
  };

  const cancelScheduledLeanSurface = (): void => {
    if (scheduledImmediate !== undefined) clearImmediate(scheduledImmediate);
    scheduledImmediate = undefined;
  };

  const scheduleLeanSurface = (): void => {
    if (scheduledImmediate !== undefined) return;
    scheduledImmediate = setImmediate(() => {
      scheduledImmediate = undefined;
      commitLeanSurface();
    });
  };

  pi.on("session_start", () => {
    unlockPrefix();
    leanSurfaceInitialized = false;
    scheduleLeanSurface();
  });
  pi.on("before_agent_start", () => {
    cancelScheduledLeanSurface();
    commitLeanSurface();
    lockPrefix();
  });
  pi.on("session_shutdown", () => {
    cancelScheduledLeanSurface();
  });
  pi.on("model_select", () => {
    unlockPrefix();
    scheduleLeanSurface();
  });
}
