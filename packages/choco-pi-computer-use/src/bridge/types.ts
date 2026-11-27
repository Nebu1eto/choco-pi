import type { ChildProcess } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PreparedAction } from "../actions.ts";
import type { CdpConsoleEntry, CdpPageSnapshot } from "../cdp.ts";
import type { ComputerUseConfig } from "../config.ts";
import type { FindParams, UiAction } from "../contract.ts";
import type { GrantPromptOutcome } from "../grant-prompt.ts";
import type { JsonObject, JsonValue } from "../json.ts";
import type { WindowNote } from "../note.ts";
import type {
  LookResponse,
  Outline,
  OutlineChange,
  SerializedOutline,
  SerializedOutlineNode,
  SerializedOutlineSearchMatch,
} from "../outline.ts";
import type { PermissionStatus } from "../permissions.ts";
import type {
  FramePoints,
  HelperActPerformed,
  HelperActResult,
  HelperCancelAck,
  HelperInterruptionState,
  HelperRefusalEvidence,
  NativeInputDelivery,
  PlatformActRequest,
  PlatformDeliveryPolicy,
  PlatformDiagnostics,
} from "../platform/types.ts";
import type { CurrentCapture, CurrentTarget } from "../state.ts";

export interface ActivationFlags {
  activated: boolean;
  unminimized: boolean;
  raised: boolean;
}

export type ExecutionVariant = "stealth" | "default";
export type ActionDelivery = "ax" | NativeInputDelivery;
export type DeliveryPolicy = PlatformDeliveryPolicy;
export type ActOutcome = "worked" | "didnt" | "unknown";
export type ObservationRefreshReason = "missing" | "stale";
export type ComputerUseDetailsConfig = ComputerUseConfig & { notes?: string[] };

export interface ForegroundRefusal {
  code: "foreground_required";
  target: { app: string; bundleId?: string; pid: number; windowTitle: string };
  action: string;
  capability: string;
  effectPossible: boolean;
  pidPointerAttempted?: boolean;
  observableChange?: boolean;
  nextStep?: "observe_then_retry";
  grantedForNextCall?: boolean;
  grantHint: string;
  reason: string;
}

export interface ObservationRefreshRequirement {
  code: "observation_refresh_required";
  operation: string;
  reason: ObservationRefreshReason;
  stateId?: string;
  refresh: {
    tool: "observe_ui";
    arguments: JsonObject;
  };
  staleness?: {
    resourceKey: string;
    observationEpoch: number;
    currentEpoch: number;
  };
}

export class ObservationRefreshRequiredError extends Error {
  readonly code = "observation_refresh_required";
  readonly requirement: ObservationRefreshRequirement;

  constructor(requirement: ObservationRefreshRequirement) {
    super(JSON.stringify(requirement));
    this.name = "ObservationRefreshRequiredError";
    this.requirement = requirement;
  }
}

export interface ExecutionTrace {
  strategy: "look" | "act" | "wait" | "browser_open_location" | "cdp_navigate" | "cdp_act";
  runtimeMode?: ExecutionVariant;
  variant?: ExecutionVariant;
  stealthCompatible?: boolean;
  delivery?: ActionDelivery;
  deliveryPolicy?: DeliveryPolicy;
  outcome?: ActOutcome;
  performed?: HelperActPerformed;
  evidence?: JsonObject;
  error?: HelperActResult["error"];
  rootDelta?: HelperActResult["rootDelta"];
  steps?: ExecutionTrace[];
  actionCount?: number;
  stoppedAt?: number;
  backgroundFirst?: boolean;
  escalatedToForeground?: boolean;
  escalationReason?: "foreground_required" | "user_grant" | "auto_grant";
  grantPrompt?: GrantPromptOutcome;
  backgroundAttempt?: { outcome: "foreground_required" | "didnt"; reason: string };
  pidPointerAttempted?: boolean;
  retryDeferred?: true;
  retryDeferredReason?: string;
  requestId?: string;
  foregroundGrant?: true;
  refusal?: ForegroundRefusal;
  frontmostBefore?: JsonValue;
  frontmostAfter?: JsonValue;
  focusRestored?: boolean;
  focusRestoreReason?: string;
  focusWindowRestored?: boolean;
  foregroundSection?: ForegroundSectionTrace;
  verification?: {
    status: "verified" | "preexisting" | "failed";
    text?: string;
    role?: string;
    value?: string;
    gone?: boolean;
    timeoutMs: number;
  };
}

