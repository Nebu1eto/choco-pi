import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { AGENT_TOOL_NAMES, type ActParams, type UiAction } from "../contract.ts";
import { isJsonObject, isNumber, isString } from "../json.ts";
import type { WindowNote } from "../note.ts";
import type { SerializedOutline } from "../outline.ts";
import { applyOutputEnvelope, boundToolError, clearStoredOutputs } from "../output.ts";
import { toFiniteNumber } from "../platform/coerce.ts";
import { StaleResourceStateError } from "../runtime.ts";
import type { CurrentCapture, CurrentTarget } from "../state.ts";
import { actionLabel } from "../tool-params.ts";
import { performBrowserTransaction } from "./browser-actions.ts";
import { isKeyboardUiAction, performDesktopTransaction } from "./desktop-actions.ts";
import { performObserve } from "./observation.ts";
import {
  AUTO_OBSERVE_TOOLS,
  OBSERVATION_REQUIRED_MUTATIONS,
  desktopResourceKey,
  ensureReady,
  observationRefreshRequired,
  operationState,
  persistOperation,
  resourceScheduler,
  runtimeState,
  savedStates,
  staleObservation,
  throwIfAborted,
  toBoolean,
  trimOrUndefined,
} from "./state-store.ts";
import { windowRecordIdentity } from "./targets.ts";
import type {
  BrowserObservationDetails,
  ComputerUseDetails,
  PersistedSerializedNode,
  PersistedSessionEntry,
  RefToolParams,
  StatefulToolParams,
  TerminalBrowserActionDetails,
  TerminalDesktopActionDetails,
  WindowRefRecord,
} from "./types.ts";

export function validateActionTarget(action: UiAction): void {
  const hasRef = Boolean(trimOrUndefined(action.ref));
  const hasX = Number.isFinite(action.x);
  const hasY = Number.isFinite(action.y);
  if (isKeyboardUiAction(action) && (action.x !== undefined || action.y !== undefined))
    throw new Error(
      `${actionLabel(action.action)} does not take x/y: keyboard input goes to a focused control, not a point. Click the point first and then send ${actionLabel(action.action)} without ref, or pass the control's ref.`,
    );
  if (hasX !== hasY)
    throw new Error(`${actionLabel(action.action)} coordinates require both x and y.`);
  const hasPoint = hasX && hasY;
  if ((action.action === "click" || action.action === "moveMouse") && hasRef === hasPoint) {
    throw new Error(
      `${actionLabel(action.action)} requires exactly one target: ref or x/y coordinates.`,
    );
  }
  if (action.action === "press" && !hasRef) throw new Error("press requires an actionable ref.");
  if (
    action.action === "scroll" &&
    toFiniteNumber(action.scrollX, 0) === 0 &&
    toFiniteNumber(action.scrollY, 0) === 0
  )
    throw new Error("scroll requires a non-zero scroll_x or scroll_y delta.");
  if (
    action.clickCount !== undefined &&
    (!Number.isInteger(action.clickCount) || action.clickCount < 1 || action.clickCount > 3)
  )
    throw new Error("click_count must be an integer from 1 to 3.");
}

export async function performAct(
  params: ActParams,
  signal?: AbortSignal,
  ctx?: ExtensionContext,
): Promise<
  AgentToolResult<
    | ComputerUseDetails
    | TerminalDesktopActionDetails
    | BrowserObservationDetails
    | TerminalBrowserActionDetails
  >
> {
  const actions = Array.isArray(params.actions) ? params.actions : [];
  if (actions.length === 0) throw new Error("act_ui.actions must contain at least one action.");
  if (actions.length > 20) throw new Error("act_ui supports at most 20 actions per transaction.");
  for (const action of actions) validateActionTarget(action);
  if (operationState().contextId) return await performBrowserTransaction(params, actions, signal);
  return await performDesktopTransaction(params, actions, signal, ctx);
}

