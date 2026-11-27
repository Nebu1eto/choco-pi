import { randomUUID } from "node:crypto";
import {
  foregroundGrantCovers,
  foregroundPromptMode,
  getBackgroundDelivery,
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
  FOREGROUND_NOT_ACQUIRED,
  HelperInterruption,
  PlatformCommandError,
  type HelperActResult,
  type HelperDestinationFailure,
  type HelperRefusalEvidence,
  type PlatformActRequest,
  type PlatformActRequestBase,
  type PlatformRestoreUserFocusRequest,
  isForegroundDestinationCode,
} from "../platform/types.ts";
import { actionLabel } from "../tool-params.ts";
import {
  acquireForegroundSection,
  COMMAND_TIMEOUT_MS,
  currentDeliveryPolicy,
  currentLookOrThrow,
  executionTrace,
  helperRequestSession,
  nativeInputDelivery,
  operationState,
  runtimeState,
  sleep,
  throwIfAborted,
} from "./state-store.ts";
import { windowRecordIdentity } from "./targets.ts";
import type {
  ActOutcome,
  DeliveryPolicy,
  ExecutionTrace,
  ForegroundRefusal,
  ForegroundSectionTrace,
  ForegroundSession,
  HelperAttempt,
  HelperRefusalSignal,
  KeyWindowRefusalKind,
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

export function errorEffectPossible(error: Error): boolean {
  return !("effectPossible" in error && error.effectPossible === false);
}

export function refusalProvesNoEffect(
  effectPossibleFlag: boolean | undefined,
  evidence: HelperRefusalEvidence | undefined,
): boolean {
  if (effectPossibleFlag !== false) return false;
  if (usedExtendedDelivery(evidence)) return false;
  return evidence?.pidPointerAttempted !== true || evidence.observableChange === false;
}

export function usedExtendedDelivery(evidence: HelperRefusalEvidence | undefined): boolean {
  return evidence?.extendedDelivery === "used";
}

export function keyWindowRefusalOf(
  code: string | undefined,
  evidence: HelperRefusalEvidence | undefined,
): KeyWindowRefusalKind | undefined {
  if (code !== "foreground_required" || !usedExtendedDelivery(evidence)) return undefined;
  if (evidence?.keyWindowAcquired !== false) return undefined;
  if (evidence.observedWindowResolved === false) return "observed_window_unresolved";
  return evidence.observedWindowResolved === true ? "observed_window_not_key" : "unconfirmed";
}

export function resultErrorEvidence(
  error: HelperActResult["error"],
): HelperRefusalEvidence | undefined {
  if (!error) return undefined;
  const evidence: HelperRefusalEvidence = { ...error.evidence };
  if (error.extendedDelivery !== undefined && evidence.extendedDelivery === undefined)
    evidence.extendedDelivery = error.extendedDelivery;
  if (error.keyWindowAcquired !== undefined && evidence.keyWindowAcquired === undefined)
    evidence.keyWindowAcquired = error.keyWindowAcquired;
  if (error.observedWindowResolved !== undefined && evidence.observedWindowResolved === undefined)
    evidence.observedWindowResolved = error.observedWindowResolved;
  return evidence;
}

const KEY_WINDOW_CAUSE = {
  observed_window_unresolved:
    "the helper could not resolve the observed window, so it could not confirm that window is the app's key window",
  observed_window_not_key: "the observed window did not become the app's key window",
  unconfirmed: "the helper could not confirm the observed window as the app's key window",
} satisfies Record<KeyWindowRefusalKind, string>;

export function keyWindowRefusalText(kind: KeyWindowRefusalKind): string {
  return `No key was sent: ${KEY_WINDOW_CAUSE[kind]}. Extended background delivery was used for the activation only (the app was told it was active; no input event was sent to it).`;
}

export function keyWindowRefusal(
  target: ResolvedTarget,
  action: NativePreparedAction,
  kind: KeyWindowRefusalKind,
  reason: string,
): ForegroundRefusal {
  return {
    code: "foreground_required",
    target: {
      app: target.appName,
      bundleId: target.bundleId,
      pid: target.pid,
      windowTitle: target.windowTitle,
    },
    action: action.action,
    capability: foregroundCapability(action),
    effectPossible: false,
    key_window: kind,
    grantHint: `${keyWindowRefusalText(kind)} It was not retried and no foreground grant was requested in this call. Call observe_ui on the target before acting again; set_text on an editable ref needs no key input.`,
    reason,
  };
}

function keyWindowTraceError(
  message: string,
  kind: KeyWindowRefusalKind,
): NonNullable<ExecutionTrace["error"]> {
  const error: NonNullable<ExecutionTrace["error"]> = {
    code: "foreground_required",
    message,
    effectPossible: false,
    extendedDelivery: "used",
    keyWindowAcquired: false,
  };
  if (kind !== "unconfirmed") error.observedWindowResolved = kind === "observed_window_not_key";
  return error;
}

export function extendedEndingResult(code: string, message: string): HelperActResult {
  return {
    outcome: "unknown",
    performed: { delivery: "pid", extendedDelivery: "used" },
    evidence: {
      extendedDelivery: "used",
      observableChange: false,
      extendedDeliveryEnding: { code, message },
    },
  };
}

function refusedAfterExtendedDelivery(result: HelperActResult): boolean {
  const error = result.error;
  return (
    error?.code === "foreground_required" &&
    (error.extendedDelivery === "used" || usedExtendedDelivery(error.evidence)) &&
    keyWindowRefusalOf(error.code, resultErrorEvidence(error)) === undefined
  );
}

export function endedAfterExtendedDelivery(step: ExecutionTrace): boolean {
  return step.evidence?.extendedDeliveryEnding !== undefined;
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
  if (target.offSpace)
    return "The target window is on a Space no display shows. Foreground input would bring it to the front and switch the user's Space, so it is not used for this window whatever the grants; use accessibility actions (press, set_text), background_delivery: extended for pointer and key input, or ask the user to show the window.";
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

export function isPointerOnlyClick(action: NativePreparedAction): boolean {
  return (action.action === "click" || action.action === "press") && action.pointerOnly;
}

export async function captureUserFocus(
  session: ForegroundSession | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!session || session.focusCaptured) return;
  session.focusCaptured = true;
  if (!getComputerUseConfig().restore_focus) return;
  try {
    const front = await currentPlatformBackend.getFrontmost(signal);
    session.focusBefore = {
      pid: front.pid,
      windowId: front.windowId,
      windowRef: front.rootRef,
      windowTitle: front.windowTitle,
      windowSource: front.windowSource,
    };
  } catch {}
  throwIfAborted(signal);
}

export async function enterForegroundSection(
  session: ForegroundSession | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!session) return;
  if (!session.section) {
    const lease = await acquireForegroundSection(signal);
    try {
      await acquireHelperForegroundSection(session, lease.trace, signal);
    } catch (error) {
      lease.release();
      throw error;
    }
    session.section = lease;
  }
  await captureUserFocus(session, signal);
}

