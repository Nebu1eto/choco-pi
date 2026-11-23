import { randomUUID } from "node:crypto";
import {
  foregroundGrantCovers,
  foregroundPromptMode,
  getComputerUseConfig,
  isSessionDenied,
} from "../config.ts";
import type { UiAction } from "../contract.ts";
import {
  grantPromptGranted,
  promptForegroundGrant,
  type GrantPromptOutcome,
} from "../grant-prompt.ts";
import { isNumber } from "../json.ts";
import type { LookResponse } from "../outline.ts";
import { currentPlatformBackend } from "../platform/index.ts";
import {
  PlatformCommandError,
  type HelperActResult,
  type HelperRefusalEvidence,
  type PlatformActRequest,
  type PlatformActRequestBase,
} from "../platform/types.ts";
import { actionLabel } from "../tool-params.ts";
import {
  COMMAND_TIMEOUT_MS,
  currentDeliveryPolicy,
  currentLookOrThrow,
  executionTrace,
  helperRequestSession,
  nativeInputDelivery,
  operationState,
  runtimeState,
  throwIfAborted,
} from "./state-store.ts";
import { windowRecordIdentity } from "./targets.ts";
import type {
  ActOutcome,
  DeliveryPolicy,
  ExecutionTrace,
  ForegroundRefusal,
  ForegroundSession,
  HelperAttempt,
  HelperRefusalSignal,
  NativePreparedAction,
  ResolvedTarget,
  WindowRefRecord,
} from "./types.ts";

export function ensurePointIsInLookImage(
  x: number,
  y: number,
  look: LookResponse,
  errorPrefix = "Coordinates",
): void {
  if (!look.image?.jpegBase64) {
    throw new Error(
      `${errorPrefix} require an image-bearing root. This look is outline-only; use an @e ref with a semantic action or observe an image-bearing root.`,
    );
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`${errorPrefix} must be finite numbers.`);
  }
  if (x < 0 || y < 0 || x >= look.image.width || y >= look.image.height) {
    throw new Error(
      `${errorPrefix} (${Math.round(x)},${Math.round(y)}) are outside the latest look image bounds (${look.image.width}x${look.image.height}). Call observe_ui again and retry.`,
    );
  }
}

export function modelRefForRootDelta(
  delta: NonNullable<HelperActResult["rootDelta"]>[number],
): string | undefined {
  if (!delta.ref) return undefined;
  if (delta.ref.startsWith("@r")) return delta.ref;
  for (const record of runtimeState.windowRefs.values()) {
    if (record.nativeWindowRef === delta.ref || record.ref === delta.ref) return record.ref;
  }
  const ref = `@r${runtimeState.nextRootRefIndex++}`;
  const current = operationState().currentTarget;
  const record: WindowRefRecord = {
    ref,
    appName: current?.pid === delta.pid ? current.appName : "Unknown App",
    bundleId: current?.pid === delta.pid ? current.bundleId : undefined,
    pid: delta.pid,
    windowTitle: delta.title ?? "(untitled)",
    nativeWindowRef: delta.ref,
    framePoints: { x: 0, y: 0, w: 1, h: 1 },
    scaleFactor: 1,
    isMinimized: false,
    isOnscreen: true,
    isMain: false,
    isFocused: delta.change === "focused",
  };
  runtimeState.windowRefs.set(ref, record);
  runtimeState.windowRefByIdentity.set(windowRecordIdentity(record), ref);
  return ref;
}

export function executionTraceFromAct(
  result: HelperActResult,
  policy = currentDeliveryPolicy(),
): ExecutionTrace {
  const rootDelta = result.rootDelta?.map((delta) => ({
    ...delta,
    ref: modelRefForRootDelta(delta),
  }));
  return executionTrace("act", result.performed?.delivery === "ax" ? "stealth" : "default", {
    outcome: result.outcome,
    performed: result.performed,
    evidence: result.evidence,
    error: result.error,
    stoppedAt: result.stoppedAt,
    rootDelta,
    delivery: result.performed?.delivery,
    deliveryPolicy: policy,
    frontmostBefore: result.frontmostBefore,
    frontmostAfter: result.frontmostAfter,
  });
}

