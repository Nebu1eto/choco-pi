import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  focusEstablishedBy,
  outcomeAfterCheck,
  outcomeAfterObservedValues,
  prepareAction,
  type ActionState,
  type PreparedAction,
} from "../actions.ts";
import { getComputerUseConfig } from "../config.ts";
import type { ActParams, UiAction } from "../contract.ts";
import { noteAfterAct, noteRegionKeyForRef, type WindowNote } from "../note.ts";
import { nodeByRef, type LookResponse, type Outline } from "../outline.ts";
import { currentPlatformBackend } from "../platform/index.ts";
import {
  HelperInterruption,
  PlatformCommandError,
  type HelperInterruptionState,
  type PlatformRoot as HelperWindow,
} from "../platform/types.ts";
import type { OperationState } from "../state.ts";
import { actionLabel } from "../tool-params.ts";
import {
  aggregateExecutions,
  batchPreparationError,
  deliveredActionsText,
  ensurePointIsInLookImage,
  errorEffectPossible,
  executionTraceFromAct,
  helperAct,
  helperActRequest,
  refusalForResult,
  restoreFocusAfterGrantedInput,
  stoppedSummary,
} from "./helper-act.ts";
import { buildToolResult, captureCurrentTarget, noteWindowForTarget } from "./observation.ts";
import {
  conditionScopeNode,
  outlineConditionPresent,
  platformRole,
  validateCondition,
} from "./read-wait.ts";
import {
  AUTO_IMAGE_MAX_DIMENSION,
  COMMAND_TIMEOUT_MS,
  currentLookOrThrow,
  detailsConfig,
  executionTrace,
  operationState,
  outlineNodeByRef,
  outlineNodeCenter,
  settleMsForExecution,
  sleep,
  validateStateId,
  wireRefForNode,
  withWindowWriteLock,
} from "./state-store.ts";
import {
  ensureTargetWindowId,
  listWindows,
  nativeWindowRequest,
  resolveCurrentTarget,
} from "./targets.ts";
import type {
  ComputerUseDetails,
  DesktopDispatch,
  DesktopDispatchFailure,
  ExecutionTrace,
  ForegroundRefusal,
  ForegroundSession,
  HelperInterruptionOutcome,
  InterruptedExecutionTrace,
  NativePreparedAction,
  ResolvedTarget,
  TerminalDesktopActionDetails,
  UnverifiedAction,
} from "./types.ts";

export function prepareUiAction(
  action: UiAction,
  state: ActionState,
  look: LookResponse,
  headless: boolean,
): PreparedAction {
  return prepareAction(action, state, {
    headless,
    image: look.image,
    node: outlineNodeByRef,
    center: outlineNodeCenter,
    validatePoint: (x, y, label) => ensurePointIsInLookImage(x, y, look, label),
  });
}

export function isKeyboardUiAction(action: UiAction): action is UiAction & {
  action: "typeText" | "keypress";
} {
  return action.action === "typeText" || action.action === "keypress";
}

export function prepareDesktopTransaction(
  actions: UiAction[],
  look: LookResponse,
  headless: boolean,
): NativePreparedAction[] {
  const state: ActionState = { currentFocus: false };
  return actions.map((action, index) => {
    let prepared: PreparedAction;
    try {
      prepared = prepareUiAction(action, state, look, headless);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw batchPreparationError(actions, index, error);
    }
    if (prepared.action === "wait")
      throw new Error("Native action transactions cannot contain wait actions.");
    if (focusEstablishedBy(prepared, headless)) state.currentFocus = true;
    return prepared;
  });
}

export function usesImplicitFocus(prepared: NativePreparedAction[]): boolean {
  return prepared.some(
    (action) =>
      (action.action === "typeText" || action.action === "keypress") && action.implicitFocus,
  );
}

export async function assertImplicitFocusWindow(
  target: ResolvedTarget,
  signal?: AbortSignal,
): Promise<void> {
  const windows = await listWindows(target.pid, signal);
  const isTargetWindow = (window: HelperWindow): boolean =>
    (target.nativeWindowRef !== undefined && window.windowRef === target.nativeWindowRef) ||
    (target.windowId > 0 && window.windowId === target.windowId);
  const focused = windows.filter((window) => window.isFocused);
  const holders = focused.length > 0 ? focused : windows.filter((window) => window.isMain);
  const other = holders.find((window) => !isTargetWindow(window));
  if (!other || holders.some(isTargetWindow)) return;
  throw new Error(
    `Keyboard input without ref goes to ${target.appName}'s focused element, which is in window "${other.title || "(untitled)"}", not this state's window "${target.windowTitle}". Nothing was sent. Pass an @e ref from this state, or observe that window first.`,
  );
}

