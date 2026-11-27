import {
  AppBlockedError,
  appBlockFor,
  DEFAULT_BLOCKED_APPS,
  effectiveAppBlocklist,
  type AppBlock,
  type EffectiveAppBlocklist,
} from "../../app-policy.ts";
import { getComputerUseConfig } from "../../config.ts";
import { isJsonObject, isNumber, type JsonField, type JsonValue } from "../../json.ts";
import { parseLookResponse, type LookResponse } from "../../outline.ts";
import { toBoolean, toFiniteNumber, toOptionalString } from "../coerce.ts";
import type {
  ComputerUsePlatformBackend,
  FramePoints,
  HelperAppBlock,
  HelperActResult,
  PlatformActRequest,
  PlatformApp,
  PlatformFocusWindowResult,
  PlatformFrontmostResult,
  PlatformObserveRequest,
  PlatformReadTextRequest,
  PlatformReadTextResponse,
  PlatformRestoreUserFocusRequest,
  PlatformRestoreUserFocusResult,
  PlatformRoot,
  PlatformRootKind,
  PlatformRootQuery,
  PlatformTarget,
  PlatformWaitForRequest,
  PlatformWaitForResponse,
} from "../types.ts";
import { HelperCommandError, macosHelper } from "./helper.ts";

export class HelperAppBlockedError extends AppBlockedError {
  readonly effectPossible = false;
  readonly inputSent = false;
}

function helperAppBlock(block: HelperAppBlock): AppBlock {
  const decided = appBlockFor({ bundleId: block.bundleId, pid: block.pid });
  if (decided) return decided;
  const matched = block.bundleId ?? `pid ${block.pid}`;
  if (block.match === "helper") return { reason: "helper", matched };
  if (block.match === "pid") return { reason: "host_app", matched: `pid ${block.pid}` };
  const wanted = block.bundleId?.toLowerCase();
  const builtIn = DEFAULT_BLOCKED_APPS.find((app) => app.bundleId.toLowerCase() === wanted);
  return builtIn
    ? { reason: builtIn.reason, matched: builtIn.bundleId }
    : { reason: "user_blocked", matched };
}

async function mapAppBlocked<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof HelperCommandError &&
      error.code === "app_blocked" &&
      error.appBlock &&
      error.appBlock.match !== "unknown_owner"
    ) {
      const block = error.appBlock;
      throw new HelperAppBlockedError(
        { appName: block.appName ?? `pid ${block.pid}`, bundleId: block.bundleId, pid: block.pid },
        helperAppBlock(block),
      );
    }
    throw error;
  }
}

function withAppBlocklist<T extends object>(args: T): T & { appBlocklist: EffectiveAppBlocklist } {
  return { ...args, appBlocklist: effectiveAppBlocklist() };
}

interface ListRootsArgs {
  pid?: number;
  title?: string;
}

interface RestoreUserFocusArgs {
  pid: number;
  windowRef?: string;
  windowId?: number;
  windowTitle?: string;
  expectedFrontmostPid?: number;
  foregroundGrant: true;
}

interface FrontmostResponse {
  pid?: number;
  appName?: string;
  bundleId?: string;
  windowTitle?: string;
  windowId?: number;
  windowRef?: string;
  windowSource?: string;
}

function windowSourceOf(value: string | undefined): PlatformFrontmostResult["windowSource"] {
  return value === "focused" || value === "main" || value === "unknown" ? value : undefined;
}