export const HELPER_FOREGROUND_WAIT_MS = 10_000;

async function acquireHelperForegroundSection(
  session: ForegroundSession,
  trace: ForegroundSectionTrace,
  signal?: AbortSignal,
): Promise<void> {
  const section = currentPlatformBackend.foregroundSection;
  if (!section) return;
  const started = performance.now();
  try {
    const held = await section("acquire", HELPER_FOREGROUND_WAIT_MS, signal);
    if (held !== true) return;
  } catch (error) {
    if (signal?.aborted) releaseHelperForegroundSection();
    throw error;
  }
  session.helperSection = true;
  trace.helperWaitedMs = Math.round(performance.now() - started);
}

function releaseHelperForegroundSection(): void {
  const section = currentPlatformBackend.foregroundSection;
  if (!section) return;
  void section("release", 0, AbortSignal.timeout(COMMAND_TIMEOUT_MS)).catch(() => undefined);
}

export const UNFINISHED_DELIVERY_GRACE_MS = 2_000;

export function endForegroundSection(
  session: ForegroundSession,
  unfinished?: HelperInterruption,
): void {
  const lease = session.section;
  session.section = undefined;
  if (!lease) return;
  const helperHeld = session.helperSection === true;
  session.helperSection = false;
  const release = (unconfirmedRequestId?: string) => {
    if (helperHeld) releaseHelperForegroundSection();
    lease.release(unconfirmedRequestId);
  };
  if (!unfinished) return release();
  const request = session.lastRequest;
  const requestId = request?.requestId ?? "unknown";
  const budgetEnd = request ? request.sentAt + request.budgetMs : performance.now();
  const boundMs = Math.max(1_000, budgetEnd + UNFINISHED_DELIVERY_GRACE_MS - performance.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), boundMs);
    timer.unref?.();
  });
  const confirmed = unfinished.settle
    ? unfinished.settle().then(
        (settlement) => settlement.settled,
        () => false,
      )
    : bound;
  void Promise.race([confirmed, bound]).then((settled) => {
    clearTimeout(timer);
    release(settled ? undefined : requestId);
  });
}