export async function dispatchUiTransaction(
  prepared: NativePreparedAction[],
  target: ResolvedTarget,
  headless: boolean,
  signal?: AbortSignal,
  ctx?: ExtensionContext,
): Promise<DesktopDispatch> {
  if (headless && currentPlatformBackend.actBatch) {
    const textLength = prepared.reduce(
      (sum, action) => sum + ("text" in action.params ? action.params.text.length : 0),
      0,
    );
    const timeoutMs = Math.max(COMMAND_TIMEOUT_MS, textLength * 25 + 6_000);
    const requests = prepared.map((action) =>
      helperActRequest(target, action, "ax_only", timeoutMs),
    );
    const result = await currentPlatformBackend.actBatch(requests, {
      signal,
      timeoutMs,
    });
    if (!result.steps || result.steps.length === 0)
      throw new Error("Native action transaction returned no checked steps.");
    const execution = aggregateExecutions(
      result.steps.map((step, index) => {
        const trace = executionTraceFromAct(step, "ax_only");
        trace.requestId = requests[index]?.requestId;
        const action = prepared[index];
        const refusal = action && refusalForResult(target, action, true, "ax_only", step);
        if (refusal) {
          trace.outcome = "didnt";
          trace.refusal = refusal;
        }
        return trace;
      }),
    );
    const batchTrace = executionTraceFromAct(result, "ax_only");
    execution.outcome = result.outcome;
    execution.performed = result.performed;
    execution.rootDelta = batchTrace.rootDelta;
    execution.stoppedAt = result.stoppedAt ?? execution.stoppedAt;
    execution.frontmostBefore = batchTrace.frontmostBefore;
    execution.frontmostAfter = batchTrace.frontmostAfter;
    return { execution };
  }
  const steps: ExecutionTrace[] = [];
  const session: ForegroundSession = { ctx, focusCaptured: false };
  let failure: DesktopDispatchFailure | undefined;
  for (const [index, action] of prepared.entries()) {
    session.lastRequest = undefined;
    let step: ExecutionTrace;
    try {
      step = await helperAct(target, action, headless, signal, session);
    } catch (error) {
      if (signal?.aborted || !(error instanceof Error)) throw error;
      failure = {
        index,
        error,
        request: session.lastRequest,
        interruption: helperInterruption(error),
      };
      break;
    }
    steps.push(step);
    if (step.refusal || step.outcome === "didnt") break;
  }
  const execution = aggregateExecutions(steps);
  const state = failure?.interruption?.execution.state;
  if (state !== undefined && !TERMINAL_INTERRUPTION_STATES.has(state)) {
    if (steps.some((step) => step.foregroundGrant === true)) {
      execution.focusRestored = false;
      execution.focusRestoreReason = "delivery_may_continue";
    }
  } else {
    await restoreFocusAfterGrantedInput(execution, target, session, signal);
  }
  return { execution, failure };
}

export const TERMINAL_INTERRUPTION_STATES: ReadonlySet<HelperInterruptionState> = new Set([
  "stopped",
  "completed",
  "refused",
]);

export function unverifiedActions(
  execution: ExecutionTrace,
  actions: UiAction[],
): UnverifiedAction[] {
  if (execution.outcome === "worked") return [];
  const steps = execution.steps;
  return actions.flatMap((action, index) => {
    const outcome = (steps ? steps[index]?.outcome : execution.outcome) ?? "unknown";
    return outcome === "worked" ? [] : [{ index, action, outcome }];
  });
}

export function unverifiedEffectText(unverified: UnverifiedAction[]): string {
  if (unverified.length === 0) return "";
  const listed = unverified
    .map(
      ({ index, action, outcome }) =>
        `action ${index + 1} (${actionLabel(action.action)}: ${outcome})`,
    )
    .join(", ");
  return ` Effect not verified for ${listed}; confirm it in the returned state before reporting success.`;
}