/** Pessimistic default: unless the helper states nothing was delivered, an effect is possible. */
export function errorEffectPossible(error: Error): boolean {
  return !("effectPossible" in error && error.effectPossible === false);
}

/**
 * Whether a refusal proves nothing took effect: `effectPossible: false`, and
 * either no pid pointer attempt preceded it or that attempt verifiably showed
 * no change. An attempt with a change or without a verdict (inconsistent
 * evidence) counts as a possible effect, so it is never retried or prompted.
 */
export function refusalProvesNoEffect(
  effectPossibleFlag: boolean | undefined,
  evidence: HelperRefusalEvidence | undefined,
): boolean {
  if (effectPossibleFlag !== false) return false;
  return evidence?.pidPointerAttempted !== true || evidence.observableChange === false;
}

export function foregroundCapability(action: NativePreparedAction): string {
  if ((action.action === "click" || action.action === "press") && "x" in action.target)
    return "coordinate_pointer_input";
  if (isPointerOnlyClick(action)) return "pointer_input";
  if (action.action === "typeText" || action.action === "keypress")
    return "focus" in action.target ? "focused_keyboard_input" : "keyboard_input";
  return "foreground_input";
}

export function foregroundGrantHint(
  target: ResolvedTarget,
  action: NativePreparedAction,
  headless: boolean,
  policy: DeliveryPolicy,
): string {
  if (headless)
    return "Headless mode permits accessibility delivery only; foreground input is unavailable while headless is enabled.";
  if (currentDeliveryPolicy() === "ax_only")
    return "The host delivery policy is ax_only; foreground input is unavailable until the user changes PI_COMPUTER_USE_DELIVERY_POLICY.";
  if (foregroundGrantCovers(target.bundleId))
    return policy === "foreground" || action.wantsForeground
      ? "A host foreground grant covers this app, and the helper still could not deliver this action. Observe the current state before choosing another approach."
      : "A host foreground grant covers this app, but the background attempt may have had an effect, so it was not retried in the foreground. Observe the current state; set_text on an editable ref needs no foreground input.";
  const grantValue = target.bundleId ?? "*";
  const fileHint = `add "${grantValue}" to "foreground_grant" in ~/.pi/agent/extensions/pi-computer-use.json or .pi/computer-use.json (applies on the next call, no restart), set PI_COMPUTER_USE_FOREGROUND_GRANT before starting pi, or run /computer-use grant always to allow every app without asking; /computer-use shows the active grants`;
  if (isSessionDenied(target.bundleId))
    return `The user declined foreground input for ${target.appName} in this session, so pi will not ask again; do not retry this action. Only the user can change this: ${fileHint}.`;
  const prompt =
    foregroundPromptMode() === "ask"
      ? "In an interactive pi TUI session the user is asked once per app when a refusal proves nothing was delivered; otherwise the user can"
      : "The user can";
  return `Foreground input for ${target.appName} needs a host-issued grant that the model cannot issue. ${prompt} ${fileHint}.`;
}

export function foregroundRefusal(
  target: ResolvedTarget,
  action: NativePreparedAction,
  headless: boolean,
  policy: DeliveryPolicy,
  effectPossible: boolean,
  reason: string,
  evidence?: HelperRefusalEvidence,
): ForegroundRefusal {
  const attempted = evidence?.pidPointerAttempted === true;
  const hint = foregroundGrantHint(target, action, headless, policy);
  const refusal: ForegroundRefusal = {
    code: "foreground_required",
    target: {
      app: target.appName,
      bundleId: target.bundleId,
      pid: target.pid,
      windowTitle: target.windowTitle,
    },
    action: action.action,
    capability: foregroundCapability(action),
    effectPossible,
    grantHint:
      attempted && evidence?.observableChange === false
        ? `The helper delivered this action as background pid-targeted pointer input and observed no change within its settle window. ${hint}`
        : hint,
    reason,
  };
  if (attempted) {
    refusal.pidPointerAttempted = true;
    if (evidence?.observableChange !== undefined)
      refusal.observableChange = evidence.observableChange;
  }
  return refusal;
}

