import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JsonObject, JsonValue } from "../json.ts";
import type { LookResponse } from "../outline.ts";
import type { PermissionStatus } from "../permissions.ts";

export type PlatformName = "macos" | "windows" | "linux";
export type NativeInputDelivery = "hid" | "pid";
export type ActOutcome = "worked" | "didnt" | "unknown";
/**
 * Best-effort presentation hint for a root. The seam guarantees only the
 * `window` vs transient distinction; specific transient kinds are display hints
 * and must never drive behavior in shared code. Platforms that need precise
 * distinctions internally should use native signals.
 */
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
  os?: string;
  arch?: string;
  accessibility?: boolean;
  screenRecording?: boolean;
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
  /** Best-effort; platforms without a main-window concept may mirror `isFocused`. */
  isMain: boolean;
  /** Platform-reported modality fact, including platform-specific modal/dialog/sheet signals. */
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
}

export interface PlatformFocusWindowResult {
  focused: boolean;
  alreadyFocused?: boolean;
  reason?: string;
}

export interface HelperActPerformed {
  grounding?: "description" | "coordinates" | "keyboard-events" | "focus";
  /** `ax` means the platform accessibility API (AX on macOS, UIA on Windows). */
  delivery?: "ax" | NativeInputDelivery;
  /** `caller_required`: a pid-targeted pointer event was posted; the helper cannot attest its effect. */
  verification?: "caller_required";
  refound?: boolean;
  /** Free-form diagnostic naming the platform's delta mechanism. */
  deltaSource?: string;
  selectionGrounding?: "ax" | "keyboard";
  transaction?: boolean;
  actionCount?: number;
  activated?: boolean;
  raised?: boolean;
  focused?: boolean;
}

export interface PlatformRootDelta {
  change: "appeared" | "closed" | "focused";
  kind: string;
  ref?: string;
  title?: string;
  pid: number;
  isModal?: boolean;
  metadata?: JsonObject;
}

export interface HelperActResult {
  outcome: ActOutcome;
  performed?: HelperActPerformed;
  evidence?: JsonObject;
  /** `effectPossible: false` means the helper proved nothing was delivered. */
  error?: { code?: string; message?: string; whatIsThere?: JsonValue; effectPossible?: boolean };
  rootDelta?: PlatformRootDelta[];
  steps?: HelperActResult[];
  stoppedAt?: number;
  /** Frontmost application before/after delivery, when the helper reports it. */
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
  /** Existing immutable look whose untouched refs/coordinate geometry survive a scoped refresh. */
  baseLookId?: string;
  readText: "auto" | "always" | "never";
  scopeRef?: string;
  maxDimension?: number;
  includeImage?: boolean;
}

export type PlatformActTarget =
  | { ref: string }
  | { x: number; y: number }
  | { focus: PlatformPoint };
export type PlatformDeliveryPolicy = "ax_only" | "background" | "foreground";
type PlatformMouseButton = "left" | "right" | "middle";
type PlatformActDeliveryParam = { delivery?: NativeInputDelivery };
export type PlatformPoint = { x: number; y: number };

/** Owning client session for a helper request; generation changes when the session is reset. */
export interface PlatformRequestSession {
  id: string;
  generation: number;
}

/**
 * Helper `cancel` acknowledgement (protocol 7). Terminal: `stopped` (reached a
 * checkpoint; delivers nothing more) and `completed` (finished first).
 * Non-terminal: `stopping` (flagged but still executing; delivery may continue
 * until the helper reports stopped). `not_found`: the helper had not seen the
 * request; it tombstones the id and refuses it if it arrives later.
 * `unacknowledged`: no ack arrived within the client's wait, so delivery state
 * is unknown.
 */
export type HelperCancelState =
  | "stopped"
  | "stopping"
  | "completed"
  | "not_found"
  | "unacknowledged";

export interface HelperCancelAck {
  acknowledged: boolean;
  state: HelperCancelState;
  /** Action index (batch step) at which the request stopped. */
  stoppedAt?: number;
  /** False only when the helper proved nothing was delivered before stopping. */
  effectPossible?: boolean;
}

/** `result` carried by a helper `cancelled` error. */
export interface HelperCancelledResult {
  outcome: "partial" | "rejected_before_delivery";
  stoppedAt?: number;
  reason?: "cancelled" | "deadline";
}

/**
 * Delivery state of an interrupted request: a cancel state, or `refused` for
 * an ownership refusal. Only `stopped`, `completed`, and `refused` are
 * terminal; see `HelperCancelState`.
 */
export type HelperInterruptionState = HelperCancelState | "refused";

/** Why a non-terminal `stopping` interruption cannot prove delivery ended. */
export const HELPER_STOPPING_REASON = "delivery may continue until the helper reports stopped";

/**
 * A helper request stopped by cancellation or deadline, or refused because
 * another session owns the helper. Transports attach it to their errors as
 * `interruption`; shared code maps it to a structured tool result.
 */
export class HelperInterruption {
  readonly code: "cancelled" | "owned_by_other_session";
  /**
   * False only when the helper proved nothing was delivered. Always true for a
   * non-terminal `stopping` state.
   */
  readonly effectPossible?: boolean;
  readonly cancel?: HelperCancelAck;
  readonly result?: HelperCancelledResult;
  /** True when the client gave up (timeout) rather than the helper stopping on its own. */
  readonly clientTimeout: boolean;
  /**
   * `stopped` when the helper itself answered `cancelled`; `refused` for
   * ownership; otherwise the cancel acknowledgement's state.
   */
  readonly state: HelperInterruptionState;
  /** Present for `stopping`: `HELPER_STOPPING_REASON`. */
  readonly reason?: string;

  constructor(fields: {
    code: HelperInterruption["code"];
    effectPossible?: boolean;
    cancel?: HelperCancelAck;
    result?: HelperCancelledResult;
    clientTimeout?: boolean;
    state?: HelperInterruptionState;
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
  }
}

/** Helper `claim` result (protocol 7). */
export interface HelperClaimResult {
  claimed: boolean;
  owner?: PlatformRequestSession;
  ttlMs?: number;
}

export interface PlatformActRequestBase {
  /** Unique per request. */
  requestId: string;
  session: PlatformRequestSession;
  /** Absolute deadline in Unix epoch milliseconds after which the helper must not deliver. */
  deadlineMs: number;
  lookId: string;
  pid?: number;
  target: PlatformActTarget;
  policy: PlatformDeliveryPolicy;
  /** Present only when a host-issued grant covers the target and policy is "foreground". */
  foregroundGrant?: true;
  /** Resolve a focus target through the target app's AX focused element, not system focus. */
  focusResolution?: "ax_focused_element";
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
  /** Observation that owns the element ref. Native backends must not resolve across observations. */
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
  /** Release process-local resources when the Pi session is torn down. */
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
  observe(
    request: PlatformObserveRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<LookResponse>;
  act(
    request: PlatformActRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<HelperActResult>;
  /** Execute one-resource actions with one root baseline and one final settle. */
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
}