export function markUnverifiedRegions(
  note: WindowNote | undefined,
  outline: Outline,
  unverified: UnverifiedAction[],
): void {
  if (!note) return;
  for (const { action } of unverified) {
    const ref = action.ref?.trim();
    const key = ref ? noteRegionKeyForRef(outline, ref) : undefined;
    const region = key ? note.regions.find((candidate) => candidate.key === key) : undefined;
    if (!region) continue;
    region.detail =
      region.detail === "acted here"
        ? "acted here; some effects not verified"
        : "effect not verified";
  }
}

export function exactPlatformRootMatchesTarget(
  root: HelperWindow,
  target: ResolvedTarget,
): boolean {
  if (root.pid !== target.pid) return false;
  const nativeRefMatches = Boolean(
    target.nativeWindowRef &&
    (root.rootRef === target.nativeWindowRef || root.windowRef === target.nativeWindowRef),
  );
  const windowIdMatches = target.windowId > 0 && root.windowId === target.windowId;
  return nativeRefMatches || windowIdMatches;
}

export function clearDesktopOperationState(state: OperationState): void {
  state.currentTarget = undefined;
  state.currentCapture = undefined;
  state.currentStateTarget = undefined;
  state.currentLook = undefined;
  state.currentOutline = undefined;
  state.currentNote = undefined;
}

export async function terminalDesktopActionResult(
  target: ResolvedTarget,
  baseStateId: string,
  execution: ExecutionTrace,
  cause: unknown,
  condition?: ReturnType<typeof validateCondition>,
): Promise<AgentToolResult<TerminalDesktopActionDetails>> {
  let exactRootAvailable: boolean | undefined;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const roots = await currentPlatformBackend.listRoots({ pid: target.pid });
      exactRootAvailable = roots.some((root) => exactPlatformRootMatchesTarget(root, target));
      if (exactRootAvailable) break;
      if (attempt < 2) await sleep(75);
    }
  } catch {}
  const targetClosed = exactRootAvailable === false;
  if (
    targetClosed &&
    !(execution.rootDelta ?? []).some(
      (delta) =>
        delta.change === "closed" &&
        delta.pid === target.pid &&
        (delta.ref === target.windowRef || delta.ref === target.nativeWindowRef),
    )
  ) {
    execution.rootDelta = [
      ...(execution.rootDelta ?? []),
      {
        change: "closed",
        kind: "window",
        ref: target.windowRef,
        title: target.windowTitle,
        pid: target.pid,
        metadata: { source: "post_action_identity_probe" },
      },
    ];
  }
  if (targetClosed && condition) {
    const verificationStatus = condition.gone ? "verified" : "failed";
    execution.verification = {
      status: verificationStatus,
      text: condition.text,
      role: condition.role,
      value: condition.value,
      gone: condition.gone || undefined,
      timeoutMs: condition.timeoutMs,
    };
    execution.outcome = outcomeAfterCheck(execution.outcome ?? "unknown", verificationStatus);
    if (verificationStatus === "failed") {
      execution.error = {
        code: "postcondition_failed",
        message:
          "The source root closed before the requested presence or value postcondition could be verified.",
      };
    }
  }
  const status = targetClosed ? "target_closed" : "post_action_observation_failed";
  const code = targetClosed ? "target_closed" : "post_action_observation_failed";
  const message = cause instanceof Error ? cause.message : String(cause);
  clearDesktopOperationState(operationState());
  const details: TerminalDesktopActionDetails = {
    tool: "act_ui",
    status,
    baseStateId,
    target: {
      app: target.appName,
      bundleId: target.bundleId,
      pid: target.pid,
      windowTitle: target.windowTitle,
      windowId: target.windowId,
      windowRef: target.windowRef,
      nativeWindowRef: target.nativeWindowRef,
    },
    execution,
    error: { code, message },
  };
  const result = targetClosed
    ? `The action was delivered, and its source root ${target.appName} — ${target.windowTitle} closed before a successor observation could be captured.`
    : `The action was delivered, but its source root ${target.appName} — ${target.windowTitle} could not be observed afterward: ${message}`;
  return {
    content: [
      {
        type: "text",
        text: `${result}\nNo successor state was created. Call find_roots, then observe_ui to continue.`,
      },
    ],
    details,
  };
}