export async function restoreFocusAfterGrantedInput(
  execution: ExecutionTrace,
  target: ResolvedTarget,
  session: ForegroundSession | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const steps = execution.steps ?? [execution];
  if (!steps.some((step) => step.foregroundGrant === true)) return;
  const record = focusRestoreRecorder(execution);
  if (!getComputerUseConfig().restore_focus) return record(false, "disabled");
  const before = steps.map((step) => step.frontmostBefore).find(isNumber);
  const after = steps
    .map((step) => step.frontmostAfter)
    .filter(isNumber)
    .at(-1);
  if (before === undefined || after === undefined) return record(false, "no_frontmost_evidence");
  if (before === target.pid) return await restoreTargetWindow(target, session, record, signal);
  if (after !== target.pid)
    return record(false, after === before ? "focus_not_taken" : "user_switched");
  await restoreWhileTargetFrontmost(before, target, session, record, () => "user_switched", signal);
}

type FocusRestoreRecorder = (restored: boolean, reason: string, windowRestored?: boolean) => void;

function focusRestoreRecorder(execution: ExecutionTrace): FocusRestoreRecorder {
  return (restored, reason, windowRestored) => {
    execution.focusRestored = restored;
    execution.focusRestoreReason = reason;
    if (windowRestored === undefined) delete execution.focusWindowRestored;
    else execution.focusWindowRestored = windowRestored;
  };
}

async function restoreTargetWindow(
  target: ResolvedTarget,
  session: ForegroundSession | undefined,
  record: FocusRestoreRecorder,
  signal?: AbortSignal,
): Promise<void> {
  const user = session?.focusBefore;
  if (user?.pid !== target.pid) return record(false, "target_was_frontmost");
  const otherWindow =
    user.windowId !== undefined && target.windowId > 0
      ? user.windowId !== target.windowId
      : user.windowRef !== undefined && user.windowRef !== target.nativeWindowRef;
  if (!otherWindow) return record(false, "target_was_frontmost");
  await restoreWhileTargetFrontmost(
    target.pid,
    target,
    session,
    record,
    () => "user_switched",
    signal,
  );
}

function restoreRequest(
  pid: number,
  target: ResolvedTarget,
  session: ForegroundSession | undefined,
): PlatformRestoreUserFocusRequest {
  const request: PlatformRestoreUserFocusRequest = { pid, expectedFrontmostPid: target.pid };
  const user = session?.focusBefore?.pid === pid ? session.focusBefore : undefined;
  if (!user) return request;
  if (user.windowId !== undefined) request.windowId = user.windowId;
  if (user.windowRef) request.windowRef = user.windowRef;
  if (request.windowId === undefined && !request.windowRef && user.windowTitle)
    request.windowTitle = user.windowTitle;
  return request;
}