export interface ComputerUseDetails {
  tool: string;
  target: {
    app: string;
    bundleId?: string;
    pid: number;
    windowTitle: string;
    windowId: number;
    windowRef?: string;
    nativeWindowRef?: string;
  };
  capture: {
    stateId: string;
    width: number;
    height: number;
    scaleFactor: number;
    timestamp: number;
    coordinateSpace: "window-relative-screenshot-pixels";
  };
  lookId?: string;
  view: "full" | "diff";
  baseStateId?: string;
  changes?: OutlineChange[];
  viewReason?: "root_replaced" | "change_budget_exceeded" | "identity_confidence_low";
  renderedOutline?: string;
  outline?: SerializedOutline;
  note?: WindowNote;
  activation: ActivationFlags;
  execution: ExecutionTrace;
  config?: ComputerUseDetailsConfig;
  helper?: PlatformDiagnostics;
  status?: "ok" | "partial";
  axDiagnostics?: {
    reason?: string;
    message?: string;
    debug?: JsonValue;
  };
  console?: CdpConsoleEntry[];
  imageReason?:
    | "fallback_recovery"
    | "browser_ax_window_unavailable"
    | "no_ax_targets"
    | "sparse_ax_targets"
    | "weak_ax_targets"
    | "unlabeled_ax_targets"
    | "duplicated_ax_labels"
    | "browser_wait_verification";
}
export interface InterruptedExecutionTrace {
  strategy: "act";
  outcome: "partial" | "rejected_before_delivery";
  stoppedAt?: number;
  reason?: string;
  effectPossible: boolean;
  cancel?: HelperCancelAck;
  state?: HelperInterruptionState;
  stateReason?: string;
  steps?: ExecutionTrace[];
  focusRestored?: boolean;
  focusRestoreReason?: string;
}

export interface TerminalDesktopActionDetails {
  tool: "act_ui";
  status:
    | "target_closed"
    | "post_action_observation_failed"
    | "foreground_required"
    | "foreground_not_acquired"
    | "cancelled"
    | "owned_by_other_session";
  baseStateId: string;
  target: {
    app: string;
    bundleId?: string;
    pid: number;
    windowTitle: string;
    windowId: number;
    windowRef?: string;
    nativeWindowRef?: string;
  };
  execution: ExecutionTrace | InterruptedExecutionTrace;
  error: { code: string; message: string; inputSent?: boolean; effectPossible?: boolean };
  nextStep?: "observe_then_retry";
  config?: ComputerUseDetailsConfig;
}

export interface ListWindowsDetails {
  tool: "find_roots";
  query: FindParams;
  totalMatches?: number;
  returned?: number;
  hasMore?: boolean;
  windows: Array<{
    app: string;
    bundleId?: string;
    pid: number;
    kind: string;
    windowTitle: string;
    windowId?: number;
    windowRef: string;
    nativeWindowRef?: string;
    framePoints: FramePoints;
    scaleFactor: number;
    isMinimized: boolean;
    isOnscreen: boolean;
    isMain: boolean;
    isFocused: boolean;
    isModal: boolean;
    sheetCount?: number;
    role?: string;
    subrole?: string;
    pairing?: { confidence: "exact" | "high" | "low"; score: number };
    zOrder: number;
    browserUseAllowed: boolean;
    score: number;
    url?: string;
  }>;
  config: {
    browser_use: boolean;
    headless: boolean;
  };
}

export interface BrowserObservationDetails {
  tool: string;
  kind: "browser_page";
  stateId: string;
  baseStateId?: string;
  view: "full" | "diff";
  changes?: OutlineChange[];
  root: { ref: string; kind: "browser_page"; title: string; url: string };
  outline: SerializedOutline;
  renderedOutline: string;
  status?: "ok" | "partial";
  execution?: ExecutionTrace;
}

export interface TerminalBrowserActionDetails {
  tool: "act_ui";
  kind: "browser_page";
  status: "target_closed" | "post_action_observation_failed";
  baseStateId: string;
  root: { ref: string; kind: "browser_page"; title: string; url: string };
  execution: ExecutionTrace;
  error: { code: string; message: string };
}

export interface EvaluateBrowserDetails {
  tool: "evaluate_browser";
  baseStateId: string;
  stateId: string;
  view: "full" | "diff";
  changes?: OutlineChange[];
  outline: SerializedOutline;
  renderedOutline: string;
}

export interface ReadTextDetails {
  tool: "read_text";
  ref?: string;
  offset: number;
  limit: number;
  totalChars?: number;
  totalBytes?: number;
  hasMore: boolean;
  complete?: boolean;
  text: string;
}

export interface WaitForDetails {
  tool: "wait_for";
  stateId: string;
  baseStateId?: string;
  view: "full" | "diff";
  changes?: OutlineChange[];
  found: boolean;
  gone?: boolean;
  timedOut?: boolean;
  target?: SerializedOutlineSearchMatch;
  nodeCount?: number;
  text?: string;
  role?: string;
  value?: string;
  scopeRef?: string;
  outline: SerializedOutline;
  renderedOutline: string;
}

export interface OutlineToolDetails {
  tool: "search_ui" | "expand_ui" | "inspect_ui";
  stateId?: string;
  lookId?: string;
  outline?: SerializedOutline;
  renderedOutline?: string;
  totalMatches?: number;
  returned?: number;
  hasMore?: boolean;
  matches?: SerializedOutlineSearchMatch[];
  target?: SerializedOutlineNode;
  note?: WindowNote;
}

