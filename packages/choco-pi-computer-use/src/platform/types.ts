import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JsonObject, JsonValue } from "../json.ts";
import type { LookResponse } from "../outline.ts";
import type { PermissionStatus } from "../permissions.ts";

export type PlatformName = "macos" | "windows" | "linux";
export type ManagedBrowserKind = "helium" | "chrome";
export type NativeInputDelivery = "hid" | "pid";
export type ActOutcome = "worked" | "didnt" | "unknown";
export type PlatformRootKind = "window" | "menu" | "sheet" | "popover" | "dialog";

export interface PlatformDiagnostics {
  protocolVersion: number;
  architectureVersion?: number;
  invariants?: string[];
  pid: number;
  parentPid?: number;
  parentAppName?: string;
  parentBundleId?: string;
  parentPath?: string;
  executablePath?: string;
  startedAt?: number;
  os?: string;
  arch?: string;
  accessibility?: boolean;
  screenRecording?: boolean;
  extendedDelivery?: { available: boolean; reason?: string };
}

export interface PlatformReadyState {
  permissionStatus?: PermissionStatus;
  lastPermissionCheckAt: number;
  helperDiagnostics?: PlatformDiagnostics;
}

export interface PlatformRootQuery {
  pid?: number;
  title?: string;
}

export interface PlatformApp {
  appName: string;
  bundleId?: string;
  pid: number;
  isFrontmost?: boolean;
}

export interface FramePoints {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlatformRoot {
  kind: PlatformRootKind;
  rootRef?: string;
  windowRef?: string;
  windowId?: number;
  pid?: number;
  appName?: string;
  bundleId?: string;
  title: string;
  role?: string;
  subrole?: string;
  zOrder: number;
  framePoints: FramePoints;
  scaleFactor: number;
  isOnscreen: boolean;
  isFocused: boolean;
  isMinimized: boolean;
  isMain: boolean;
  isModal: boolean;
  metadata?: JsonObject;
}

export interface PlatformFrontmostResult {
  appName: string;
  bundleId?: string;
  pid: number;
  windowTitle?: string;
  windowId?: number;
  rootRef?: string;
  windowSource?: "focused" | "main" | "unknown";
}

export interface PlatformFocusWindowResult {
  focused: boolean;
  alreadyFocused?: boolean;
  reason?: string;
}

export interface PlatformRestoreUserFocusRequest {
  pid: number;
  windowRef?: string;
  windowId?: number;
  windowTitle?: string;
  expectedFrontmostPid?: number;
}

export interface PlatformRestoreUserFocusResult {
  restored: boolean;
  appRestored?: boolean;
  windowRestored?: boolean;
  appName?: string;
  windowTitle?: string;
  reason?: string;
  windowMatch?: string;
  frontmostPid?: number;
}

export interface HelperActPerformed {
  grounding?: "description" | "coordinates" | "keyboard-events" | "focus";
  delivery?: "ax" | NativeInputDelivery;
  verification?: "caller_required";
  refound?: boolean;
  deltaSource?: string;
  selectionGrounding?: "ax" | "keyboard";
  transaction?: boolean;
  actionCount?: number;
  activated?: boolean;
  raised?: boolean;
  focused?: boolean;
  destinationWindow?: "verified" | "unverified";
  extendedDelivery?: ExtendedDeliveryStatus;
  extendedDeliveryReason?: string;
  textEntry?: "characters";
}

export type ExtendedDeliveryStatus = "used" | "unavailable" | "not_applicable";

export interface PlatformRootDelta {
  change: "appeared" | "closed" | "focused";
  kind: string;
  ref?: string;
  title?: string;
  pid: number;
  isModal?: boolean;
  metadata?: JsonObject;
}

export interface HelperRefusalEvidence {
  pidPointerAttempted?: boolean;
  observableChange?: boolean;
  deliveryUsed?: string;
  pixelCheck?: string;
  pixelChange?: boolean;
  pixelChangeOutsideTarget?: boolean;
  frontmostChangedElsewhere?: boolean;
  frontmostChangedTo?: number;
  extendedDelivery?: string;
}

export interface HelperAppBlock {
  pid: number;
  appName?: string;
  bundleId?: string;
  match?: string;
}

export const FOREGROUND_NOT_ACQUIRED = "foreground_not_acquired";
export const FOREGROUND_LOST = "foreground_lost";

export function isForegroundDestinationCode(code: string | undefined): boolean {
  return code === FOREGROUND_NOT_ACQUIRED || code === FOREGROUND_LOST;
}

export interface HelperDestinationFailure {
  inputSent: boolean;
  activationAttempted?: boolean;
  charactersSent?: number;
  reason?: string;
  frontmostPid?: number;
  frontmostBefore?: number;
  frontmostAfter?: number;
}

export class PlatformCommandError extends Error {
  readonly evidence?: HelperRefusalEvidence;
  readonly code?: string;
  readonly destination?: HelperDestinationFailure;
  readonly inputSent?: boolean;

