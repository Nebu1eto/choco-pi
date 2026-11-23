import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { outcomeAfterCheck } from "../actions.ts";
import {
  CdpActionError,
  cdpClickAtForContext,
  cdpClickForContext,
  cdpDragForContext,
  cdpKeypressForContext,
  cdpKeysProblem,
  cdpMouseForContext,
  cdpPreflightForContext,
  cdpScrollForContext,
  cdpSnapshotForContext,
  cdpTypeFocusedForContext,
  cdpTypeForContext,
  listCdpPageContexts,
  type CdpPageSnapshot,
} from "../cdp.ts";
import type { ActParams, UiAction } from "../contract.ts";
import { nodeByRef, restoreOutline, type Outline } from "../outline.ts";
import { toFiniteNumber } from "../platform/coerce.ts";
import { StaleResourceStateError } from "../runtime.ts";
import { actionLabel } from "../tool-params.ts";
import {
  browserContextForOperation,
  browserResourceKey,
  refreshBrowserSnapshot,
  withBrowserWrite,
} from "./browser-session.ts";
import {
  asSentence,
  batchPreparationError,
  errorEffectPossible,
  stoppedSummary,
} from "./helper-act.ts";
import { conditionScopeNode, outlineConditionPresent, validateCondition } from "./read-wait.ts";
import {
  BROWSER_TRANSACTION_ACTIONS,
  executionTrace,
  operationState,
  resourceScheduler,
  sleep,
  storeBrowserRootRef,
  throwIfAborted,
  trimOrUndefined,
} from "./state-store.ts";
import type {
  BrowserBase,
  BrowserDispatchFailure,
  BrowserObservationDetails,
  BrowserPoint,
  BrowserPreparedAction,
  ExecutionTrace,
  TerminalBrowserActionDetails,
} from "./types.ts";

/** The backend node a prepared browser action targets, if any. */
export function browserActionNode(action: BrowserPreparedAction): number | undefined {
  if (action.action === "click")
    return "backendNodeId" in action.target ? action.target.backendNodeId : undefined;
  if (action.action === "drag" || action.action === "moveMouse") return undefined;
  return action.backendNodeId;
}

/** The backend node id of an actionable ref in the base state. */
export function browserRefNode(
  base: BrowserBase,
  operation: string,
  ref: string | undefined,
): number {
  if (!ref)
    throw new Error(
      `Browser ${actionLabel(operation)} requires an actionable @e ref owned by ${base.stateId}.`,
    );
  const target = base.snapshot.targets.find((candidate) => candidate.ref === ref);
  if (!target)
    throw new Error(
      nodeByRef(base.outline, ref)
        ? `Browser ${actionLabel(operation)} ref '${ref}' is in state ${base.stateId} but is not an actionable control; browser actions target named buttons, links, and text inputs.`
        : `Browser ${actionLabel(operation)} ref '${ref}' is not in state ${base.stateId}; pass a ref from this state.`,
    );
  if (target.backendNodeId === undefined || !Number.isFinite(target.backendNodeId))
    throw new Error(
      `Browser ${actionLabel(operation)} requires an actionable @e ref owned by ${base.stateId}.`,
    );
  return target.backendNodeId;
}

/** A finite point inside the viewport recorded with the base state (unchecked when none was recorded). */
export function browserPoint(
  base: BrowserBase,
  x: number | undefined,
  y: number | undefined,
  label: string,
): BrowserPoint {
  const px = toFiniteNumber(x, NaN);
  const py = toFiniteNumber(y, NaN);
  if (!Number.isFinite(px) || !Number.isFinite(py))
    throw new Error(`${label} requires finite x and y coordinates.`);
  const viewport = base.snapshot.viewport;
  if (viewport && (px < 0 || py < 0 || px >= viewport.width || py >= viewport.height))
    throw new Error(
      `${label} (${px}, ${py}) is outside the page viewport, ${viewport.width}x${viewport.height} CSS pixels in state ${base.stateId}.`,
    );
  return { x: px, y: py };
}

