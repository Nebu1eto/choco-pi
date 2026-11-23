import { isPrefixLocked, lockPrefix, publishPrefixLock, unlockPrefix } from "./lib/prefix-lock.ts";
import { createToolSearchToolDefinition, DISABLED_TOOL_NAMES } from "./lib/tool-search-tool.ts";
import { readChildSessionProbe } from "./lib/usage-limit-contract.ts";
import {
  ALWAYS_ACTIVE_TOOL_NAMES,
  isDeclarableExposure,
  isSearchLoadedExposure,
  publishLeanSurface,
  TOOL_SEARCH_TOOL_NAME,
} from "./lib/tool-surface.ts";
import {
  parseArgs,
  type ExtensionAPI,
  type SessionEntry,
  type ToolExposure,
} from "@earendil-works/pi-coding-agent";
import { hasCanonicalSearch } from "../../packages/choco-pi-web-search/index.ts";

export {
  ALWAYS_ACTIVE_TOOL_NAMES,
  LEAN_SURFACE_SYMBOL,
  type LeanSurfacePolicy,
} from "./lib/tool-surface.ts";

const LEGACY_SEARCH_TOOL_NAMES = new Set<string>([
  "web_run",
  "web__run",
  "synthetic_web_search",
  "agent_browser_web_search",
]);

function loadingForChildSession(): boolean {
  try {
    return readChildSessionProbe()?.isChildSessionContext() === true;
  } catch {
    return true;
  }
}

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

  if (!loadingForChildSession()) {
    pi.registerTool(
      createToolSearchToolDefinition({
        host: pi,
        isAvailable: (name) => withoutUnavailableTools([name]).length === 1,
      }),
    );
  }

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

  let awaited: AwaitedTools = NOTHING_AWAITED;

  const awaitUnregistered = (
    names: ReadonlySet<string>,
    accepts: AwaitedTools["accepts"],
  ): AwaitedTools => {
    const registered = new Set(pi.getAllTools().map((tool) => tool.name));
    return { names: new Set([...names].filter((name) => !registered.has(name))), accepts };
  };

  const activateAwaitedTools = (): void => {
    const { names, accepts } = awaited;
    awaited = NOTHING_AWAITED;
    if (names.size === 0) return;
    const exposures = new Map(pi.getAllTools().map((tool) => [tool.name, tool.exposure]));
    const active = pi.getActiveTools();
    const ready = [...names].filter(
      (name) => exposures.has(name) && !active.includes(name) && accepts(exposures.get(name)),
    );
    if (ready.length > 0) pi.setActiveTools([...active, ...ready]);
  };

  pi.on("session_start", (_event, ctx) => {
    unlockPrefix();
    leanSurfaceInitialized = false;
    const record = readBranchToolRecord(ctx.sessionManager.getBranch());
    awaited = record
      ? awaitUnregistered(withoutCliRemovals(record.current), isSearchLoadedExposure)
      : NOTHING_AWAITED;
    scheduleLeanSurface();
  });
  pi.on("before_agent_start", () => {
    cancelScheduledLeanSurface();
    commitLeanSurface();
    lockPrefix();
    activateAwaitedTools();
  });
  pi.on("session_shutdown", () => {
    cancelScheduledLeanSurface();
  });
  pi.on("model_select", () => {
    unlockPrefix();
    scheduleLeanSurface();
  });

  let activeBeforeTree: ReadonlySet<string> | undefined;
  pi.on("session_before_tree", () => {
    activeBeforeTree = new Set(pi.getActiveTools());
  });
  pi.on("session_tree", (_event, ctx) => {
    const before = activeBeforeTree;
    activeBeforeTree = undefined;
    awaited = NOTHING_AWAITED;
    const record = before && readBranchToolRecord(ctx.sessionManager.getBranch());
    if (!before || !record) return;
    const active = pi.getActiveTools();
    const kept = active.filter((name) => before.has(name) || record.mentioned.has(name));
    if (kept.length === active.length) return;
    awaited = awaitUnregistered(record.current, () => true);
    pi.setActiveTools(kept);
  });
}

interface AwaitedTools {
  names: ReadonlySet<string>;
  accepts(exposure: ToolExposure | undefined): boolean;
}

const NOTHING_AWAITED: AwaitedTools = { names: new Set(), accepts: () => false };

interface BranchToolRecord {
  mentioned: ReadonlySet<string>;
  current: ReadonlySet<string>;
}

function readBranchToolRecord(branch: readonly SessionEntry[]): BranchToolRecord | undefined {
  const mentioned = new Set<string>();
  const current = new Set<string>();
  let recorded = false;
  for (const entry of branch) {
    if (entry.type !== "message" || entry.message.role !== "system") continue;
    recorded = true;
    for (const tool of entry.message.toolsRemoved ?? []) {
      mentioned.add(tool.name);
      current.delete(tool.name);
    }
    for (const tool of entry.message.toolsAdded ?? []) {
      mentioned.add(tool.name);
      current.add(tool.name);
    }
  }
  return recorded ? { mentioned, current } : undefined;
}

function withoutCliRemovals(names: ReadonlySet<string>): Set<string> {
  const modifiers = (parseArgs(process.argv.slice(2)).tools ?? []).filter(
    (entry) => entry.startsWith("+") || entry.startsWith("-"),
  );
  const removed = (name: string): boolean =>
    modifiers.reduce((isRemoved, entry) => {
      if (entry === `-${name}`) return true;
      if (entry === `+${name}`) return false;
      return isRemoved;
    }, false);
  return new Set([...names].filter((name) => !removed(name)));
}