  constructor(
    message: string,
    evidence?: HelperRefusalEvidence,
    code?: string,
    destination?: HelperDestinationFailure,
    inputSent?: boolean,
  ) {
    super(message);
    this.name = "PlatformCommandError";
    this.evidence = evidence;
    this.code = code;
    this.destination = destination;
    this.inputSent = inputSent ?? destination?.inputSent;
  }
}

export interface HelperActResult {
  outcome: ActOutcome;
  performed?: HelperActPerformed;
  evidence?: JsonObject;
  error?: {
    code?: string;
    message?: string;
    whatIsThere?: JsonValue;
    effectPossible?: boolean;
    evidence?: HelperRefusalEvidence;
    inputSent?: boolean;
    activationAttempted?: boolean;
    charactersSent?: number;
    destinationReason?: string;
    extendedDelivery?: string;
  };
  rootDelta?: PlatformRootDelta[];
  steps?: HelperActResult[];
  stoppedAt?: number;
  frontmostBefore?: JsonValue;
  frontmostAfter?: JsonValue;
}

export interface PlatformTarget {
  pid?: number;
  windowId?: number;
  rootRef?: string;
}

export interface PlatformObserveRequest {
  target: PlatformTarget;
  baseLookId?: string;
  readText: "auto" | "always" | "never";
  scopeRef?: string;
  maxDimension?: number;
  includeImage?: boolean;
}

export type PlatformActTarget =
  | { ref: string }
  | { x: number; y: number }
  | { focus: PlatformPoint | Record<string, never> };
export type PlatformDeliveryPolicy = "ax_only" | "background" | "foreground";
type PlatformMouseButton = "left" | "right" | "middle";
type PlatformActDeliveryParam = { delivery?: NativeInputDelivery };
export type PlatformPoint = { x: number; y: number };

export interface PlatformRequestSession {
  id: string;
  generation: number;
}

export type HelperCancelState =
  | "stopped"
  | "stopping"
  | "completed"
  | "not_found"
  | "unacknowledged";

export interface HelperCancelAck {
  acknowledged: boolean;
  state: HelperCancelState;
  stoppedAt?: number;
  effectPossible?: boolean;
}

export interface HelperCancelledResult {
  outcome: "partial" | "rejected_before_delivery";
  stoppedAt?: number;
  reason?: "cancelled" | "deadline";
}

export type HelperInterruptionState = HelperCancelState | "refused";

export const HELPER_STOPPING_REASON = "delivery may continue until the helper reports stopped";

export interface HelperSettlement {
  settled: boolean;
  state: HelperCancelState;
}

export class HelperInterruption {
  readonly code: "cancelled" | "owned_by_other_session";
  readonly effectPossible?: boolean;
  readonly cancel?: HelperCancelAck;
  readonly result?: HelperCancelledResult;
  readonly clientTimeout: boolean;
  readonly connectionLost: boolean;
  readonly state: HelperInterruptionState;
  readonly reason?: string;
  readonly settle?: () => Promise<HelperSettlement>;

