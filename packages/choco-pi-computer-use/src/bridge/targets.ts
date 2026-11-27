import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  appBlockFor,
  assertAppAllowed,
  describeAppBlockReason,
  type AppBlockReason,
} from "../app-policy.ts";
import { listCdpPageContexts } from "../cdp.ts";
import { getComputerUseConfig, isBrowserUseEnabled } from "../config.ts";
import type { FindParams, ObserveTargetParams, RootSelector } from "../contract.ts";
import { isJsonObject, isNumber, isString } from "../json.ts";
import { rankedTextMatch } from "../outline.ts";
import { currentPlatformBackend } from "../platform/index.ts";
import type {
  PlatformApp as HelperApp,
  PlatformFrontmostResult as FrontmostResult,
  PlatformRoot as HelperWindow,
} from "../platform/types.ts";
import { scoreWindow, shouldPreferForegroundModalWindow } from "../root-selection.ts";
import type { CurrentTarget } from "../state.ts";
import {
  CURRENT_TARGET_GONE_ERROR,
  currentTargetOrThrow,
  normalizeText,
  operationState,
  runtimeState,
  storeBrowserRootRef,
  trimOrUndefined,
} from "./state-store.ts";
import type {
  ListWindowsDetails,
  NativeWindowRequest,
  ResolvedTarget,
  WindowRefRecord,
} from "./types.ts";

type ListedRoot = ListWindowsDetails["windows"][number];

export type FindRootsWindow = ListedRoot & { blocked: boolean; block_reason?: AppBlockReason };

export type FindRootsDetails = Omit<ListWindowsDetails, "windows"> & { windows: FindRootsWindow[] };

function withAppPolicy(root: ListedRoot): FindRootsWindow {
  const block = root.kind === "browser_page" ? undefined : appBlockFor(root);
  return block
    ? { ...root, blocked: true, block_reason: block.reason }
    : { ...root, blocked: false };
}

function formatFindRootsLine(root: FindRootsWindow): string {
  const line = formatWindowLine(root);
  return root.blocked && root.block_reason
    ? `${line} BLOCKED: computer-use may not operate this app (${describeAppBlockReason(root.block_reason)}; user-level policy)`
    : line;
}

export async function listApps(signal?: AbortSignal): Promise<HelperApp[]> {
  return await currentPlatformBackend.listApps(signal);
}

export async function listWindows(pid: number, signal?: AbortSignal): Promise<HelperWindow[]> {
  return await currentPlatformBackend.listRoots({ pid }, signal);
}

export function appMatchesWindowQuery(app: HelperApp, query: FindParams): boolean {
  const appQuery = trimOrUndefined(query.app);
  const bundleQuery = trimOrUndefined(query.bundleId);
  const pidQuery = Number.isFinite(query.pid) ? Math.trunc(query.pid!) : undefined;

  if (pidQuery !== undefined && app.pid !== pidQuery) return false;
  if (bundleQuery && normalizeText(app.bundleId ?? "") !== normalizeText(bundleQuery)) return false;
  if (appQuery && normalizeText(app.appName) !== normalizeText(appQuery)) return false;
  return true;
}

export function platformRootSheetCount(window: Pick<HelperWindow, "metadata">): number | undefined {
  const value = window.metadata?.sheetCount;
  return isNumber(value) && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : undefined;
}

export function platformRootPairing(
  window: Pick<HelperWindow, "metadata">,
): { confidence: "exact" | "high" | "low"; score: number } | undefined {
  const value = window.metadata?.pairing;
  if (!isJsonObject(value)) return undefined;
  if (value.confidence !== "exact" && value.confidence !== "high" && value.confidence !== "low")
    return undefined;
  return {
    confidence: value.confidence,
    score:
      isNumber(value.score) && Number.isFinite(value.score)
        ? value.score
        : Number.NEGATIVE_INFINITY,
  };
}