function integerOf(value: number | undefined): number | undefined {
  return isNumber(value) && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function isPlatformRootKind(value: JsonField): value is PlatformRootKind {
  return (
    value === "window" ||
    value === "menu" ||
    value === "sheet" ||
    value === "popover" ||
    value === "dialog"
  );
}

function parseApps(result: JsonValue): PlatformApp[] {
  const array = Array.isArray(result) ? result : isJsonObject(result) ? result.apps : undefined;
  if (!Array.isArray(array)) return [];

  return array
    .map((value): PlatformApp | undefined => {
      const raw = isJsonObject(value) ? value : {};
      const pid = Math.trunc(toFiniteNumber(raw.pid, NaN));
      if (!Number.isFinite(pid) || pid <= 0) return undefined;
      return {
        appName: toOptionalString(raw.appName) ?? "Unknown App",
        bundleId: toOptionalString(raw.bundleId),
        pid,
        isFrontmost: toBoolean(raw.isFrontmost),
      };
    })
    .filter((item): item is PlatformApp => Boolean(item));
}

function parseFramePoints(raw: JsonField): FramePoints {
  const record = isJsonObject(raw) ? raw : {};
  const frame = isJsonObject(record.framePoints) ? record.framePoints : {};
  return {
    x: toFiniteNumber(frame.x, 0),
    y: toFiniteNumber(frame.y, 0),
    w: Math.max(1, toFiniteNumber(frame.w, 1)),
    h: Math.max(1, toFiniteNumber(frame.h, 1)),
  };
}

function parseRoots(result: JsonValue): PlatformRoot[] {
  const array = Array.isArray(result) ? result : isJsonObject(result) ? result.roots : undefined;
  if (!Array.isArray(array)) return [];

  return array.map((value): PlatformRoot => {
    const raw = isJsonObject(value) ? value : {};
    const root: PlatformRoot = {
      kind: isPlatformRootKind(raw.kind) ? raw.kind : "window",
      rootRef: toOptionalString(raw.rootRef ?? raw.windowRef),
      windowRef: toOptionalString(raw.windowRef ?? raw.rootRef),
      windowId:
        isNumber(raw.windowId) && Number.isFinite(raw.windowId)
          ? Math.trunc(raw.windowId)
          : undefined,
      pid: isNumber(raw.pid) && Number.isFinite(raw.pid) ? Math.trunc(raw.pid) : undefined,
      appName: toOptionalString(raw.appName),
      bundleId: toOptionalString(raw.bundleId),
      title: toOptionalString(raw.title) ?? "",
      role: toOptionalString(raw.role),
      subrole: toOptionalString(raw.subrole),
      framePoints: parseFramePoints(raw),
      scaleFactor: Math.max(1, toFiniteNumber(raw.scaleFactor, 1)),
      zOrder: Math.trunc(toFiniteNumber(raw.zOrder, 0)),
      isMinimized: toBoolean(raw.isMinimized),
      isOnscreen: toBoolean(raw.isOnscreen),
      isMain: toBoolean(raw.isMain),
      isFocused: toBoolean(raw.isFocused),
      isModal: toBoolean(raw.isModal),
      metadata: isJsonObject(raw.metadata) ? raw.metadata : {},
    };
    if (raw.offSpace === true) {
      root.offSpace = true;
      root.isOnscreen = false;
      if (
        raw.offSpaceAccess === "resolved" ||
        raw.offSpaceAccess === "unresolved" ||
        raw.offSpaceAccess === "not_checked"
      )
        root.offSpaceAccess = raw.offSpaceAccess;
    }
    return root;
  });
}

function helperAction(request: PlatformActRequest) {
  if (!("focus" in request.target)) return { ...request };
  const focusResolution: NonNullable<PlatformActRequest["focusResolution"]> = "ax_focused_element";
  return {
    ...request,
    target: request.target.focus,
    focusResolution,
    params: { ...request.params, preserveFocus: true },
  };
}

export const macosBackend: Pick<
  ComputerUsePlatformBackend,
  | "listApps"
  | "listRoots"
  | "getFrontmost"
  | "focusWindow"
  | "restoreUserFocus"
  | "observe"
  | "act"
  | "actBatch"
  | "readText"
  | "waitFor"
> = {
  async listApps(signal?: AbortSignal): Promise<PlatformApp[]> {
    return parseApps(await macosHelper.command("listApps", {}, { signal }));
  },

  async listRoots(query: PlatformRootQuery, signal?: AbortSignal): Promise<PlatformRoot[]> {
    const args: ListRootsArgs = {};
    if (Number.isFinite(query.pid)) args.pid = Math.trunc(query.pid!);
    if (query.title?.trim()) args.title = query.title.trim();
    return parseRoots(
      await macosHelper.command("listRoots", withAppBlocklist({ ...args }), { signal }),
    );
  },

  async getFrontmost(signal?: AbortSignal): Promise<PlatformFrontmostResult> {
    const result = await macosHelper.command<FrontmostResponse>("getFrontmost", {}, { signal });
    const pid = Math.trunc(toFiniteNumber(result.pid, NaN));
    if (!Number.isFinite(pid) || pid <= 0) {
      throw new Error("No frontmost app was available for screenshot targeting.");
    }
    const windowSource = windowSourceOf(result.windowSource);
    const front: PlatformFrontmostResult = {
      appName: toOptionalString(result.appName) ?? "Unknown App",
      bundleId: toOptionalString(result.bundleId),
      pid,
    };
    if (windowSource) front.windowSource = windowSource;
    if (windowSource === "unknown") return front;
    front.windowTitle = toOptionalString(result.windowTitle);
    front.windowId = integerOf(result.windowId);
    front.rootRef = toOptionalString(result.windowRef);
    return front;
  },

  async focusWindow(
    target: PlatformTarget,
    signal?: AbortSignal,
  ): Promise<PlatformFocusWindowResult> {
    return await mapAppBlocked(() =>
      macosHelper.command<PlatformFocusWindowResult>(
        "focusWindow",
        withAppBlocklist({ ...target }),
        { signal },
      ),
    );
  },

  async restoreUserFocus(
    request: PlatformRestoreUserFocusRequest,
    signal?: AbortSignal,
  ): Promise<PlatformRestoreUserFocusResult> {
    const args: RestoreUserFocusArgs = {
      pid: Math.trunc(request.pid),
      foregroundGrant: true,
    };
    const windowRef = request.windowRef?.trim();
    if (windowRef) args.windowRef = windowRef;
    const windowId = integerOf(request.windowId);
    if (windowId !== undefined) args.windowId = windowId;
    const windowTitle = request.windowTitle?.trim();
    if (windowTitle) args.windowTitle = windowTitle;
    const expected = integerOf(request.expectedFrontmostPid);
    if (expected !== undefined) args.expectedFrontmostPid = expected;
    const raw: JsonValue = await macosHelper.command("restoreUserFocus", args, { signal });
    if (!isJsonObject(raw)) throw new Error("Helper restoreUserFocus returned an invalid result.");
    return {
      restored: toBoolean(raw.restored),
      appRestored: toBoolean(raw.appRestored),
      windowRestored: toBoolean(raw.windowRestored),
      appName: toOptionalString(raw.appName),
      windowTitle: toOptionalString(raw.windowTitle),
      reason: toOptionalString(raw.reason),
      windowMatch: toOptionalString(raw.windowMatch),
      frontmostPid: isNumber(raw.frontmostBefore) ? integerOf(raw.frontmostBefore) : undefined,
    };
  },

  async observe(
    request: PlatformObserveRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<LookResponse> {
    return parseLookResponse(
      await mapAppBlocked(() =>
        macosHelper.command(
          "look",
          withAppBlocklist({
            baseLookId: request.baseLookId,
            windowId: request.target.windowId,
            windowRef: request.target.rootRef,
            maxDimension: request.maxDimension,
            readText: request.readText,
            scopeRef: request.scopeRef,
            includeImage: request.includeImage,
            backgroundDelivery: request.backgroundDelivery,
          }),
          options,
        ),
      ),
    );
  },

  async act(
    request: PlatformActRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<HelperActResult> {
    return await mapAppBlocked(() =>
      macosHelper.command<HelperActResult>(
        "act",
        withAppBlocklist({
          ...helperAction(request),
          cursorOverlay: getComputerUseConfig().cursor_overlay,
        }),
        options,
      ),
    );
  },

  async actBatch(
    requests: PlatformActRequest[],
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<HelperActResult> {
    const cursorOverlay = getComputerUseConfig().cursor_overlay;
    return await mapAppBlocked(() =>
      macosHelper.command<HelperActResult>(
        "actBatch",
        withAppBlocklist({
          actions: requests.map((request) => ({ ...helperAction(request), cursorOverlay })),
        }),
        options,
      ),
    );
  },

  async readText(
    args: PlatformReadTextRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<PlatformReadTextResponse> {
    return await mapAppBlocked(() =>
      macosHelper.command<PlatformReadTextResponse>(
        "axReadText",
        withAppBlocklist({ ...args }),
        options,
      ),
    );
  },

  async waitFor(
    args: PlatformWaitForRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<PlatformWaitForResponse> {
    return await mapAppBlocked(() =>
      macosHelper.command<PlatformWaitForResponse>(
        "axWaitFor",
        withAppBlocklist({ ...args }),
        options,
      ),
    );
  },
};