export function foregroundRequiredResult(
  target: ResolvedTarget,
  baseStateId: string,
  execution: ExecutionTrace,
  refusal: ForegroundRefusal,
): AgentToolResult<TerminalDesktopActionDetails> {
  const details: TerminalDesktopActionDetails = {
    tool: "act_ui",
    status: "foreground_required",
    baseStateId,
    target: {
      app: target.appName,
      bundleId: target.bundleId,
      pid: target.pid,
      windowTitle: target.windowTitle,
      windowId: target.windowId,
      windowRef: target.windowRef,
      nativeWindowRef: target.nativeWindowRef,
    },
    execution,
    error: { code: refusal.code, message: refusal.reason },
    config: detailsConfig(),
  };
  if (refusal.nextStep) details.nextStep = refusal.nextStep;
  const step = execution.stoppedAt === undefined ? "" : ` (action ${execution.stoppedAt + 1})`;
  const noEffect = refusal.nextStep
    ? `The input was sent to ${target.appName} in the background and produced no observable change; it was not repeated in the foreground in this call.`
    : refusal.pidPointerAttempted
      ? "The refused action was posted as background pointer input and produced no observable change."
      : "The refused action delivered no input.";
  const effect = refusal.effectPossible
    ? "The refused action may still have reached the app; observe before continuing."
    : noEffect;
  const prefix =
    execution.stoppedAt !== undefined && execution.stoppedAt > 0
      ? " Earlier actions in this call were delivered."
      : "";
  return {
    content: [
      {
        type: "text",
        text: [
          `foreground_required: ${actionLabel(refusal.action)}${step} in ${target.appName} — ${target.windowTitle} needs ${refusal.capability}, which requires granted foreground delivery. It will not be retried automatically.`,
          `${effect}${prefix}`,
          refusal.grantHint,
          refusal.nextStep
            ? `next step: observe_then_retry — call observe_ui on ${target.appName} — ${target.windowTitle} before acting on it again.`
            : "Call observe_ui for a fresh state before the next act_ui.",
        ].join("\n"),
      },
    ],
    details,
  };
}

export function helperInterruption(error: Error): HelperInterruptionOutcome | undefined {
  const interruption =
    "interruption" in error && error.interruption instanceof HelperInterruption
      ? error.interruption
      : undefined;
  if (!interruption) return undefined;
  const effectPossible = interruption.effectPossible !== false;
  if (interruption.code === "owned_by_other_session") {
    return {
      code: "owned_by_other_session",
      message: error.message,
      execution: { strategy: "act", outcome: "rejected_before_delivery", effectPossible },
    };
  }
  const { result, cancel, state } = interruption;
  const stopping = state === "stopping";
  const execution: InterruptedExecutionTrace = {
    strategy: "act",
    outcome:
      !stopping && (result?.outcome === "rejected_before_delivery" || !effectPossible)
        ? "rejected_before_delivery"
        : "partial",
    effectPossible: stopping || effectPossible,
    state,
  };
  const stoppedAt = result?.stoppedAt ?? cancel?.stoppedAt;
  if (stoppedAt !== undefined) execution.stoppedAt = stoppedAt;
  const reason = result?.reason ?? (interruption.clientTimeout ? "client_timeout" : undefined);
  if (reason) execution.reason = reason;
  if (interruption.reason) execution.stateReason = interruption.reason;
  if (cancel) execution.cancel = cancel;
  return { code: "cancelled", message: error.message, execution };
}

export function cancelledHeadline(execution: InterruptedExecutionTrace): string {
  const at = execution.stoppedAt === undefined ? "" : ` at action ${execution.stoppedAt + 1}`;
  switch (execution.state) {
    case "stopping":
      return `cancelled: the helper acknowledged the cancel but had not stopped this act_ui request; ${execution.stateReason ?? "delivery may continue until the helper reports stopped"}.`;
    case "completed":
      return "cancelled: the act_ui request completed in the helper before the cancel reached it; its result was not received.";
    case "not_found":
      return "cancelled: the helper had not registered this act_ui request; it refuses the request if it arrives within 60 s.";
    case "unacknowledged":
      return "cancelled: the helper did not acknowledge the cancel; whether this act_ui request is still delivering is unknown.";
    default:
      return `cancelled: the helper stopped this act_ui request (${execution.outcome}${at}).`;
  }
}