export function formatWindowLine(window: ListWindowsDetails["windows"][number]): string {
  if (window.kind === "browser_page")
    return `- ${window.windowRef} browser_page ${JSON.stringify(window.windowTitle)}${window.url ? ` — ${window.url}` : ""}`;
  const flags = [
    window.isFocused ? "focused" : undefined,
    window.isMain ? "main" : undefined,
    window.isModal ? "modal" : undefined,
    window.sheetCount ? `sheets=${window.sheetCount}` : undefined,
    window.isOnscreen ? "onscreen" : undefined,
    window.isMinimized ? "minimized" : undefined,
    window.browserUseAllowed ? undefined : "browser_use_disabled",
    window.off_space ? "off_space (on a Space no display shows)" : undefined,
    window.off_space_access === "needs_discovery"
      ? "needs_discovery (observing it needs background_delivery: extended)"
      : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  const frame = `${Math.round(window.framePoints.x)},${Math.round(window.framePoints.y)} ${Math.round(window.framePoints.w)}x${Math.round(window.framePoints.h)}`;
  const id = window.windowId
    ? `window_id ${window.windowId}`
    : window.nativeWindowRef
      ? `native_root_ref ${window.nativeWindowRef}`
      : "unstable root id";
  const pairing = window.pairing
    ? `, pairing ${window.pairing.confidence}/${Math.round(window.pairing.score)}`
    : "";
  return `- ${window.windowRef} ${window.kind} ${window.app} pid ${window.pid} — ${window.windowTitle || "(untitled)"} (z ${window.zOrder}, ${id}, frame ${frame}${pairing}${flags ? `, ${flags}` : ""})`;
}

export async function getFrontmost(signal?: AbortSignal): Promise<FrontmostResult> {
  return await currentPlatformBackend.getFrontmost(signal);
}

export function assertBrowserUseAllowed(target: { appName: string; bundleId?: string }): void {
  if (
    !isBrowserUseEnabled() &&
    currentPlatformBackend.isBrowserApp(target.appName, target.bundleId)
  ) {
    throw new Error(
      `Browser use is disabled by pi-computer-use config, so '${target.appName}' cannot be controlled. Enable browser_use in ~/.pi/agent/extensions/pi-computer-use.json or .pi/computer-use.json to allow browser windows.`,
    );
  }
}

export function windowRecordIdentity(
  record: Pick<
    WindowRefRecord,
    "pid" | "windowId" | "nativeWindowRef" | "windowTitle" | "framePoints"
  >,
): string {
  if (record.windowId && record.windowId > 0) {
    return `pid:${record.pid}|id:${record.windowId}`;
  }
  if (record.nativeWindowRef) {
    return `pid:${record.pid}|ref:${record.nativeWindowRef}`;
  }
  const { x, y, w, h } = record.framePoints;
  return `pid:${record.pid}|title:${normalizeText(record.windowTitle)}|frame:${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)}`;
}

export function storeWindowRef(record: Omit<WindowRefRecord, "ref">): WindowRefRecord {
  const identity = windowRecordIdentity(record);
  const existingRef = runtimeState.windowRefByIdentity.get(identity);
  if (existingRef) {
    const existing = runtimeState.windowRefs.get(existingRef);
    if (existing) {
      const updated = { ...record, ref: existingRef };
      runtimeState.windowRefs.set(existingRef, updated);
      return updated;
    }
  }

  const ref = `@r${runtimeState.nextRootRefIndex++}`;
  const stored = { ...record, ref };
  runtimeState.windowRefByIdentity.set(identity, ref);
  runtimeState.windowRefs.set(ref, stored);
  return stored;
}

export function storeWindowRefForTarget(target: ResolvedTarget): string {
  return storeWindowRef({
    appName: target.appName,
    bundleId: target.bundleId,
    pid: target.pid,
    windowTitle: target.windowTitle,
    windowId: target.windowId > 0 ? target.windowId : undefined,
    framePoints: target.framePoints,
    scaleFactor: target.scaleFactor,
    isMinimized: target.isMinimized,
    isOnscreen: target.isOnscreen,
    isMain: target.isMain,
    isFocused: target.isFocused,
  }).ref;
}

export function storeWindowRefForAppWindow(app: HelperApp, window: HelperWindow): WindowRefRecord {
  return storeWindowRef({
    appName: app.appName,
    bundleId: app.bundleId,
    pid: app.pid,
    windowTitle: window.title || "(untitled)",
    windowId: window.windowId,
    nativeWindowRef: window.windowRef,
    framePoints: window.framePoints,
    scaleFactor: window.scaleFactor,
    isMinimized: window.isMinimized,
    isOnscreen: window.isOnscreen,
    isMain: window.isMain,
    isFocused: window.isFocused,
  });
}

export function choosePreferredWindow(windows: HelperWindow[], appName: string): HelperWindow {
  if (!windows.length) {
    throw new Error(`No controllable root was found in app '${appName}'.`);
  }

  const scored = [...windows].sort((a, b) => scoreWindow(b) - scoreWindow(a));
  return scored[0];
}

export function summarizeWindowCandidate(window: HelperWindow): string {
  const flags = [
    window.isFocused ? "focused" : undefined,
    window.isMain ? "main" : undefined,
    window.isOnscreen ? "onscreen" : undefined,
    window.isMinimized ? "minimized" : undefined,
  ]
    .filter(Boolean)
    .join(",");
  return `${window.title || "(untitled)"} [score=${scoreWindow(window)}${flags ? `, ${flags}` : ""}]`;
}

export function summarizeWindowCandidates(windows: HelperWindow[], limit = 6): string {
  return [...windows]
    .sort((a, b) => scoreWindow(b) - scoreWindow(a))
    .slice(0, limit)
    .map(summarizeWindowCandidate)
    .join("; ");
}

export function chooseRankedWindowOrUndefined(windows: HelperWindow[]): HelperWindow | undefined {
  if (windows.length === 0) return undefined;
  const ranked = [...windows].sort((a, b) => scoreWindow(b) - scoreWindow(a));
  if (ranked.length === 1) return ranked[0];
  const topScore = scoreWindow(ranked[0]);
  const nextScore = scoreWindow(ranked[1]);
  return topScore >= nextScore + 25 ? ranked[0] : undefined;
}

export function toResolvedTarget(app: HelperApp, window: HelperWindow): ResolvedTarget {
  const baseTarget = {
    appName: app.appName,
    bundleId: app.bundleId,
    pid: app.pid,
    windowTitle: window.title || "(untitled)",
    windowId: isNumber(window.windowId) ? window.windowId : 0,
    nativeWindowRef: window.windowRef,
    framePoints: window.framePoints,
    scaleFactor: window.scaleFactor,
    isMinimized: window.isMinimized,
    isOnscreen: window.isOnscreen,
    isMain: window.isMain,
    isFocused: window.isFocused,
  };
  const resolved: ResolvedTarget = {
    ...baseTarget,
    windowRef: storeWindowRefForAppWindow(app, window).ref,
  };
  if (window.offSpace) resolved.offSpace = true;
  return resolved;
}

export function nativeWindowRequest(
  target: Pick<CurrentTarget, "pid" | "windowId" | "nativeWindowRef">,
): NativeWindowRequest {
  return { pid: target.pid, windowId: target.windowId, windowRef: target.nativeWindowRef };
}

export function setCurrentTarget(target: ResolvedTarget): void {
  assertAppAllowed(target);
  assertBrowserUseAllowed(target);
  const windowRef = target.windowRef ?? storeWindowRefForTarget(target);
  operationState().currentTarget = {
    appName: target.appName,
    bundleId: target.bundleId,
    pid: target.pid,
    windowTitle: target.windowTitle,
    windowId: target.windowId,
    windowRef,
    nativeWindowRef: target.nativeWindowRef,
  };
}

export function normalizeWindowSelector(selector: RootSelector | undefined): string | undefined {
  if (isNumber(selector) && Number.isFinite(selector)) return String(Math.trunc(selector));
  if (isString(selector)) return trimOrUndefined(selector);
  return undefined;
}

export async function resolveTargetByWindowSelector(
  selector: RootSelector,
  signal?: AbortSignal,
): Promise<ResolvedTarget> {
  const normalized = normalizeWindowSelector(selector);
  if (!normalized) {
    throw new Error("root target must be a non-empty @r ref or numeric window_id.");
  }

  const current = operationState().currentTarget;
  if (current?.windowRef === normalized) {
    return await resolveCurrentTarget(signal);
  }

  const fromRef = runtimeState.windowRefs.get(normalized);
  if (fromRef) {
    assertAppAllowed(fromRef);
    const app: HelperApp = {
      appName: fromRef.appName,
      bundleId: fromRef.bundleId,
      pid: fromRef.pid,
    };
    const windows = await listWindows(fromRef.pid, signal);
    const match =
      (fromRef.windowId
        ? windows.find((window) => window.windowId === fromRef.windowId)
        : undefined) ??
      (fromRef.nativeWindowRef
        ? windows.find((window) => window.windowRef === fromRef.nativeWindowRef)
        : undefined) ??
      windows.find(
        (window) =>
          normalizeText(window.title || "(untitled)") === normalizeText(fromRef.windowTitle),
      );
    if (!match) {
      throw new Error(
        `Root ref '${normalized}' is stale. Call find_roots again and choose a current window.`,
      );
    }
    const resolved = toResolvedTarget(app, match);
    setCurrentTarget(resolved);
    return resolved;
  }

  const numericWindowId = Number(normalized);
  if (Number.isInteger(numericWindowId) && numericWindowId > 0) {
    const apps = await listApps(signal);
    for (const app of apps) {
      const windows = await listWindows(app.pid, signal);
      const match = windows.find((window) => window.windowId === numericWindowId);
      if (match) {
        assertAppAllowed(app);
        assertBrowserUseAllowed(app);
        const resolved = toResolvedTarget(app, match);
        setCurrentTarget(resolved);
        return resolved;
      }
    }
    throw new Error(
      `Window id '${numericWindowId}' was not found. Call find_roots again and choose a current window.`,
    );
  }

  if (normalized.startsWith("@r")) {
    throw new Error(
      `Root ref '${normalized}' is not available in this session. Call find_roots first.`,
    );
  }

  const config = getComputerUseConfig();
  const candidates = await collectWindowDetails(await listApps(signal), config, signal);
  const query = normalizeText(normalized);
  const exact = candidates.filter(
    (candidate) =>
      normalizeText(candidate.app) === query || normalizeText(candidate.windowTitle) === query,
  );
  const fuzzy =
    exact.length > 0
      ? exact
      : candidates.filter((candidate) =>
          `${normalizeText(candidate.app)} ${normalizeText(candidate.windowTitle)}`.includes(query),
        );
  const match = fuzzy.sort(
    (a, b) => Number(b.isFocused) - Number(a.isFocused) || a.zOrder - b.zOrder,
  )[0];
  if (!match)
    throw new Error(
      `Root query '${normalized}' did not match any current root. Call find_roots to inspect roots.`,
    );
  const app: HelperApp = { appName: match.app, bundleId: match.bundleId, pid: match.pid };
  assertAppAllowed(app);
  const roots = await listWindows(match.pid, signal);
  const helperRoot =
    roots.find(
      (root) =>
        root.rootRef === match.nativeWindowRef ||
        root.windowRef === match.nativeWindowRef ||
        root.windowId === match.windowId,
    ) ?? roots[0];
  const resolved = toResolvedTarget(app, helperRoot);
  setCurrentTarget(resolved);
  return resolved;
}

export async function resolveCurrentTarget(signal?: AbortSignal): Promise<ResolvedTarget> {
  const current = currentTargetOrThrow();
  assertAppAllowed(current);
  const windows = await listWindows(current.pid, signal);
  if (!windows.length) {
    throw new Error(CURRENT_TARGET_GONE_ERROR);
  }

  const hadStableWindowId = current.windowId > 0;
  const titleQuery = normalizeText(current.windowTitle);
  let match = current.nativeWindowRef
    ? windows.find(
        (window) =>
          window.windowRef === current.nativeWindowRef ||
          window.rootRef === current.nativeWindowRef,
      )
    : undefined;
  match ??= hadStableWindowId
    ? windows.find(
        (window) => window.windowId !== undefined && window.windowId === current.windowId,
      )
    : undefined;
  if (!match) {
    const exactTitleMatches =
      titleQuery && titleQuery !== "(untitled)"
        ? windows.filter((window) => normalizeText(window.title) === titleQuery)
        : [];
    if (exactTitleMatches.length === 1) {
      match = exactTitleMatches[0];
    } else if (exactTitleMatches.length > 1) {
      match = chooseRankedWindowOrUndefined(exactTitleMatches);
      if (!match) {
        throw new Error(
          `${CURRENT_TARGET_GONE_ERROR} Multiple windows now match '${current.windowTitle}': ${summarizeWindowCandidates(exactTitleMatches)}.`,
        );
      }
    }
  }

  if (!match && !hadStableWindowId) {
    match = chooseRankedWindowOrUndefined(windows);
  }

  if (!match) {
    throw new Error(CURRENT_TARGET_GONE_ERROR);
  }

  const modal = windows
    .filter((window) => shouldPreferForegroundModalWindow(match!, window))
    .sort((a, b) => scoreWindow(b) - scoreWindow(a))[0];
  if (modal) match = modal;

  const app: HelperApp = {
    appName: current.appName,
    bundleId: current.bundleId,
    pid: current.pid,
  };

  const resolved = toResolvedTarget(app, match);
  setCurrentTarget(resolved);
  return resolved;
}

export async function resolveFrontmostTarget(signal?: AbortSignal): Promise<ResolvedTarget> {
  const frontmost = await getFrontmost(signal);
  const apps = await listApps(signal);
  const app = apps.find((candidate) => candidate.pid === frontmost.pid) ?? {
    appName: frontmost.appName,
    bundleId: frontmost.bundleId,
    pid: frontmost.pid,
  };
  assertAppAllowed(app);

  const windows = await listWindows(frontmost.pid, signal);
  if (!windows.length) {
    throw new Error(
      "No frontmost controllable root was found. Open an app window and call observe_ui again.",
    );
  }

  if (currentPlatformBackend.isBrowserApp(app.appName, app.bundleId)) {
    assertBrowserUseAllowed(app);
  }

  let selected = windows.find(
    (window) => window.windowId !== undefined && window.windowId === frontmost.windowId,
  );
  if (!selected && frontmost.windowTitle) {
    selected = windows.find(
      (window) => normalizeText(window.title) === normalizeText(frontmost.windowTitle),
    );
  }
  selected ??= choosePreferredWindow(windows, app.appName);

  const resolved = toResolvedTarget(app, selected);
  setCurrentTarget(resolved);
  return resolved;
}

export function matchesObserveSelection(
  target: ResolvedTarget,
  selection: ObserveTargetParams,
): boolean {
  const root = normalizeWindowSelector(selection.root);
  return !root || target.windowRef === root;
}

export async function resolveTargetForObserve(signal?: AbortSignal): Promise<ResolvedTarget> {
  return operationState().currentTarget
    ? await resolveCurrentTarget(signal)
    : await resolveFrontmostTarget(signal);
}

export async function ensureTargetWindowId(
  target: ResolvedTarget,
  signal?: AbortSignal,
): Promise<ResolvedTarget> {
  if (target.windowId > 0 || target.nativeWindowRef) {
    return target;
  }

  const refreshed = await resolveCurrentTarget(signal);
  if (refreshed.windowId <= 0 && !refreshed.nativeWindowRef) {
    throw new Error(CURRENT_TARGET_GONE_ERROR);
  }
  return refreshed;
}

export function windowDetails(
  app: HelperApp,
  window: HelperWindow,
  config: ReturnType<typeof getComputerUseConfig>,
): ListWindowsDetails["windows"][number] {
  const storedRef = storeWindowRefForAppWindow(app, window);
  const details: ListWindowsDetails["windows"][number] = {
    app: app.appName,
    bundleId: app.bundleId,
    pid: app.pid,
    kind: window.kind,
    windowTitle: window.title || "(untitled)",
    windowId: window.windowId,
    windowRef: storedRef.ref,
    nativeWindowRef: window.windowRef,
    framePoints: window.framePoints,
    scaleFactor: window.scaleFactor,
    isMinimized: window.isMinimized,
    isOnscreen: window.isOnscreen,
    isMain: window.isMain,
    isFocused: window.isFocused,
    isModal: window.isModal,
    sheetCount: platformRootSheetCount(window),
    role: window.role,
    subrole: window.subrole,
    pairing: platformRootPairing(window),
    zOrder: window.zOrder,
    browserUseAllowed:
      config.browser_use || !currentPlatformBackend.isBrowserApp(app.appName, app.bundleId),
    score: scoreWindow(window),
  };
  if (window.offSpace) {
    details.off_space = true;
    details.off_space_access =
      window.offSpaceAccess === "resolved"
        ? "readable"
        : window.offSpaceAccess === "unresolved"
          ? "needs_discovery"
          : "unchecked";
  }
  return details;
}

export function sortWindowDetails(
  windows: ListWindowsDetails["windows"],
): ListWindowsDetails["windows"] {
  return windows.sort(
    (a, b) =>
      b.score - a.score || a.app.localeCompare(b.app) || a.windowTitle.localeCompare(b.windowTitle),
  );
}

export async function collectWindowDetails(
  apps: HelperApp[],
  config: ReturnType<typeof getComputerUseConfig>,
  signal?: AbortSignal,
): Promise<ListWindowsDetails["windows"]> {
  const perApp = await Promise.all(
    apps.map(async (app) => ({ app, windows: await listWindows(app.pid, signal) })),
  );
  return sortWindowDetails(
    perApp.flatMap(({ app, windows }) =>
      windows.map((window) => windowDetails(app, window, config)),
    ),
  );
}

export function collectBroadWindowDetails(
  roots: HelperWindow[],
  config: ReturnType<typeof getComputerUseConfig>,
): ListWindowsDetails["windows"] {
  const windows: ListWindowsDetails["windows"] = [];
  for (const window of roots) {
    if (!window.pid) continue;
    windows.push(
      windowDetails(
        { appName: window.appName ?? "Unknown App", bundleId: window.bundleId, pid: window.pid },
        window,
        config,
      ),
    );
  }
  return sortWindowDetails(windows);
}

export async function windowDetailsForFind(
  query: FindParams,
  config: ReturnType<typeof getComputerUseConfig>,
  signal?: AbortSignal,
): Promise<ListWindowsDetails["windows"]> {
  if (!query.app && !query.bundleId && !Number.isFinite(query.pid)) {
    return collectBroadWindowDetails(await currentPlatformBackend.listRoots({}, signal), config);
  }
  const apps = (await listApps(signal)).filter((app) => appMatchesWindowQuery(app, query));
  return await collectWindowDetails(apps, config, signal);
}

export async function performListWindows(
  params: FindParams,
  signal?: AbortSignal,
): Promise<AgentToolResult<FindRootsDetails>> {
  const rawParams = params ?? {};
  const query: FindParams = {
    text: trimOrUndefined(rawParams.text),
    app: trimOrUndefined(rawParams.app),
    bundleId: trimOrUndefined(rawParams.bundleId),
    pid: Number.isFinite(rawParams.pid) ? Math.trunc(rawParams.pid!) : undefined,
    kind: rawParams.kind,
  };
  const config = getComputerUseConfig();
  const desktopForest = await windowDetailsForFind(query, config, signal);
  const includeBrowserPages =
    !query.pid &&
    !query.bundleId &&
    (!query.app || normalizeText(query.app) === "browser") &&
    config.browser_use;
  const browserForest: ListWindowsDetails["windows"] = includeBrowserPages
    ? (await listCdpPageContexts().catch(() => [])).map((page) => ({
        app: "Browser",
        pid: 0,
        kind: "browser_page",
        windowTitle: page.title || page.url,
        windowRef: storeBrowserRootRef(page.contextId),
        framePoints: { x: 0, y: 0, w: 1, h: 1 },
        scaleFactor: 1,
        isMinimized: false,
        isOnscreen: true,
        isMain: false,
        isFocused: false,
        isModal: false,
        zOrder: Number.MAX_SAFE_INTEGER,
        browserUseAllowed: true,
        score: 0,
        url: page.url,
      }))
    : [];
  const allRoots = [...desktopForest, ...browserForest].map(withAppPolicy);
  const forest = allRoots.filter((root) => !query.kind || root.kind === query.kind);
  const ranked = forest
    .map((root, order) => ({
      root,
      order,
      match: query.text
        ? rankedTextMatch([root.app, root.windowTitle], query.text)
        : { reason: "filter" as const, score: 1 },
    }))
    .filter((entry) => entry.match)
    .sort(
      (a, b) =>
        b.match!.score - a.match!.score ||
        Number(b.root.isFocused) - Number(a.root.isFocused) ||
        a.root.zOrder - b.root.zOrder ||
        a.order - b.order,
    );
  const totalMatches = ranked.length;
  const windows = ranked.slice(0, 12).map((entry) => entry.root);
  const details: FindRootsDetails = {
    tool: "find_roots",
    query,
    windows,
    totalMatches,
    returned: windows.length,
    hasMore: totalMatches > windows.length,
    config,
  };
  const lines = windows.map(formatFindRootsLine);
  const text = lines.length
    ? `Found ${totalMatches} matching root${totalMatches === 1 ? "" : "s"}; returned ${windows.length}${totalMatches > windows.length ? ". Refine the filters for additional roots" : ""}. Use @r refs with observe_ui({ root: "@rN" }).\n${lines.join("\n")}`
    : query.text || query.app || query.bundleId || query.pid || query.kind
      ? "No roots matched the supplied filters."
      : "No roots are currently visible to pi-computer-use.";
  return { content: [{ type: "text", text }], details };
}

export function sameRootIdentity(a: CurrentTarget, b: CurrentTarget): boolean {
  if (a.pid !== b.pid) return false;
  if (a.windowId > 0 && b.windowId > 0) return a.windowId === b.windowId;
  if (a.nativeWindowRef && b.nativeWindowRef) return a.nativeWindowRef === b.nativeWindowRef;
  return normalizeText(a.windowTitle) === normalizeText(b.windowTitle);
}