export async function executeTool<P, T>(
  tool: string,
  ctx: ExtensionContext,
  params: P,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  // SAFETY: Tool params have already passed the registered schemas; only read_text can carry the optional ref field read here.
  const refParams = params as RefToolParams;
  const outputRef = trimOrUndefined(refParams.ref)?.startsWith("@o") === true;
  // SAFETY: Tool params have already passed the registered schemas, which type stateId as an optional string.
  const stateParams = params as StatefulToolParams;
  const requestedStateId = outputRef ? undefined : trimOrUndefined(stateParams.stateId);
  const stateRecord = requestedStateId ? savedStates.get(requestedStateId) : undefined;
  if (requestedStateId && !stateRecord) {
    if (OBSERVATION_REQUIRED_MUTATIONS.has(tool)) {
      throw observationRefreshRequired(tool, "missing", {}, requestedStateId);
    }
    throw new Error(
      `State '${requestedStateId}' is unavailable or was evicted. Observe the root again.`,
    );
  }
  const operation = savedStates.hydrate(stateRecord);
  if (OBSERVATION_REQUIRED_MUTATIONS.has(tool)) {
    if (!operation.currentCapture) {
      throw observationRefreshRequired(tool, "missing", operation, requestedStateId);
    }
    const stale = staleObservation(stateRecord);
    if (stale) throw observationRefreshRequired(tool, "stale", operation, requestedStateId, stale);
  }
  return await savedStates.operations.run(operation, async () => {
    await resourceScheduler.read("session-lifecycle", async () => await ensureReady(ctx, signal));
    throwIfAborted(signal);
    if (AUTO_OBSERVE_TOOLS.has(tool) && !operation.currentCapture) {
      // Semantic observation only reads the accessibility tree: it disables OCR,
      // image capture, focus changes, and every action delivery path.
      await performObserve({ mode: "semantic" }, signal);
      throwIfAborted(signal);
    }
    let result: T;
    try {
      result = await run();
    } catch (error) {
      if (OBSERVATION_REQUIRED_MUTATIONS.has(tool) && error instanceof StaleResourceStateError) {
        throw observationRefreshRequired(tool, "stale", operation, requestedStateId, error);
      }
      throw error;
    }
    persistOperation(operation);
    return result;
  });
}