export function prepareBrowserAction(action: UiAction, base: BrowserBase): BrowserPreparedAction {
  if (!BROWSER_TRANSACTION_ACTIONS.has(action.action))
    throw new Error(`Browser transactions do not support '${actionLabel(action.action)}'.`);
  const ref = trimOrUndefined(action.ref);
  const clickCount = action.clickCount ?? 1;
  switch (action.action) {
    case "press":
      return { action: "press", backendNodeId: browserRefNode(base, "press", ref), clickCount };
    case "click":
      if (ref) {
        if (action.button && action.button !== "left")
          throw new Error(
            "Browser ref clicks support only the left button; use coordinate clicks for right or middle buttons.",
          );
        return {
          action: "click",
          target: { backendNodeId: browserRefNode(base, "click", ref) },
          button: "left",
          clickCount,
        };
      }
      return {
        action: "click",
        target: browserPoint(base, action.x, action.y, "click"),
        button: action.button ?? "left",
        clickCount,
      };
    case "setText":
      return {
        action: "setText",
        backendNodeId: browserRefNode(base, "setText", ref),
        text: action.text ?? "",
      };
    case "typeText":
      return {
        action: "typeText",
        backendNodeId: ref ? browserRefNode(base, "typeText", ref) : undefined,
        text: action.text ?? "",
      };
    case "keypress": {
      const keys = Array.isArray(action.keys) ? action.keys.map((key) => String(key)) : [];
      const problem = cdpKeysProblem(keys);
      if (problem) throw new Error(problem);
      return {
        action: "keypress",
        backendNodeId: ref ? browserRefNode(base, "keypress", ref) : undefined,
        keys,
      };
    }
    case "scroll":
      if (action.x !== undefined || action.y !== undefined)
        throw new Error(
          "Browser scroll does not take x/y: pass the @e ref of the element to scroll, or omit the target to scroll the page.",
        );
      return {
        action: "scroll",
        backendNodeId: ref ? browserRefNode(base, "scroll", ref) : undefined,
        scrollX: toFiniteNumber(action.scrollX, 0),
        scrollY: toFiniteNumber(action.scrollY, 0),
      };
    case "drag": {
      const points = Array.isArray(action.path) ? action.path : [];
      if (points.length < 2) throw new Error("drag.path must contain at least two points.");
      return {
        action: "drag",
        path: points.map((point, index) =>
          browserPoint(base, point.x, point.y, `Drag point ${index + 1}`),
        ),
      };
    }
    case "moveMouse":
      if (ref)
        throw new Error(
          "Browser move_mouse takes x and y only; browser outlines carry no element coordinates.",
        );
      return { action: "moveMouse", ...browserPoint(base, action.x, action.y, "move_mouse") };
  }
}

/** Prepares every browser action before anything is sent (see prepareDesktopTransaction). */
export function prepareBrowserTransaction(
  actions: UiAction[],
  base: BrowserBase,
): BrowserPreparedAction[] {
  return actions.map((action, index) => {
    try {
      return prepareBrowserAction(action, base);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw batchPreparationError(actions, index, error);
    }
  });
}

/**
 * Read-only check before the write lock, so a refusal keeps the base state
 * valid: the page target still exists and every targeted node still resolves.
 * It holds the resource at the base epoch; a newer write makes it stale.
 */
export async function preflightBrowserTransaction(
  prepared: BrowserPreparedAction[],
  actions: UiAction[],
  base: BrowserBase,
  contextId: string,
  signal?: AbortSignal,
): Promise<void> {
  const nodes = prepared.map(browserActionNode);
  const ids = [...new Set(nodes.filter((node): node is number => node !== undefined))];
  const resourceKey = browserResourceKey(contextId);
  const baseEpoch = operationState().epoch ?? resourceScheduler.epoch(resourceKey);
  let checked: { unresolved: number[] } | undefined;
  try {
    const scheduled = await resourceScheduler.readAt(
      resourceKey,
      baseEpoch,
      async () => await cdpPreflightForContext(contextId, ids, signal),
    );
    checked = scheduled.value;
  } catch (error) {
    if (signal?.aborted || error instanceof StaleResourceStateError || !(error instanceof Error))
      throw error;
    throw new Error(
      `Could not check the browser page before sending: ${asSentence(error.message)} Nothing was sent.`,
      { cause: error },
    );
  }
  if (!checked)
    throw new Error(
      `The browser page of state ${base.stateId} is no longer available. Nothing was sent. Call find_roots and observe_ui again.`,
    );
  const unresolved = new Set(checked.unresolved);
  const index = nodes.findIndex((node) => node !== undefined && unresolved.has(node));
  if (index >= 0)
    throw batchPreparationError(
      actions,
      index,
      new Error(
        `Ref '${trimOrUndefined(actions[index]?.ref) ?? ""}' no longer resolves to an element on the page; the page changed after state ${base.stateId}. Observe the page again.`,
      ),
    );
}