export interface ResolvedTarget extends CurrentTarget {
  framePoints: FramePoints;
  scaleFactor: number;
  isMinimized: boolean;
  isOnscreen: boolean;
  isMain: boolean;
  isFocused: boolean;
}

export interface WindowRefRecord {
  ref: string;
  appName: string;
  bundleId?: string;
  pid: number;
  windowTitle: string;
  windowId?: number;
  nativeWindowRef?: string;
  framePoints: FramePoints;
  scaleFactor: number;
  isMinimized: boolean;
  isOnscreen: boolean;
  isMain: boolean;
  isFocused: boolean;
}

export interface RuntimeState {
  windowRefs: Map<string, WindowRefRecord>;
  windowRefByIdentity: Map<string, string>;
  browserRootByContext: Map<string, string>;
  browserContextByRoot: Map<string, string>;
  nextRootRefIndex: number;
  managedBrowser?: ChildProcess;
  managedBrowserCdpPort?: string;
  previousCdpPort?: string;
  permissionStatus?: PermissionStatus;
  helperDiagnostics?: PlatformDiagnostics;
  lastPermissionCheckAt: number;
}

export interface NativeWindowRequest {
  pid: number;
  windowId: number;
  windowRef?: string;
}

export interface CaptureResult {
  target: ResolvedTarget;
  capture: CurrentCapture;
  look: LookResponse;
  outline: Outline;
  activation: ActivationFlags;
}

export interface NoteWindowInput {
  windowRef?: string;
  title: string;
  pairing?: "exact" | "high" | "low";
  pairingScore?: number;
}

export type NativePreparedAction = Exclude<PreparedAction, { action: "wait" }>;

export interface CapturedFocus {
  pid: number;
  windowId?: number;
  windowRef?: string;
  windowTitle?: string;
  windowSource?: "focused" | "main" | "unknown";
}

export interface ForegroundSectionTrace {
  waitedMs: number;
  previousDeliveryUnconfirmed?: string;
}

export interface ForegroundSectionLease {
  readonly trace: ForegroundSectionTrace;
  release(unconfirmedRequestId?: string): void;
}

export interface ForegroundSession {
  ctx?: ExtensionContext;
  focusCaptured: boolean;
  focusBefore?: CapturedFocus;
  lastRequest?: { requestId: string; policy: DeliveryPolicy; budgetMs: number; sentAt: number };
  section?: ForegroundSectionLease;
}

export interface HelperRefusalSignal {
  message: string;
  effectPossible: boolean;
  evidence?: HelperRefusalEvidence;
}

export type HelperAttempt = { request: PlatformActRequest } & (
  | { result: HelperActResult; thrown?: undefined }
  | { result?: undefined; thrown: HelperRefusalSignal }
);

export interface ValidatedCondition {
  text?: string;
  role?: string;
  value?: string;
  scopeRef?: string;
  scopeExact: boolean;
  gone: boolean;
  timeoutMs: number;
}

export interface DesktopDispatchFailure {
  index: number;
  error: Error;
  request?: { requestId: string; policy: DeliveryPolicy };
  interruption?: HelperInterruptionOutcome;
}

export interface DesktopDispatch {
  execution: ExecutionTrace;
  failure?: DesktopDispatchFailure;
}

export interface UnverifiedAction {
  index: number;
  action: UiAction;
  outcome: ActOutcome;
}

export interface HelperInterruptionOutcome {
  code: "cancelled" | "owned_by_other_session";
  message: string;
  execution: InterruptedExecutionTrace;
}

export interface BrowserBase {
  stateId: string;
  snapshot: CdpPageSnapshot;
  outline: Outline;
}

export type BrowserPoint = { x: number; y: number };

export type BrowserPreparedAction =
  | { action: "press"; backendNodeId: number; clickCount: number }
  | {
      action: "click";
      target: { backendNodeId: number } | BrowserPoint;
      button: NonNullable<UiAction["button"]>;
      clickCount: number;
    }
  | { action: "setText"; backendNodeId: number; text: string }
  | { action: "typeText"; backendNodeId?: number; text: string }
  | { action: "keypress"; backendNodeId?: number; keys: string[] }
  | { action: "scroll"; backendNodeId?: number; scrollX: number; scrollY: number }
  | { action: "drag"; path: BrowserPoint[] }
  | ({ action: "moveMouse" } & BrowserPoint);

export interface BrowserDispatchFailure {
  index: number;
  error: Error;
}

export interface RefToolParams {
  ref?: string;
}

export interface StatefulToolParams {
  stateId?: string;
}

export interface PersistedToolMessage {
  role?: string;
  toolName?: string;
  details?: JsonObject;
}

export interface PersistedSessionEntry {
  type?: string;
  message?: PersistedToolMessage;
}

export type PersistedSerializedNode = JsonObject & SerializedOutline["root"];