export function makeToolExecutor<P, D>(
  tool: string,
  perform: (
    params: P,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ) => Promise<AgentToolResult<D>>,
) {
  return async (
    _toolCallId: string,
    params: P,
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<D> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<D>> => {
    try {
      return applyOutputEnvelope(
        tool,
        await executeTool(tool, ctx, params, signal, () => perform(params, signal, ctx)),
      );
    } catch (error) {
      throw boundToolError(tool, error);
    }
  };
}

export function reconstructStateFromBranch(ctx: ExtensionContext): void {
  savedStates.clear();
  clearStoredOutputs();
  runtimeState.windowRefs.clear();
  runtimeState.windowRefByIdentity.clear();
  runtimeState.nextRootRefIndex = 1;

  // SAFETY: SessionManager.getBranch returns the host's serialized session-entry representation.
  const branch = ctx.sessionManager.getBranch() as PersistedSessionEntry[];
  const restoredResources = new Set<string>();
  for (const entry of [...branch].reverse()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message || message.role !== "toolResult" || !isString(message.toolName)) continue;
    if (!AGENT_TOOL_NAMES.has(message.toolName)) continue;

    const rawDetails = message.details;
    if (!rawDetails) continue;
    if (rawDetails.tool === "find_roots" && Array.isArray(rawDetails.windows)) {
      for (const value of rawDetails.windows) {
        const window = isJsonObject(value) ? value : undefined;
        if (
          !window ||
          !isString(window.windowRef) ||
          !isNumber(window.pid) ||
          !Number.isFinite(window.pid)
        )
          continue;
        const frame = isJsonObject(window.framePoints) ? window.framePoints : {};
        const record: WindowRefRecord = {
          ref: window.windowRef,
          appName: isString(window.app) ? window.app : "Unknown App",
          bundleId: isString(window.bundleId) ? window.bundleId : undefined,
          pid: Math.trunc(window.pid),
          windowTitle: isString(window.windowTitle) ? window.windowTitle : "(untitled)",
          windowId:
            isNumber(window.windowId) && Number.isFinite(window.windowId)
              ? Math.trunc(window.windowId)
              : undefined,
          nativeWindowRef: isString(window.nativeWindowRef) ? window.nativeWindowRef : undefined,
          framePoints: {
            x: toFiniteNumber(frame.x, 0),
            y: toFiniteNumber(frame.y, 0),
            w: Math.max(1, toFiniteNumber(frame.w, 1)),
            h: Math.max(1, toFiniteNumber(frame.h, 1)),
          },
          scaleFactor: Math.max(1, toFiniteNumber(window.scaleFactor, 1)),
          isMinimized: toBoolean(window.isMinimized),
          isOnscreen: toBoolean(window.isOnscreen),
          isMain: toBoolean(window.isMain),
          isFocused: toBoolean(window.isFocused),
        };
        runtimeState.windowRefs.set(record.ref, record);
        runtimeState.windowRefByIdentity.set(windowRecordIdentity(record), record.ref);
        const match = /^@r(\d+)$/.exec(record.ref);
        if (match)
          runtimeState.nextRootRefIndex = Math.max(
            runtimeState.nextRootRefIndex,
            Number(match[1]) + 1,
          );
      }
      continue;
    }

    const targetData = isJsonObject(rawDetails.target) ? rawDetails.target : undefined;
    const captureData = isJsonObject(rawDetails.capture) ? rawDetails.capture : undefined;
    if (!targetData || !captureData) continue;
    if (
      !isString(targetData.app) ||
      !isNumber(targetData.pid) ||
      !isNumber(targetData.windowId) ||
      !isString(captureData.stateId)
    )
      continue;
    if (!Number.isFinite(targetData.pid) || !Number.isFinite(targetData.windowId)) continue;

    const target: CurrentTarget = {
      appName: targetData.app,
      bundleId: isString(targetData.bundleId) ? targetData.bundleId : undefined,
      pid: Math.trunc(targetData.pid),
      windowTitle: isString(targetData.windowTitle) ? targetData.windowTitle : "(untitled)",
      windowId: Math.trunc(targetData.windowId),
      windowRef: isString(targetData.windowRef) ? targetData.windowRef : undefined,
      nativeWindowRef: isString(targetData.nativeWindowRef)
        ? targetData.nativeWindowRef
        : undefined,
    };

    const resourceKey = desktopResourceKey(target);
    if (restoredResources.has(resourceKey)) continue;
    const capture: CurrentCapture = {
      stateId: captureData.stateId,
      width: Math.max(1, Math.trunc(toFiniteNumber(captureData.width, 1))),
      height: Math.max(1, Math.trunc(toFiniteNumber(captureData.height, 1))),
      scaleFactor: Math.max(1, toFiniteNumber(captureData.scaleFactor, 1)),
      timestamp:
        isNumber(captureData.timestamp) && Number.isFinite(captureData.timestamp)
          ? captureData.timestamp
          : Date.now(),
    };
    const outlineData = isJsonObject(rawDetails.outline) ? rawDetails.outline : undefined;
    if (!outlineData || !isString(outlineData.lookId) || !isJsonObject(outlineData.root)) continue;
    // SAFETY: computer-use persists this recursive root only from serializeOutline; the enclosing lookId/root checks establish its serialized envelope.
    const root = outlineData.root as PersistedSerializedNode;
    const outline: SerializedOutline = { lookId: outlineData.lookId, root };
    // SAFETY: computer-use persists note only from WindowNote values in its own tool details.
    const note = rawDetails.note as WindowNote | undefined;
    const epoch = 0;
    resourceScheduler.restoreEpoch(resourceKey, epoch);
    savedStates.set({
      stateId: capture.stateId,
      resourceKey,
      epoch,
      value: {
        kind: "desktop",
        target,
        capture,
        outline,
        look: {
          lookId: outline.lookId,
          capturedAt: capture.timestamp / 1000,
          window: {
            windowId: target.windowId,
            framePoints: { x: 0, y: 0, w: capture.width, h: capture.height },
            scaleFactor: capture.scaleFactor,
            isModal: false,
            role: "",
            subrole: "",
          },
          image: { jpegBase64: "", width: capture.width, height: capture.height },
          timings: {},
        },
        note,
      },
    });
    restoredResources.add(resourceKey);
  }
}