export function helperInterruptedResult(
  target: ResolvedTarget,
  baseStateId: string,
  interruption: HelperInterruptionOutcome,
  delivered?: { index: number; execution: ExecutionTrace },
): AgentToolResult<TerminalDesktopActionDetails> {
  const { code, message } = interruption;
  const execution: InterruptedExecutionTrace = delivered
    ? {
        ...interruption.execution,
        outcome: "partial",
        effectPossible: true,
        stoppedAt: delivered.index,
        steps: delivered.execution.steps,
        focusRestored: delivered.execution.focusRestored,
        focusRestoreReason: delivered.execution.focusRestoreReason,
      }
    : interruption.execution;
  if (execution.effectPossible) clearDesktopOperationState(operationState());
  const details: TerminalDesktopActionDetails = {
    tool: "act_ui",
    status: code,
    baseStateId,
    target: {
      app: target.appName,
      bundleId: target.bundleId,
      pid: target.pid,
      windowTitle: target.windowTitle,
      windowId: target.windowId,
      windowRef: target.windowRef,
      nativeWindowRef: target.nativeWindowRef,
    },
    execution,
    error: { code, message },
    config: detailsConfig(),
  };
  const ownership = delivered
    ? `owned_by_other_session: the computer-use helper is controlled by another session; it refused action ${delivered.index + 1} on ${target.appName} — ${target.windowTitle}.`
    : `owned_by_other_session: the computer-use helper is controlled by another session; ${target.appName} — ${target.windowTitle} was not touched by this request.`;
  const headline = code === "owned_by_other_session" ? ownership : cancelledHeadline(execution);
  return {
    content: [
      { type: "text", text: `${headline}\n${interruptedEffectText(execution, delivered)}` },
    ],
    details,
  };
}

export function interruptedEffectText(
  execution: InterruptedExecutionTrace,
  delivered: { index: number } | undefined,
): string {
  if (delivered)
    return `${deliveredActionsText(delivered.index)} before the interruption; call observe_ui before continuing.`;
  if (execution.effectPossible)
    return "Some input may already have reached the app; call observe_ui before continuing.";
  return "The helper reported that this request delivered no input. Earlier actions in the same call may have been delivered.";
}

export function refusalMayHaveChangedUi(
  execution: ExecutionTrace,
  refusal: ForegroundRefusal,
): boolean {
  return (
    (execution.stoppedAt ?? 0) > 0 ||
    refusal.effectPossible ||
    refusal.pidPointerAttempted === true ||
    execution.retryDeferred === true
  );
}

export function failedStepTrace(failure: DesktopDispatchFailure): ExecutionTrace {
  const effectPossible = errorEffectPossible(failure.error);
  const code =
    (failure.error instanceof PlatformCommandError ? failure.error.code : undefined) ??
    "action_failed";
  return executionTrace("act", "default", {
    outcome: effectPossible ? "unknown" : "didnt",
    error: { code, message: failure.error.message, effectPossible },
    deliveryPolicy: failure.request?.policy,
    requestId: failure.request?.requestId,
  });
}