/** Sends one prepared action; false when the page target was gone before any input of it was sent. */
export async function deliverBrowserAction(
  action: BrowserPreparedAction,
  contextId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  switch (action.action) {
    case "press":
    case "click": {
      if (action.action === "click" && !("backendNodeId" in action.target))
        return await cdpClickAtForContext(
          contextId,
          action.target.x,
          action.target.y,
          action.button,
          action.clickCount,
          signal,
        );
      const node = browserActionNode(action);
      if (node === undefined) return false;
      for (let count = 0; count < action.clickCount; count += 1) {
        throwIfAborted(signal);
        let clicked: boolean;
        try {
          clicked = await cdpClickForContext(contextId, node, signal);
        } catch (error) {
          if (count === 0 || signal?.aborted || !(error instanceof CdpActionError)) throw error;
          // An earlier click of this action was sent, so it may have taken effect.
          throw new CdpActionError(error.message, error.code, true, { cause: error });
        }
        if (clicked) continue;
        if (count === 0) return false;
        // An earlier click of this action was sent.
        throw new CdpActionError(
          "The browser page is no longer available.",
          "browser_page_unavailable",
          true,
        );
      }
      return true;
    }
    case "setText":
      return await cdpTypeForContext(contextId, action.backendNodeId, action.text, true, signal);
    case "typeText":
      return action.backendNodeId === undefined
        ? await cdpTypeFocusedForContext(contextId, action.text, signal)
        : await cdpTypeForContext(contextId, action.backendNodeId, action.text, false, signal);
    case "keypress":
      return await cdpKeypressForContext(contextId, action.keys, signal, action.backendNodeId);
    case "scroll":
      return await cdpScrollForContext(
        contextId,
        action.scrollX,
        action.scrollY,
        action.backendNodeId,
        signal,
      );
    case "drag":
      return await cdpDragForContext(contextId, action.path, signal);
    case "moveMouse":
      return await cdpMouseForContext(
        contextId,
        action.x,
        action.y,
        "mouseMoved",
        "left",
        1,
        signal,
      );
  }
}

/**
 * Sends the prepared actions in order and stops at the first failure, keeping
 * the record of the delivered ones. Caller aborts keep propagating.
 */
export async function dispatchBrowserTransaction(
  prepared: BrowserPreparedAction[],
  contextId: string,
  signal?: AbortSignal,
): Promise<{ steps: ExecutionTrace[]; failure?: BrowserDispatchFailure }> {
  const steps: ExecutionTrace[] = [];
  for (const [index, action] of prepared.entries()) {
    throwIfAborted(signal);
    let delivered: boolean;
    try {
      delivered = await deliverBrowserAction(action, contextId, signal);
    } catch (error) {
      if (signal?.aborted || !(error instanceof Error)) throw error;
      return { steps, failure: { index, error } };
    }
    throwIfAborted(signal);
    if (!delivered)
      return {
        steps,
        failure: {
          index,
          error: new CdpActionError(
            "The browser page is no longer available. Call find_roots and observe_ui again.",
            "browser_page_unavailable",
            false,
          ),
        },
      };
    steps.push(executionTrace("cdp_act", "default", { outcome: "unknown" }));
  }
  return { steps };
}

/** The failed browser action's step: the error and whether it may have landed. */
export function failedBrowserStepTrace(error: Error): ExecutionTrace {
  const effectPossible = errorEffectPossible(error);
  return executionTrace("cdp_act", "default", {
    outcome: effectPossible ? "unknown" : "didnt",
    error: {
      code: error instanceof CdpActionError ? error.code : "action_failed",
      message: error.message,
      effectPossible,
    },
  });
}

/** Polls the page until the postcondition holds or times out; records it like the desktop path. */
export async function verifyBrowserCondition(
  contextId: string,
  condition: ReturnType<typeof validateCondition>,
  baseOutline: Outline,
  execution: ExecutionTrace,
  signal?: AbortSignal,
): Promise<void> {
  const { text, role, value, gone, timeoutMs } = condition;
  const desiredWasPreexisting = outlineConditionPresent(baseOutline, condition) !== gone;
  const deadline = Date.now() + timeoutMs;
  let satisfied = false;
  do {
    const snapshot = await cdpSnapshotForContext(contextId);
    if (!snapshot)
      throw new Error(`Browser root '${contextId}' is no longer available. Observe it again.`);
    satisfied = outlineConditionPresent(restoreOutline(snapshot.outline), condition) !== gone;
    if (!satisfied) await sleep(100, signal);
  } while (!satisfied && Date.now() < deadline);
  const status = satisfied ? (desiredWasPreexisting ? "preexisting" : "verified") : "failed";
  execution.verification = { status, text, role, value, gone: gone || undefined, timeoutMs };
  execution.outcome = outcomeAfterCheck(execution.outcome ?? "unknown", status);
  if (!satisfied)
    execution.error = {
      code: "postcondition_failed",
      message: `The action was delivered but its postcondition was not satisfied within ${timeoutMs}ms.`,
    };
}