async function restoreWhileTargetFrontmost(
  before: number,
  target: ResolvedTarget,
  session: ForegroundSession | undefined,
  record: FocusRestoreRecorder,
  notFrontReason: (current: number) => string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return record(false, "aborted");
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
  if (current !== target.pid) return record(false, notFrontReason(current));
  const request = restoreRequest(before, target, session);
  const windowNamed =
    request.windowId !== undefined || request.windowRef !== undefined || !!request.windowTitle;
  try {
    const result = await currentPlatformBackend.restoreUserFocus(request, signal);
    if (result.reason === "frontmost_changed")
      return record(false, notFrontReason(result.frontmostPid ?? -1));
    const windowRestored = windowNamed ? result.windowRestored === true : undefined;
    if (before === target.pid)
      return record(
        windowRestored === true,
        windowRestored ? "target_window_restored" : "target_window_not_restored",
        windowRestored,
      );
    const appRestored = result.appRestored ?? result.restored;
    if (!appRestored) return record(false, "helper_did_not_restore", windowRestored);
    if (!windowNamed) return record(true, "app_restored");
    record(true, windowRestored ? "restored" : "app_restored_window_not_restored", windowRestored);
  } catch (error) {
    record(false, `restore_failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const LATE_ACTIVATION_SETTLE_MS = 150;

export async function restoreFocusAfterDestinationRefusal(
  execution: ExecutionTrace,
  target: ResolvedTarget,
  session: ForegroundSession | undefined,
  refused: HelperDestinationFailure,
  signal?: AbortSignal,
): Promise<void> {
  if (!session?.focusCaptured) return;
  const record = focusRestoreRecorder(execution);
  if (!getComputerUseConfig().restore_focus) return record(false, "disabled");
  const before =
    (execution.steps ?? []).map((step) => step.frontmostBefore).find(isNumber) ??
    refused.frontmostBefore ??
    session.focusBefore?.pid;
  if (before === undefined) return record(false, "no_frontmost_evidence");
  if (before === target.pid) return await restoreTargetWindow(target, session, record, signal);
  try {
    await sleep(LATE_ACTIVATION_SETTLE_MS, signal);
  } catch (error) {
    if (signal?.aborted) return record(false, "aborted");
    throw error;
  }
  await restoreWhileTargetFrontmost(
    before,
    target,
    session,
    record,
    (current) => (current === before && !refused.inputSent ? "focus_not_taken" : "user_switched"),
    signal,
  );
}

export function destinationFailureOf(error: Error): HelperDestinationFailure | undefined {
  if (!(error instanceof PlatformCommandError) || !isForegroundDestinationCode(error.code))
    return undefined;
  return error.destination ?? { inputSent: error.code !== FOREGROUND_NOT_ACQUIRED };
}

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
  const mayUseForeground = !target.offSpace;
  const policy: DeliveryPolicy =
    basePolicy === "background" &&
    mayUseForeground &&
    (action.wantsForeground || mayPidPointerAttempt(action)) &&
    foregroundGrantCovers(target.bundleId)
      ? "foreground"
      : basePolicy;
  const attempt = async (attemptPolicy: DeliveryPolicy): Promise<HelperAttempt> => {
    const request = helperActRequest(target, action, attemptPolicy, timeoutMs);
    if (session)
      session.lastRequest = {
        requestId: request.requestId,
        policy: attemptPolicy,
        budgetMs: request.budgetMs,
        sentAt: performance.now(),
      };
    try {
      const result = checked(await currentPlatformBackend.act(request, { signal, timeoutMs }));
      if (refusedAfterExtendedDelivery(result))
        return {
          request,
          result: extendedEndingResult(
            "foreground_required",
            result.error?.message ?? "The helper refused after extended delivery was used.",
          ),
        };
      return { request, result };
    } catch (error) {
      const evidence = error instanceof PlatformCommandError ? error.evidence : undefined;
      if (!(error instanceof Error && "code" in error && error.code === "foreground_required"))
        throw error;
      const keyWindow = keyWindowRefusalOf("foreground_required", evidence);
      if (keyWindow)
        return {
          request,
          thrown: { message: error.message, effectPossible: false, evidence, keyWindow },
        };
      if (usedExtendedDelivery(evidence))
        return { request, result: extendedEndingResult("foreground_required", error.message) };
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
  if (policy === "foreground") await enterForegroundSection(session, signal);
  const first = await attempt(policy);
  const firstRefusal = helperRefusalSignal(first);
  if (firstRefusal?.keyWindow) return attemptTrace(target, action, headless, policy, first);
  if (policy !== "background" || firstRefusal?.effectPossible !== false)
    return attemptTrace(target, action, headless, policy, first);
  const delivered =
    firstRefusal.evidence?.pidPointerAttempted === true ||
    usedExtendedDelivery(firstRefusal.evidence);
  let escalationReason: ExecutionTrace["escalationReason"];
  let prompt: GrantPromptOutcome | undefined;
  if (mayUseForeground && foregroundGrantCovers(target.bundleId))
    escalationReason = "foreground_required";
  else if (mayUseForeground && session) {
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
  await enterForegroundSection(session, signal);
  const second = await attempt("foreground");
  const trace = attemptTrace(target, action, headless, "foreground", second);
  trace.backgroundFirst = true;
  trace.escalatedToForeground = true;
  trace.escalationReason = escalationReason;
  trace.backgroundAttempt = { outcome: "foreground_required", reason: firstRefusal.message };
  if (prompt) trace.grantPrompt = prompt;
  return trace;
}

export function mayPidPointerAttempt(action: NativePreparedAction): boolean {
  if (action.action === "click" || action.action === "press")
    return "x" in action.target || action.pointerOnly;
  if (action.action === "scroll") return "x" in action.target;
  return action.action === "drag";
}

export function deferRetryAfterDelivery(trace: ExecutionTrace, target: ResolvedTarget): void {
  trace.retryDeferred = true;
  trace.retryDeferredReason = "pid_pointer_delivered_without_observable_change";
  const refusal = trace.refusal;
  if (!refusal) return;
  const granted = !target.offSpace && foregroundGrantCovers(target.bundleId);
  refusal.nextStep = "observe_then_retry";
  refusal.grantedForNextCall = granted;
  refusal.grantHint = granted
    ? `The helper already sent this ${actionLabel(refusal.action)} to ${target.appName} as background pid-targeted pointer input and observed no change, so it was not sent again in this call; it may still have had an effect that is not visible. A host foreground grant now covers ${target.appName}, so the next act_ui on it uses foreground input. Call observe_ui on the target and confirm whether the action took effect before acting again.`
    : `${refusal.grantHint} Call observe_ui on the target and confirm whether the action took effect before acting on it again.`;
}

export function helperRefusalSignal(attempt: HelperAttempt): HelperRefusalSignal | undefined {
  if (attempt.thrown) return attempt.thrown;
  const error = attempt.result.error;
  if (error?.code !== "foreground_required") return undefined;
  const { evidence } = error;
  const keyWindow = keyWindowRefusalOf(error.code, resultErrorEvidence(error));
  if (keyWindow)
    return {
      message: error.message ?? "The helper refused before any key was sent.",
      effectPossible: false,
      evidence: resultErrorEvidence(error),
      keyWindow,
    };
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
    const { message, effectPossible, evidence, keyWindow } = attempt.thrown;
    if (keyWindow)
      return executionTrace("act", "default", {
        outcome: "didnt",
        deliveryPolicy: policy,
        error: keyWindowTraceError(message, keyWindow),
        backgroundFirst: true,
        backgroundAttempt: { outcome: "foreground_required", reason: message },
        requestId: request.requestId,
        refusal: keyWindowRefusal(target, action, keyWindow, message),
      });
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
    if (refusal.key_window && trace.error) trace.error = { ...trace.error, effectPossible: false };
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
  const keyWindow = keyWindowRefusalOf(result.error?.code, resultErrorEvidence(result.error));
  if (keyWindow)
    return keyWindowRefusal(
      target,
      action,
      keyWindow,
      result.error?.message ?? "The helper refused before any key was sent.",
    );
  if (refusedAfterExtendedDelivery(result)) return undefined;
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
  if (policy === "foreground" || result.outcome !== "didnt") return undefined;
  if (result.performed?.extendedDelivery === "used") return undefined;
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
    budgetMs: timeoutMs,
    lookId: look.lookId,
    pid: target.pid,
    target: action.target,
    policy,
  };
  if (foregroundGrant) base.foregroundGrant = true;
  if ("focus" in action.target) base.focusResolution = "ax_focused_element";
  if (policy === "background" && getBackgroundDelivery() === "extended")
    base.backgroundDelivery = "extended";
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
      backgroundFirst: delivering.every(
        (step) => step.backgroundFirst ?? step.deliveryPolicy !== "foreground",
      ),
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

export function deliveredActionsText(count: number): string {
  return count === 1 ? "Action 1 was delivered" : `Actions 1-${count} were delivered`;
}

export function stoppedSummary(
  failure: { index: number; error: Error },
  actions: UiAction[],
  where: string,
  subject: string,
): string {
  const failed = `action ${failure.index + 1} (${actionLabel(actions[failure.index]?.action ?? "unknown")})`;
  const destination = destinationFailureOf(failure.error);
  const landed =
    destination?.inputSent === false
      ? "sent no input (the target did not come to the front)"
      : destination?.charactersSent !== undefined
        ? `sent ${destination.charactersSent} character(s) to ${subject} before it stopped being the destination`
        : errorEffectPossible(failure.error)
          ? `may have reached ${subject}`
          : "delivered nothing";
  const earlier =
    failure.index === 0 ? "No earlier action was sent" : deliveredActionsText(failure.index);
  return `act_ui stopped at ${failed} in ${where}: ${asSentence(failure.error.message)} ${earlier}; ${failed} ${landed}; later actions were not sent.`;
}

export function asSentence(message: string): string {
  const trimmed = message.trimEnd();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