export function isKeyboardAction(action: NativePreparedAction): boolean {
  return action.action === "typeText" || action.action === "keypress";
}

/** A ref click that only pointer input can realize (no AX press, not a text input). */
export function isPointerOnlyClick(action: NativePreparedAction): boolean {
  return (action.action === "click" || action.action === "press") && action.pointerOnly;
}

/** Best effort: records the user's frontmost app and window before granted input steals focus. */
export async function captureUserFocus(
  session: ForegroundSession | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!session || session.focusCaptured) return;
  session.focusCaptured = true;
  if (!getComputerUseConfig().restore_focus) return;
  try {
    const front = await currentPlatformBackend.getFrontmost(signal);
    session.focusBefore = { pid: front.pid, windowTitle: front.windowTitle };
  } catch {
    // The window title is optional evidence; the act reply still carries frontmostBefore.
  }
  throwIfAborted(signal);
}

/**
 * After a transaction that delivered granted foreground input, return focus to
 * the app the user had in front. Best effort: never changes the act outcome.
 * Skipped when the target was already frontmost, when the target did not end
 * frontmost, or when the user moved to a third app meanwhile.
 */
export async function restoreFocusAfterGrantedInput(
  execution: ExecutionTrace,
  target: ResolvedTarget,
  session: ForegroundSession | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const steps = execution.steps ?? [execution];
  if (!steps.some((step) => step.foregroundGrant === true)) return;
  const record = (restored: boolean, reason: string): void => {
    execution.focusRestored = restored;
    execution.focusRestoreReason = reason;
  };
  if (!getComputerUseConfig().restore_focus) return record(false, "disabled");
  const before = steps.map((step) => step.frontmostBefore).find(isNumber);
  const after = steps
    .map((step) => step.frontmostAfter)
    .filter(isNumber)
    .at(-1);
  if (before === undefined || after === undefined) return record(false, "no_frontmost_evidence");
  if (before === target.pid) return record(false, "target_was_frontmost");
  if (after !== target.pid)
    return record(false, after === before ? "focus_not_taken" : "user_switched");
  if (signal?.aborted) return record(false, "aborted");
  // The last act reply can be stale (a later wait step, or slow settling):
  // confirm the target is still frontmost right now so a user who moved to
  // another app meanwhile is never pulled back.
  let current: number;
  try {
    current = (await currentPlatformBackend.getFrontmost(signal)).pid;
  } catch (error) {
    if (signal?.aborted) return record(false, "aborted");
    return record(
      false,
      `frontmost_check_failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (signal?.aborted) return record(false, "aborted");
  if (current !== target.pid) return record(false, "user_switched");
  const windowTitle =
    session?.focusBefore?.pid === before ? session.focusBefore.windowTitle : undefined;
  try {
    const result = await currentPlatformBackend.restoreUserFocus(
      windowTitle ? { pid: before, windowTitle } : { pid: before },
      signal,
    );
    record(result.restored, result.restored ? "restored" : "helper_did_not_restore");
  } catch (error) {
    record(false, `restore_failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Delivers one action exactly once. Foreground delivery is used only when the
 * action wants it and a host-issued grant covers the target; otherwise the
 * helper's foreground need becomes a structured refusal. The one retry happens
 * after a background refusal that proved non-delivery, when a grant covers the
 * target or the user grants it at the host prompt. A refusal after a delivered
 * background pid pointer attempt is never retried in the same call: the grant
 * flow still runs, and the model must observe before acting again.
 */
export async function helperAct(
  target: ResolvedTarget,
  action: NativePreparedAction,
  headless: boolean,
  signal?: AbortSignal,
  session?: ForegroundSession,
): Promise<ExecutionTrace> {
  const checked = (candidate: HelperActResult): HelperActResult => {
    if (!candidate || !["worked", "didnt", "unknown"].includes(candidate.outcome)) {
      throw new Error("Helper act returned an invalid result without an outcome.");
    }
    return candidate;
  };
  const textTimeout =
    "text" in action.params ? action.params.text.length * 25 + 4_000 : COMMAND_TIMEOUT_MS;
  const timeoutMs = Math.max(COMMAND_TIMEOUT_MS, textTimeout);
  const basePolicy: DeliveryPolicy = headless ? "ax_only" : currentDeliveryPolicy();
  const policy: DeliveryPolicy =
    basePolicy === "background" &&
    (action.wantsForeground || mayPidPointerAttempt(action)) &&
    foregroundGrantCovers(target.bundleId)
      ? "foreground"
      : basePolicy;
  const attempt = async (attemptPolicy: DeliveryPolicy): Promise<HelperAttempt> => {
    const request = helperActRequest(target, action, attemptPolicy, timeoutMs);
    if (session) session.lastRequest = { requestId: request.requestId, policy: attemptPolicy };
    try {
      const result = checked(await currentPlatformBackend.act(request, { signal, timeoutMs }));
      return { request, result };
    } catch (error) {
      const evidence = error instanceof PlatformCommandError ? error.evidence : undefined;
      if (!(error instanceof Error && "code" in error && error.code === "foreground_required"))
        throw error;
      return {
        request,
        thrown: {
          message: error.message,
          effectPossible: !refusalProvesNoEffect(
            errorEffectPossible(error) ? undefined : false,
            evidence,
          ),
          evidence,
        },
      };
    }
  };
  if (policy === "foreground") await captureUserFocus(session, signal);
  const first = await attempt(policy);
  const firstRefusal = helperRefusalSignal(first);
  // The only escalation: the helper refused a background attempt before any
  // delivery, and a host grant covers the target (from config, env, or an
  // earlier session answer) or the user grants it now. Exactly one retry.
  // A pid pointer attempt that verifiably changed nothing still runs the grant
  // flow (session grant, dialog, "Always allow"), but its input was delivered,
  // so the retry is deferred to the next call after the model observes.
  if (policy !== "background" || firstRefusal?.effectPossible !== false)
    return attemptTrace(target, action, headless, policy, first);
  const delivered = firstRefusal.evidence?.pidPointerAttempted === true;
  let escalationReason: ExecutionTrace["escalationReason"];
  let prompt: GrantPromptOutcome | undefined;
  if (foregroundGrantCovers(target.bundleId)) escalationReason = "foreground_required";
  else if (session) {
    prompt = await promptForegroundGrant(
      session.ctx,
      { bundleId: target.bundleId, appName: target.appName },
      {
        action: action.action,
        capability: foregroundCapability(action),
        pidPointerAttempted: delivered,
      },
      signal,
    );
    throwIfAborted(signal);
    if (grantPromptGranted(prompt) && foregroundGrantCovers(target.bundleId))
      escalationReason = prompt.decision === "auto" ? "auto_grant" : "user_grant";
  }
  if (!escalationReason || delivered) {
    const refused = attemptTrace(target, action, headless, policy, first);
    if (prompt) refused.grantPrompt = prompt;
    if (delivered) deferRetryAfterDelivery(refused, target);
    return refused;
  }
  await captureUserFocus(session, signal);
  const second = await attempt("foreground");
  const trace = attemptTrace(target, action, headless, "foreground", second);
  trace.backgroundFirst = true;
  trace.escalatedToForeground = true;
  trace.escalationReason = escalationReason;
  trace.backgroundAttempt = { outcome: "foreground_required", reason: firstRefusal.message };
  if (prompt) trace.grantPrompt = prompt;
  return trace;
}

/**
 * Actions the helper may deliver as an ungranted background pid pointer
 * attempt: a pointer-only ref click, a coordinate click/press or scroll, and
 * any drag. Under a covering grant they go to foreground directly, so a
 * granted call never repeats a background attempt first.
 */
export function mayPidPointerAttempt(action: NativePreparedAction): boolean {
  if (action.action === "click" || action.action === "press")
    return "x" in action.target || action.pointerOnly;
  if (action.action === "scroll") return "x" in action.target;
  return action.action === "drag";
}

/**
 * A refusal after a delivered background pid pointer attempt: no same-call
 * retry. The refusal tells the model to observe first and whether a grant now
 * covers the target, so the next call goes to foreground directly.
 */
export function deferRetryAfterDelivery(trace: ExecutionTrace, target: ResolvedTarget): void {
  trace.retryDeferred = true;
  trace.retryDeferredReason = "pid_pointer_delivered_without_observable_change";
  const refusal = trace.refusal;
  if (!refusal) return;
  const granted = foregroundGrantCovers(target.bundleId);
  refusal.nextStep = "observe_then_retry";
  refusal.grantedForNextCall = granted;
  refusal.grantHint = granted
    ? `The helper already sent this ${actionLabel(refusal.action)} to ${target.appName} as background pid-targeted pointer input and observed no change, so it was not sent again in this call; it may still have had an effect that is not visible. A host foreground grant now covers ${target.appName}, so the next act_ui on it uses foreground input. Call observe_ui on the target and confirm whether the action took effect before acting again.`
    : `${refusal.grantHint} Call observe_ui on the target and confirm whether the action took effect before acting on it again.`;
}

/** A helper foreground_required refusal, thrown or returned, with its delivery evidence. */
export function helperRefusalSignal(attempt: HelperAttempt): HelperRefusalSignal | undefined {
  if (attempt.thrown) return attempt.thrown;
  const error = attempt.result.error;
  if (error?.code !== "foreground_required") return undefined;
  const { evidence } = error;
  return {
    message: error.message ?? "The helper requires foreground delivery for this action.",
    effectPossible: !refusalProvesNoEffect(error.effectPossible, evidence),
    evidence,
  };
}

export function attemptTrace(
  target: ResolvedTarget,
  action: NativePreparedAction,
  headless: boolean,
  policy: DeliveryPolicy,
  attempt: HelperAttempt,
): ExecutionTrace {
  const { request } = attempt;
  if (attempt.thrown) {
    const { message, effectPossible, evidence } = attempt.thrown;
    return executionTrace("act", policy === "ax_only" ? "stealth" : "default", {
      outcome: "didnt",
      deliveryPolicy: policy,
      error: { code: "foreground_required", message },
      backgroundFirst: policy !== "foreground",
      backgroundAttempt: { outcome: "foreground_required", reason: message },
      pidPointerAttempted: evidence?.pidPointerAttempted === true ? true : undefined,
      requestId: request.requestId,
      foregroundGrant: request.foregroundGrant,
      refusal: foregroundRefusal(
        target,
        action,
        headless,
        policy,
        effectPossible,
        message,
        evidence,
      ),
    });
  }
  const { result } = attempt;
  const trace = executionTraceFromAct(result, policy);
  trace.requestId = request.requestId;
  trace.foregroundGrant = request.foregroundGrant;
  trace.backgroundFirst = policy !== "foreground";
  if (result.evidence?.pidPointerAttempted === true) trace.pidPointerAttempted = true;
  const refusal = refusalForResult(target, action, headless, policy, result);
  if (refusal) {
    trace.outcome = "didnt";
    trace.refusal = refusal;
    if (refusal.pidPointerAttempted) trace.pidPointerAttempted = true;
    trace.backgroundAttempt = {
      outcome: result.error?.code === "foreground_required" ? "foreground_required" : "didnt",
      reason: refusal.reason,
    };
  }
  return trace;
}

export function refusalForResult(
  target: ResolvedTarget,
  action: NativePreparedAction,
  headless: boolean,
  policy: DeliveryPolicy,
  result: HelperActResult,
): ForegroundRefusal | undefined {
  if (result.error?.code === "foreground_required") {
    const { evidence } = result.error;
    return foregroundRefusal(
      target,
      action,
      headless,
      policy,
      !refusalProvesNoEffect(result.error.effectPossible, evidence),
      result.error.message ?? "The helper requires foreground delivery for this action.",
      evidence,
    );
  }
  // A `didnt` is a foreground need for foreground-wanting, keyboard, and
  // pointer-only click actions. It proves delivery happened, so it is never
  // retried (effectPossible stays true). Headless ax_only batches map it too.
  if (policy === "foreground" || result.outcome !== "didnt") return undefined;
  if (headless && !isPointerOnlyClick(action)) return undefined;
  if (!action.wantsForeground && !isKeyboardAction(action) && !isPointerOnlyClick(action))
    return undefined;
  return foregroundRefusal(
    target,
    action,
    headless,
    policy,
    true,
    "Background input produced no observable change; foreground delivery was not attempted.",
  );
}

export function helperActRequest(
  target: ResolvedTarget,
  action: NativePreparedAction,
  policy: DeliveryPolicy,
  timeoutMs: number,
): PlatformActRequest {
  const look = currentLookOrThrow();
  const foregroundGrant = policy === "foreground" ? foregroundGrantCovers(target.bundleId) : false;
  if (policy === "foreground" && !foregroundGrant)
    throw new Error(`Foreground delivery for ${target.appName} has no host-issued grant.`);
  const delivery = nativeInputDelivery(policy);
  const base: PlatformActRequestBase = {
    requestId: randomUUID(),
    session: { id: helperRequestSession.id, generation: helperRequestSession.generation },
    deadlineMs: Date.now() + timeoutMs,
    lookId: look.lookId,
    pid: target.pid,
    target: action.target,
    policy,
  };
  if (foregroundGrant) base.foregroundGrant = true;
  if ("focus" in action.target) base.focusResolution = "ax_focused_element";
  return (() => {
    switch (action.action) {
      case "press":
      case "click":
        return { ...base, action: action.action, params: { ...action.params, delivery } };
      case "setText":
        return { ...base, action: action.action, params: { text: action.params.text, delivery } };
      case "typeText":
        return { ...base, action: action.action, params: { text: action.params.text, delivery } };
      case "keypress":
        return { ...base, action: action.action, params: { keys: action.params.keys, delivery } };
      case "scroll":
        return {
          ...base,
          action: action.action,
          params: { scrollX: action.params.scrollX, scrollY: action.params.scrollY, delivery },
        };
      case "drag":
        return { ...base, action: action.action, params: { path: action.params.path, delivery } };
      case "moveMouse":
        return { ...base, action: action.action, params: { delivery } };
    }
  })();
}

export function rootDeltaLines(execution: ExecutionTrace): string[] {
  return (execution.rootDelta ?? []).map((delta) => {
    const quotedTitle = delta.title ? ` ${JSON.stringify(delta.title)}` : "";
    const ref = delta.ref ? ` (${delta.ref.startsWith("@") ? delta.ref : `@${delta.ref}`})` : "";
    const sheetCount =
      isNumber(delta.metadata?.sheetCount) && Number.isFinite(delta.metadata.sheetCount)
        ? Math.max(0, Math.trunc(delta.metadata.sheetCount))
        : undefined;
    const flags = [
      delta.isModal ? "modal" : undefined,
      sheetCount ? `sheets=${sheetCount}` : undefined,
    ]
      .filter(Boolean)
      .join(", ");
    const suffix = `${quotedTitle}${flags ? ` (${flags})` : ""}${ref}`;
    if (delta.change === "appeared") return `New root: ${delta.kind}${suffix}`;
    if (delta.change === "closed") return `Root closed: ${delta.kind}${suffix}`;
    return `Root focused: ${delta.kind}${suffix}`;
  });
}

/**
 * An error decided before anything was sent. In a multi-action call it names
 * the action and states that nothing was sent; a single action keeps its message.
 */
export function batchPreparationError(actions: UiAction[], index: number, error: Error): Error {
  if (actions.length === 1) return error;
  return new Error(
    `act_ui action ${index + 1} (${actionLabel(actions[index]?.action ?? "unknown")}): ${asSentence(error.message)} Nothing was sent.`,
    { cause: error },
  );
}

export function aggregateExecutions(steps: ExecutionTrace[]): ExecutionTrace {
  const outcomes = steps.map((step) => step.outcome);
  const outcome: ActOutcome = outcomes.includes("didnt")
    ? "didnt"
    : outcomes.includes("unknown")
      ? "unknown"
      : "worked";
  const refusedAt = steps.findIndex((step) => step.refusal !== undefined);
  const refused = refusedAt >= 0 ? steps[refusedAt] : undefined;
  const escalated = steps.find((step) => step.escalatedToForeground === true);
  // A top-level policy or delivery is reported only when every delivering step
  // (waits deliver nothing) agrees.
  const delivering = steps.filter((step) => step.strategy !== "wait");
  const shared = <T>(values: Array<T | undefined>): T | undefined =>
    values.length > 0 && values.every((value) => value !== undefined && value === values[0])
      ? values[0]
      : undefined;
  return executionTrace(
    "act",
    steps.every((step) => step.variant === "stealth") ? "stealth" : "default",
    {
      outcome,
      steps,
      actionCount: steps.length,
      rootDelta: steps.flatMap((step) => step.rootDelta ?? []),
      backgroundFirst: true,
      deliveryPolicy: shared(delivering.map((step) => step.deliveryPolicy)),
      delivery: shared(delivering.map((step) => step.delivery)),
      refusal: refused?.refusal,
      stoppedAt: refused ? refusedAt : undefined,
      escalatedToForeground: escalated ? true : undefined,
      escalationReason: escalated?.escalationReason,
      grantPrompt: steps.find((step) => step.grantPrompt !== undefined)?.grantPrompt,
      backgroundAttempt: refused?.backgroundAttempt ?? escalated?.backgroundAttempt,
      pidPointerAttempted: steps.some((step) => step.pidPointerAttempted === true)
        ? true
        : undefined,
      retryDeferred: refused?.retryDeferred,
      retryDeferredReason: refused?.retryDeferredReason,
      frontmostBefore: steps[0]?.frontmostBefore,
      frontmostAfter: steps.at(-1)?.frontmostAfter,
    },
  );
}

/** "Action 1 was delivered" / "Actions 1-3 were delivered" for `count` delivered actions. */
export function deliveredActionsText(count: number): string {
  return count === 1 ? "Action 1 was delivered" : `Actions 1-${count} were delivered`;
}

/** "act_ui stopped at action N (…) in <where>: <error> Actions 1-K were delivered; …" */
export function stoppedSummary(
  failure: { index: number; error: Error },
  actions: UiAction[],
  where: string,
  subject: string,
): string {
  const failed = `action ${failure.index + 1} (${actionLabel(actions[failure.index]?.action ?? "unknown")})`;
  const landed = errorEffectPossible(failure.error)
    ? `may have reached ${subject}`
    : "delivered nothing";
  return `act_ui stopped at ${failed} in ${where}: ${asSentence(failure.error.message)} ${deliveredActionsText(failure.index)}; ${failed} ${landed}; later actions were not sent.`;
}

/** The message unchanged, with a final period when it ends without punctuation. */
export function asSentence(message: string): string {
  const trimmed = message.trimEnd();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