  constructor(fields: {
    code: HelperInterruption["code"];
    effectPossible?: boolean;
    cancel?: HelperCancelAck;
    result?: HelperCancelledResult;
    clientTimeout?: boolean;
    connectionLost?: boolean;
    state?: HelperInterruptionState;
    settle?: () => Promise<HelperSettlement>;
  }) {
    this.code = fields.code;
    this.state =
      fields.state ??
      (fields.code === "owned_by_other_session"
        ? "refused"
        : fields.result
          ? "stopped"
          : (fields.cancel?.state ?? "unacknowledged"));
    const stopping = this.state === "stopping";
    this.effectPossible = stopping ? true : fields.effectPossible;
    if (stopping) this.reason = HELPER_STOPPING_REASON;
    this.cancel = fields.cancel;
    this.result = fields.result;
    this.clientTimeout = fields.clientTimeout === true;
    this.connectionLost = fields.connectionLost === true;
    this.settle = fields.settle;
  }
}

export interface HelperClaimResult {
  claimed: boolean;
  owner?: PlatformRequestSession;
  ttlMs?: number;
}

export interface PlatformActRequestBase {
  requestId: string;
  session: PlatformRequestSession;
  budgetMs: number;
  lookId: string;
  pid?: number;
  target: PlatformActTarget;
  policy: PlatformDeliveryPolicy;
  foregroundGrant?: true;
  focusResolution?: "ax_focused_element";
  backgroundDelivery?: "extended";
}

export type PlatformActRequest = PlatformActRequestBase &
  (
    | {
        action: "press" | "click";
        params: { button?: PlatformMouseButton; clickCount?: number } & PlatformActDeliveryParam;
      }
    | { action: "setText"; params: { text: string } & PlatformActDeliveryParam }
    | { action: "typeText"; params: { text: string } & PlatformActDeliveryParam }
    | { action: "keypress"; params: { keys: string[] } & PlatformActDeliveryParam }
    | { action: "scroll"; params: { scrollX: number; scrollY: number } & PlatformActDeliveryParam }
    | { action: "drag"; params: { path: PlatformPoint[] } & PlatformActDeliveryParam }
    | { action: "moveMouse"; params: PlatformActDeliveryParam }
  );

export interface PlatformReadTextRequest {
  lookId: string;
  elementRef: string;
  offset: number;
  limit: number;
}

export interface PlatformReadTextResponse {
  text: string;
  offset: number;
  limit: number;
  totalChars: number;
  hasMore: boolean;
}

export interface PlatformWaitForRequest extends PlatformTarget {
  lookId?: string;
  text?: string;
  role?: string;
  value?: string;
  scopeRef?: string;
  scopeExact?: boolean;
  gone: boolean;
  timeoutMs: number;
}

export interface PlatformWaitForResponse {
  found: boolean;
  gone?: boolean;
  timedOut?: boolean;
  nodeCount?: number;
}

export interface ComputerUsePlatformBackend {
  name: PlatformName;
  shutdown?(): void | Promise<void>;
  ensureReady(
    ctx: ExtensionContext,
    state: PlatformReadyState,
    signal?: AbortSignal,
  ): Promise<PlatformReadyState>;
  listApps(signal?: AbortSignal): Promise<PlatformApp[]>;
  listRoots(query: PlatformRootQuery, signal?: AbortSignal): Promise<PlatformRoot[]>;
  getFrontmost(signal?: AbortSignal): Promise<PlatformFrontmostResult>;
  focusWindow(target: PlatformTarget, signal?: AbortSignal): Promise<PlatformFocusWindowResult>;
  restoreUserFocus(
    request: PlatformRestoreUserFocusRequest,
    signal?: AbortSignal,
  ): Promise<PlatformRestoreUserFocusResult>;
  observe(
    request: PlatformObserveRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<LookResponse>;
  act(
    request: PlatformActRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<HelperActResult>;
  actBatch?(
    requests: PlatformActRequest[],
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<HelperActResult>;
  readText(
    args: PlatformReadTextRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<PlatformReadTextResponse>;
  waitFor(
    args: PlatformWaitForRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<PlatformWaitForResponse>;
  isBrowserApp(appName: string, bundleId?: string): boolean;
  isChromeFamilyApp(appName: string, bundleId?: string): boolean;
  openBrowserLocation(
    target: { appName: string; bundleId?: string },
    url: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  managedBrowserExecutableCandidates?(browser: ManagedBrowserKind): string[];
}