export async function terminalBrowserActionResult(
  contextId: string,
  base: CdpPageSnapshot,
  execution: ExecutionTrace,
  cause: unknown,
  stopped: string | undefined,
  condition?: ReturnType<typeof validateCondition>,
): Promise<AgentToolResult<TerminalBrowserActionDetails>> {
  let pageAvailable: boolean | undefined;
  try {
    pageAvailable = (await listCdpPageContexts()).some((page) => page.contextId === contextId);
  } catch {
    // A failed page listing cannot prove that the page closed.
  }
  const targetClosed = pageAvailable === false;
  if (targetClosed && condition && !stopped) {
    const status = condition.gone ? "verified" : "failed";
    execution.verification = {
      status,
      text: condition.text,
      role: condition.role,
      value: condition.value,
      gone: condition.gone || undefined,
      timeoutMs: condition.timeoutMs,
    };
    execution.outcome = outcomeAfterCheck(execution.outcome ?? "unknown", status);
    if (status === "failed")
      execution.error = {
        code: "postcondition_failed",
        message:
          "The browser page closed before the requested presence or value postcondition could be verified.",
      };
  }
  const status = targetClosed ? "target_closed" : "post_action_observation_failed";
  const message = cause instanceof Error ? cause.message : String(cause);
  const details: TerminalBrowserActionDetails = {
    tool: "act_ui",
    kind: "browser_page",
    status,
    baseStateId: base.snapshotId,
    root: {
      ref: storeBrowserRootRef(contextId),
      kind: "browser_page",
      title: base.title,
      url: base.url,
    },
    execution,
    error: { code: status, message },
  };
  const page = `the browser page ${JSON.stringify(base.title)}`;
  const outcome = targetClosed
    ? `${page} closed before a successor observation could be captured.`
    : `${page} could not be observed afterward: ${asSentence(message)}`;
  const headline = stopped
    ? `${stopped} Then ${outcome}`
    : `The actions were delivered, and ${outcome}`;
  return {
    content: [
      {
        type: "text",
        text: `${headline}\nNo successor state was created. Call find_roots, then observe_ui to continue.`,
      },
    ],
    details,
  };
}

export async function performBrowserTransaction(
  params: ActParams,
  actions: UiAction[],
  signal?: AbortSignal,
): Promise<AgentToolResult<BrowserObservationDetails | TerminalBrowserActionDetails>> {
  const contextId = browserContextForOperation();
  if (!contextId) throw new Error("Browser transaction requires a browser observation state.");
  const baseSnapshot = operationState().browserSnapshot;
  if (!baseSnapshot) throw new Error("Browser transaction requires a complete base observation.");
  if (baseSnapshot.contextId !== contextId)
    throw new Error(`Browser state ${baseSnapshot.snapshotId} belongs to another page.`);
  const baseView = { stateId: baseSnapshot.snapshotId, outline: baseSnapshot.outline };
  const base: BrowserBase = {
    stateId: baseSnapshot.snapshotId,
    snapshot: baseSnapshot,
    outline: restoreOutline(baseSnapshot.outline),
  };
  const condition = params.expect ? validateCondition(params.expect) : undefined;
  if (condition) conditionScopeNode(base.outline, condition);
  // Every refusal before the write lock sends nothing and keeps the base state
  // valid: per-action validation first, then the read-only page check.
  const prepared = prepareBrowserTransaction(actions, base);
  await preflightBrowserTransaction(prepared, actions, base, contextId, signal);
  return await withBrowserWrite(contextId, async () => {
    throwIfAborted(signal);
    const { steps, failure } = await dispatchBrowserTransaction(prepared, contextId, signal);
    // Nothing earlier was delivered: the failure is reported as it always was.
    if (failure?.index === 0) throw failure.error;
    const failedStep = failure ? failedBrowserStepTrace(failure.error) : undefined;
    const allSteps = failedStep ? [...steps, failedStep] : steps;
    const execution = executionTrace("cdp_act", "default", {
      outcome: allSteps.some((step) => step.outcome === "didnt") ? "didnt" : "unknown",
      steps: allSteps,
      actionCount: allSteps.length,
    });
    if (failure && failedStep) {
      execution.stoppedAt = failure.index;
      execution.error = failedStep.error;
    }
    const where = JSON.stringify(baseSnapshot.title);
    const stopped = failure ? stoppedSummary(failure, actions, where, "the page") : undefined;
    try {
      if (condition && !failure)
        await verifyBrowserCondition(contextId, condition, base.outline, execution, signal);
      // A partial result leads with the stopped summary in place of the
      // "completed" header, as on the desktop path.
      const result = await refreshBrowserSnapshot(
        contextId,
        "act_ui",
        baseView,
        stopped ? (stateId) => `${stopped} Returned state ${stateId}.` : undefined,
      );
      result.details.execution = execution;
      if (stopped) result.details.status = "partial";
      else if (execution.verification?.status === "failed" && execution.error?.message) {
        result.content = [
          {
            type: "text",
            text: `${execution.error.message} Returned state ${result.details.stateId}.`,
          },
          ...result.content,
        ];
      }
      return result;
    } catch (error) {
      if (signal?.aborted) throw error;
      return await terminalBrowserActionResult(
        contextId,
        baseSnapshot,
        execution,
        error,
        stopped,
        condition,
      );
    }
  });
}