export async function performDesktopTransaction(
  params: ActParams,
  actions: UiAction[],
  signal?: AbortSignal,
  ctx?: ExtensionContext,
): Promise<AgentToolResult<ComputerUseDetails | TerminalDesktopActionDetails>> {
  const state = operationState();
  state.currentImageMode = "auto";
  validateStateId(params.stateId);
  const look = currentLookOrThrow();
  const baseView = { stateId: state.currentCapture!.stateId, outline: state.currentOutline! };
  const condition = params.expect ? validateCondition(params.expect) : undefined;
  const scopeNode = condition ? conditionScopeNode(look.parsedOutline!, condition) : undefined;
  const headless = getComputerUseConfig().headless;
  const prepared = prepareDesktopTransaction(actions, look, headless);
  const target = await ensureTargetWindowId(await resolveCurrentTarget(signal), signal);
  const noteBefore = state.currentNote;
  if (usesImplicitFocus(prepared)) await assertImplicitFocusWindow(target, signal);
  return await withWindowWriteLock(target, async () => {
    let dispatched: DesktopDispatch;
    try {
      dispatched = await dispatchUiTransaction(prepared, target, headless, signal, ctx);
    } catch (error) {
      const interruption =
        signal?.aborted || !(error instanceof Error) ? undefined : helperInterruption(error);
      if (!interruption) throw error;
      return helperInterruptedResult(target, baseView.stateId, interruption);
    }
    const { failure } = dispatched;
    let execution = dispatched.execution;
    if (failure?.interruption)
      return helperInterruptedResult(
        target,
        baseView.stateId,
        failure.interruption,
        failure.index > 0 ? { index: failure.index, execution } : undefined,
      );
    if (failure?.index === 0) throw failure.error;
    if (execution.refusal) {
      if (refusalMayHaveChangedUi(execution, execution.refusal)) clearDesktopOperationState(state);
      return foregroundRequiredResult(target, baseView.stateId, execution, execution.refusal);
    }
    if (failure) {
      const failedStep = failedStepTrace(failure);
      const { focusRestored, focusRestoreReason } = execution;
      execution = aggregateExecutions([...(execution.steps ?? []), failedStep]);
      execution.stoppedAt = failure.index;
      execution.error = failedStep.error;
      execution.focusRestored = focusRestored;
      execution.focusRestoreReason = focusRestoreReason;
    }
    const executedActions = actions.slice(0, execution.actionCount ?? actions.length);
    try {
      if (condition && !failure) {
        const {
          text: expectedText,
          role: expectedRole,
          value: expectedValue,
          scopeExact,
          gone,
          timeoutMs,
        } = condition;
        const beforePresent = outlineConditionPresent(look.parsedOutline!, condition);
        const desiredWasPreexisting = beforePresent !== gone;
        const verification = await currentPlatformBackend.waitFor(
          {
            ...nativeWindowRequest(target),
            lookId: look.parsedOutline!.lookId,
            text: expectedText,
            role: platformRole(look.parsedOutline!, expectedRole),
            value: expectedValue,
            scopeRef: scopeNode ? wireRefForNode(scopeNode) : undefined,
            scopeExact,
            gone,
            timeoutMs,
          },
          { signal, timeoutMs: timeoutMs + 2_000 },
        );
        execution.verification = {
          status: verification.found
            ? desiredWasPreexisting
              ? "preexisting"
              : "verified"
            : "failed",
          text: expectedText,
          role: expectedRole,
          value: expectedValue,
          gone: gone || undefined,
          timeoutMs,
        };
        execution.outcome = outcomeAfterCheck(
          execution.outcome ?? "unknown",
          execution.verification.status,
        );
        if (!verification.found) {
          execution.error = {
            code: "postcondition_failed",
            message: `The action was delivered but its postcondition was not satisfied within ${timeoutMs}ms.`,
          };
        }
      } else {
        await sleep(settleMsForExecution(execution), signal);
      }
      const capture = await captureCurrentTarget(signal, "auto", AUTO_IMAGE_MAX_DIMENSION, target);
      if (!failure)
        execution.outcome = outcomeAfterObservedValues(
          execution.outcome ?? "unknown",
          executedActions,
          (ref) => nodeByRef(capture.outline, ref)?.value,
        );
      const unverified = unverifiedActions(execution, executedActions);
      const unverifiedIndexes = new Set(unverified.map((entry) => entry.index));
      for (const [index, action] of executedActions.entries()) {
        state.currentNote = noteAfterAct(
          state.currentNote ?? noteBefore,
          unverifiedIndexes.has(index) ? undefined : action.ref,
          capture.outline,
          {
            window: noteWindowForTarget(capture.target, capture.look),
            rootDelta: execution.rootDelta,
          },
        );
      }
      markUnverifiedRegions(state.currentNote, capture.outline, unverified);
      const plural = executedActions.length === 1 ? "" : "s";
      const summary = failure
        ? partialSummary(failure, actions, capture.capture.stateId, target)
        : `Executed ${executedActions.length} checked UI action${plural} in ${target.appName} — ${target.windowTitle}. Returned state ${capture.capture.stateId}.`;
      const result = await buildToolResult(
        "act_ui",
        `${summary}${unverifiedEffectText(unverified)}`,
        capture,
        execution,
        signal,
        state.currentImageMode,
        baseView,
      );
      if (failure) result.details.status = "partial";
      return result;
    } catch (error) {
      if (signal?.aborted) {
        clearDesktopOperationState(state);
        throw error;
      }
      return await terminalDesktopActionResult(
        target,
        baseView.stateId,
        execution,
        error,
        condition,
      );
    }
  });
}

export function partialSummary(
  failure: DesktopDispatchFailure,
  actions: UiAction[],
  stateId: string,
  target: ResolvedTarget,
): string {
  return `${stoppedSummary(failure, actions, `${target.appName} — ${target.windowTitle}`, "the app")} Returned state ${stateId}.`;
}
