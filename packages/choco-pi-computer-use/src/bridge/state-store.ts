import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { disconnectCdp } from "../cdp.ts";
import { getBackgroundDelivery, getComputerUseConfig, isHeadlessMode } from "../config.ts";
import type { ImageMode, UiAction } from "../contract.ts";
import { isString, type JsonField, type JsonObject } from "../json.ts";
import {
  nodeByRef,
  outlineNodeLabel,
  type LookResponse,
  type Outline,
  type OutlineNode,
} from "../outline.ts";
import { clearStoredOutputs } from "../output.ts";
import { currentPlatformBackend } from "../platform/index.ts";
import type { NativeInputDelivery, PlatformPoint } from "../platform/types.ts";
import {
  currentSessionScope,
  ResourceScheduler,
  retireAllSessionScopes,
  retireSessionScope,
  StaleResourceStateError,
  type SessionScope,
  type StoredState,
} from "../runtime.ts";
import {
  SavedStates,
  type CurrentCapture,
  type CurrentTarget,
  type OperationState,
} from "../state.ts";
import {
  ObservationRefreshRequiredError,
  type ActivationFlags,
  type CaptureResult,
  type ComputerUseDetails,
  type ComputerUseDetailsConfig,
  type DeliveryPolicy,
  type ExecutionTrace,
  type ExecutionVariant,
  type ForegroundSectionLease,
  type ForegroundSectionTrace,
  type ObservationRefreshReason,
  type ResolvedTarget,
  type RuntimeState,
  type WindowRefRecord,
} from "./types.ts";

export const MISSING_TARGET_ERROR =
  "No current controlled window. Call observe_ui first to choose a target window.";
export const CURRENT_TARGET_GONE_ERROR =
  "The current controlled window is no longer available. Call observe_ui to choose a new target window.";

export const COMMAND_TIMEOUT_MS = 15_000;
export const LOOK_TIMEOUT_MS = 33_000;

export const ACTION_SETTLE_MS = 280;

export const BROWSER_CONTEXT_PREFIX = "browser:";
export const MANAGED_BROWSER_READY_TIMEOUT_MS = 15_000;
export const AUTO_IMAGE_MAX_DIMENSION = 900;
export const EXPLICIT_IMAGE_MAX_DIMENSION = 1_600;
export const BROWSER_TRANSACTION_ACTIONS = new Set<UiAction["action"]>([
  "press",
  "click",
  "setText",
  "typeText",
  "keypress",
  "scroll",
  "drag",
  "moveMouse",
]);
export const AUTO_OBSERVE_TOOLS = new Set(["search_ui", "expand_ui", "inspect_ui"]);
export const OBSERVATION_REQUIRED_MUTATIONS = new Set(["act_ui"]);

interface SessionRootRefs {
  readonly windowRefs: Map<string, WindowRefRecord>;
  readonly windowRefByIdentity: Map<string, string>;
  readonly browserRootByContext: Map<string, string>;
  readonly browserContextByRoot: Map<string, string>;
  nextRootRefIndex: number;
}

const rootRefsByScope = new WeakMap<SessionScope, SessionRootRefs>();

function sessionRootRefs(): SessionRootRefs {
  const scope = currentSessionScope();
  let refs = rootRefsByScope.get(scope);
  if (!refs) {
    refs = {
      windowRefs: new Map(),
      windowRefByIdentity: new Map(),
      browserRootByContext: new Map(),
      browserContextByRoot: new Map(),
      nextRootRefIndex: 1,
    };
    rootRefsByScope.set(scope, refs);
  }
  return refs;
}

export const runtimeState: RuntimeState = {
  lastPermissionCheckAt: 0,
  get windowRefs() {
    return sessionRootRefs().windowRefs;
  },
  get windowRefByIdentity() {
    return sessionRootRefs().windowRefByIdentity;
  },
  get browserRootByContext() {
    return sessionRootRefs().browserRootByContext;
  },
  get browserContextByRoot() {
    return sessionRootRefs().browserContextByRoot;
  },
  get nextRootRefIndex() {
    return sessionRootRefs().nextRootRefIndex;
  },
  set nextRootRefIndex(value: number) {
    sessionRootRefs().nextRootRefIndex = value;
  },
};

export function clearSessionRootRefs(): void {
  rootRefsByScope.delete(currentSessionScope());
}

export const savedStates = new SavedStates();
export let resourceScheduler = new ResourceScheduler();

export function operationState(): OperationState {
  return savedStates.current();
}

export function desktopResourceKey(target: Pick<CurrentTarget, "pid">): string {
  return `desktop-pid:${target.pid}`;
}

export function persistOperation(state: OperationState): void {
  if (!state.currentTarget || !state.currentCapture || !state.currentLook || !state.currentOutline)
    return;
  const resourceKey = state.resourceKey ?? desktopResourceKey(state.currentTarget);
  const epoch = state.epoch ?? resourceScheduler.epoch(resourceKey);
  savedStates.saveDesktop(state, resourceKey, epoch);
}

export function refreshArguments(state: OperationState): JsonObject {
  const root = state.currentTarget?.windowRef;
  if (root) return { root, mode: "fused" };
  const contextId = state.contextId;
  if (isBrowserContextId(contextId)) return { root: storeBrowserRootRef(contextId), mode: "fused" };
  return { mode: "fused" };
}

export function observationRefreshRequired(
  operation: string,
  reason: ObservationRefreshReason,
  state: OperationState,
  stateId?: string,
  stale?: Pick<StaleResourceStateError, "resourceKey" | "expectedEpoch" | "actualEpoch">,
): ObservationRefreshRequiredError {
  return new ObservationRefreshRequiredError({
    code: "observation_refresh_required",
    operation,
    reason,
    stateId,
    refresh: { tool: "observe_ui", arguments: refreshArguments(state) },
    staleness: stale
      ? {
          resourceKey: stale.resourceKey,
          observationEpoch: stale.expectedEpoch,
          currentEpoch: stale.actualEpoch,
        }
      : undefined,
  });
}

export function staleObservation(
  record: StoredState<unknown> | undefined,
): StaleResourceStateError | undefined {
  if (!record) return undefined;
  const currentEpoch = resourceScheduler.epoch(record.resourceKey);
  return record.epoch === currentEpoch
    ? undefined
    : new StaleResourceStateError(record.resourceKey, record.epoch, currentEpoch);
}

interface HelperOwner {
  readonly id: string;
  generation: number;
}

interface ForegroundGate {
  held: boolean;
  readonly waiters: Array<() => void>;
  unconfirmed: string | undefined;
}

interface ProcessSlot {
  readonly owner: HelperOwner;
  readonly sessions: Map<string, string>;
  readonly releasers: Map<string, () => Promise<void>>;
  readonly foreground: ForegroundGate;
}

const PROCESS_SLOT_KEY = Symbol.for("choco-pi.computer-use.process-state.v1");
const INSTANCE_ID = randomUUID();

function isText<T>(value: T): value is T & string {
  return (
    value !== null &&
    value !== undefined &&
    Object(value) !== value &&
    Object(value).constructor === String
  );
}

function isHelperOwner<T>(value: T): value is T & HelperOwner {
  if (value === null || value === undefined || Object(value) !== value) return false;
  const owner = Object(value);
  return (
    isText(owner.id) &&
    owner.id.length > 0 &&
    Number.isSafeInteger(owner.generation) &&
    owner.generation >= 0
  );
}

function isTextMap<T>(value: T): value is T & Map<string, string> {
  if (!(value instanceof Map)) return false;
  for (const [key, entry] of value) if (!isText(key) || !isText(entry)) return false;
  return true;
}

function isReleaserMap<T>(value: T): value is T & Map<string, () => Promise<void>> {
  if (!(value instanceof Map)) return false;
  for (const [key, entry] of value) if (!isText(key) || !(entry instanceof Function)) return false;
  return true;
}

function isCallbackList<T>(value: T): value is T & Array<() => void> {
  if (!Array.isArray(value)) return false;
  for (const entry of value) if (!(entry instanceof Function)) return false;
  return true;
}

function isForegroundGate<T>(value: T): value is T & ForegroundGate {
  if (value === null || value === undefined || Object(value) !== value) return false;
  const gate = Object(value);
  return (
    (gate.held === true || gate.held === false) &&
    isCallbackList(gate.waiters) &&
    (gate.unconfirmed === undefined || isText(gate.unconfirmed))
  );
}

function isProcessSlot<T>(value: T): value is T & ProcessSlot {
  if (value === null || value === undefined || Object(value) !== value) return false;
  const slot = Object(value);
  return (
    isHelperOwner(slot.owner) &&
    isTextMap(slot.sessions) &&
    isReleaserMap(slot.releasers) &&
    isForegroundGate(slot.foreground)
  );
}

function processSlot(): ProcessSlot {
  const existing = Object.getOwnPropertyDescriptor(globalThis, PROCESS_SLOT_KEY)?.value;
  if (isProcessSlot(existing)) return existing;
  const slot: ProcessSlot = {
    owner: { id: randomUUID(), generation: 0 },
    sessions: new Map(),
    releasers: new Map(),
    foreground: { held: false, waiters: [], unconfirmed: undefined },
  };
  Object.defineProperty(globalThis, PROCESS_SLOT_KEY, {
    value: slot,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  return slot;
}

export const helperRequestSession: HelperOwner = processSlot().owner;

export async function acquireForegroundSection(
  signal?: AbortSignal,
): Promise<ForegroundSectionLease> {
  throwIfAborted(signal);
  const gate = processSlot().foreground;
  const started = performance.now();
  if (gate.held) {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = gate.waiters.indexOf(grant);
        if (index >= 0) gate.waiters.splice(index, 1);
        reject(new Error("Operation aborted."));
      };
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      gate.waiters.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  gate.held = true;
  const trace: ForegroundSectionTrace = { waitedMs: Math.round(performance.now() - started) };
  if (gate.unconfirmed !== undefined) trace.previousDeliveryUnconfirmed = gate.unconfirmed;
  gate.unconfirmed = undefined;
  let released = false;
  return {
    trace,
    release(unconfirmedRequestId) {
      if (released) return;
      released = true;
      if (unconfirmedRequestId !== undefined) gate.unconfirmed = unconfirmedRequestId;
      const next = gate.waiters.shift();
      if (next) next();
      else gate.held = false;
    },
  };
}

function releaseManagedBrowser(): void {
  disconnectCdp();
  const managedBrowser = runtimeState.managedBrowser;
  runtimeState.managedBrowser = undefined;
  if (managedBrowser) {
    managedBrowser.kill("SIGTERM");
    managedBrowser.unref();
  }
  if (
    runtimeState.managedBrowserCdpPort &&
    process.env.PI_COMPUTER_USE_CDP_PORT === runtimeState.managedBrowserCdpPort
  ) {
    if (runtimeState.previousCdpPort === undefined) delete process.env.PI_COMPUTER_USE_CDP_PORT;
    else process.env.PI_COMPUTER_USE_CDP_PORT = runtimeState.previousCdpPort;
  }
  runtimeState.managedBrowserCdpPort = undefined;
  runtimeState.previousCdpPort = undefined;
}

async function releaseInstanceProcessResources(): Promise<void> {
  releaseManagedBrowser();
  await currentPlatformBackend.shutdown?.();
}

export function sessionKeyOf(ctx: Pick<ExtensionContext, "sessionManager">): string {
  return ctx.sessionManager.getSessionId();
}

function instanceHasLiveSessions(slot: ProcessSlot): boolean {
  for (const instance of slot.sessions.values()) if (instance === INSTANCE_ID) return true;
  return false;
}

export function registerComputerUseSession(sessionKey: string): void {
  const slot = processSlot();
  slot.sessions.set(sessionKey, INSTANCE_ID);
  slot.releasers.set(INSTANCE_ID, releaseInstanceProcessResources);
}

export function hasOtherLiveSession(sessionKey: string): boolean {
  for (const [key, instance] of processSlot().sessions)
    if (key !== sessionKey && instance === INSTANCE_ID) return true;
  return false;
}

export function liveComputerUseSessions(): string[] {
  return [...processSlot().sessions.keys()];
}

export async function endComputerUseSession(sessionKey: string): Promise<void> {
  retireSessionScope(sessionKey);
  clearStoredOutputs(sessionKey);
  const slot = processSlot();
  if (slot.sessions.get(sessionKey) === INSTANCE_ID) slot.sessions.delete(sessionKey);
  if (instanceHasLiveSessions(slot)) return;
  await releaseInstanceResources(slot);
}

export async function shutdownComputerUseSession(): Promise<void> {
  const slot = processSlot();
  for (const [key, instance] of slot.sessions)
    if (instance === INSTANCE_ID) slot.sessions.delete(key);
  await releaseInstanceResources(slot);
}

async function releaseInstanceResources(slot: ProcessSlot): Promise<void> {
  const processEnding = slot.sessions.size === 0;
  if (processEnding) slot.owner.generation += 1;
  retireAllSessionScopes();
  const closing = resourceScheduler;
  const closed = closing.close();
  runtimeState.permissionStatus = undefined;
  runtimeState.helperDiagnostics = undefined;
  runtimeState.lastPermissionCheckAt = 0;

  await closed;
  if (resourceScheduler === closing) resourceScheduler = new ResourceScheduler();
  if (instanceHasLiveSessions(slot)) return;
  clearStoredOutputs();
  retireAllSessionScopes();

  if (!processEnding || slot.sessions.size > 0) return;
  releaseManagedBrowser();
  const releasers = [...slot.releasers.values()];
  slot.releasers.clear();
  await Promise.allSettled(releasers.map(async (release) => await release()));
}

export function currentRuntimeMode(): ExecutionVariant {
  return isHeadlessMode() ? "stealth" : "default";
}

export function currentDeliveryPolicy(): DeliveryPolicy {
  if (isHeadlessMode()) return "ax_only";
  const value = deliveryPolicyEnv()?.value;
  return value === "ax_only" || value === "ax-only" ? "ax_only" : "background";
}

export function deliveryPolicyEnv(): { name: string; value: string } | undefined {
  for (const name of ["PI_COMPUTER_USE_DELIVERY_POLICY", "PI_COMPUTER_USE_EVENT_DELIVERY"]) {
    const raw = process.env[name];
    if (raw !== undefined) return { name, value: raw.trim().toLowerCase() };
  }
  return undefined;
}

export function deliveryPolicyNotes(): string[] {
  const env = deliveryPolicyEnv();
  if (!env) return [];
  if (env.value === "foreground" || env.value === "hid") {
    return [
      `${env.name}=${env.value} is ignored: foreground delivery requires a host-issued grant (PI_COMPUTER_USE_FOREGROUND_GRANT or "foreground_grant" in the computer-use config).`,
    ];
  }
  if (["", "default", "background", "pid", "ax_only", "ax-only"].includes(env.value)) return [];
  return [`${env.name}=${env.value} is not recognized; background delivery is used.`];
}

export function detailsConfig(): ComputerUseDetailsConfig {
  const notes = deliveryPolicyNotes();
  const { background_delivery: _configured, ...config } = getComputerUseConfig();
  const shown: ComputerUseDetailsConfig =
    getBackgroundDelivery() === "extended"
      ? { ...config, background_delivery: "extended" }
      : config;
  return notes.length > 0 ? { ...shown, notes } : shown;
}

export function nativeInputDelivery(policy = currentDeliveryPolicy()): NativeInputDelivery {
  return policy === "foreground" ? "hid" : "pid";
}

export function executionTrace(
  strategy: ExecutionTrace["strategy"],
  variant: ExecutionVariant,
  metadata: Omit<ExecutionTrace, "strategy" | "runtimeMode" | "variant" | "stealthCompatible"> = {},
): ExecutionTrace {
  return {
    strategy,
    runtimeMode: currentRuntimeMode(),
    variant,
    stealthCompatible: variant === "stealth",
    ...metadata,
  };
}

export function settleMsForExecution(execution: ExecutionTrace): number {
  if (execution.performed?.deltaSource) return 0;
  if (execution.variant === "stealth") {
    switch (execution.strategy) {
      case "browser_open_location":
        return 120;
      default:
        return 120;
    }
  }
  return ACTION_SETTLE_MS;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Operation aborted.");
  }
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  throwIfAborted(signal);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new Error("Operation aborted."));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withWindowWriteLock<T>(
  target: ResolvedTarget | CurrentTarget,
  work: () => Promise<T>,
): Promise<T> {
  const state = operationState();
  const key = desktopResourceKey(target);
  const baseEpoch = state.epoch ?? resourceScheduler.epoch(key);
  const result = await resourceScheduler.write(key, baseEpoch, async (nextEpoch) => {
    state.resourceKey = key;
    state.epoch = nextEpoch;
    return await work();
  });
  return result.value;
}

export function trimOrUndefined(value: string | undefined): string | undefined {
  if (!isString(value)) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function toBoolean(value: JsonField): boolean {
  return value === true;
}

export function outlineNodeCenter(node: OutlineNode): PlatformPoint {
  if (!node.rect) {
    throw new Error(
      `Outline ref '${node.ref}' has no full-look coordinates after scoped expansion. Re-observe for coordinates.`,
    );
  }
  return { x: node.rect.x + node.rect.w / 2, y: node.rect.y + node.rect.h / 2 };
}

export function validateStateId(stateId?: string): CurrentCapture {
  const state = operationState();
  if (!state.currentCapture) {
    throw new Error("No observation state is available. Call observe_ui first.");
  }
  const supplied = stateId;
  if (supplied && state.currentCapture.stateId !== supplied) {
    throw new Error(
      `Stale state '${supplied}'. The active operation state is '${state.currentCapture.stateId}'. Observe the root again and retry.`,
    );
  }
  const stateTarget = state.currentStateTarget;
  if (
    stateTarget &&
    state.currentTarget &&
    (stateTarget.pid !== state.currentTarget.pid ||
      stateTarget.windowId !== state.currentTarget.windowId)
  ) {
    throw new Error(
      "The latest state belongs to a different window. Call observe_ui for the target window and retry.",
    );
  }
  return state.currentCapture;
}

export function formatOutlineNodeLabel(node: OutlineNode): string {
  const label = outlineNodeLabel(node) || "(unlabeled)";
  const identifier = node.identifier ? ` id=${JSON.stringify(node.identifier)}` : "";
  const capabilities = [
    node.canSetValue ? "set_value" : undefined,
    node.canPress ? "press" : undefined,
    node.canFocus ? "focus" : undefined,
    node.canScroll ? "scroll" : undefined,
    node.canIncrement || node.canDecrement ? "adjust" : undefined,
    node.pictureOnly ? "picture_only" : undefined,
  ].filter((item): item is string => Boolean(item));
  return `${node.ref} ${node.role}${node.subrole ? `/${node.subrole}` : ""}${identifier} ${JSON.stringify(label)}${capabilities.length ? ` [${capabilities.join(",")}]` : ""}`;
}

export function outlineNodeByRef(ref: string): OutlineNode {
  const state = operationState();
  const outline = state.currentOutline;
  const node = outline ? nodeByRef(outline, ref) : undefined;
  if (!node) {
    const windowHint = state.currentTarget?.windowRef
      ? `({ root: "${state.currentTarget.windowRef}" })`
      : "";
    throw new Error(
      `Outline ref '${ref}' is stale or not available for the latest state. Call observe_ui${windowHint} again and choose a current @e ref.`,
    );
  }
  return node;
}

export function wireRefForNode(node: OutlineNode): string {
  if (node.pictureOnly || !node.wireRef) {
    throw new Error(
      `Outline ref '${node.ref}' is picture_only and has no semantic element. It can be clicked by coordinates, but semantic-only actions are not available.`,
    );
  }
  return node.wireRef;
}

export function imageFallbackReason(
  tool: string,
  result: CaptureResult,
  imageMode: ImageMode = "auto",
): { reason: NonNullable<ComputerUseDetails["imageReason"]>; message: string } | undefined {
  if (imageMode === "never") return undefined;
  if (imageMode === "always")
    return {
      reason: "fallback_recovery",
      message: "An image was requested explicitly for visual verification.",
    };
  const outline = result.outline;
  const labeled = outline.nodes.filter((node) => outlineNodeLabel(node)).length;
  if (outline.nodes.length < 3) {
    return {
      reason: "sparse_ax_targets",
      message: "Only a few outline nodes were found, so the look image is attached for context.",
    };
  }
  if (labeled * 3 < outline.nodes.length) {
    return {
      reason: "unlabeled_ax_targets",
      message: "Most outline nodes are unlabeled, so the look image is attached for context.",
    };
  }
  if (
    tool === "wait" &&
    currentPlatformBackend.isBrowserApp(result.target.appName, result.target.bundleId)
  ) {
    return {
      reason: "browser_wait_verification",
      message:
        "Browser content may have changed visually during wait, so an image is attached for fallback.",
    };
  }
  return undefined;
}

export function currentTargetOrThrow(): CurrentTarget {
  const target = operationState().currentTarget;
  if (!target) {
    throw new Error(MISSING_TARGET_ERROR);
  }
  return target;
}

export function emptyActivation(): ActivationFlags {
  return { activated: false, unminimized: false, raised: false };
}

export async function ensureReady(ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const ready = await currentPlatformBackend.ensureReady(
    ctx,
    {
      permissionStatus: runtimeState.permissionStatus,
      lastPermissionCheckAt: runtimeState.lastPermissionCheckAt,
      helperDiagnostics: runtimeState.helperDiagnostics,
      session: { id: helperRequestSession.id, generation: helperRequestSession.generation },
    },
    signal,
  );
  runtimeState.permissionStatus = ready.permissionStatus;
  runtimeState.lastPermissionCheckAt = ready.lastPermissionCheckAt;
  runtimeState.helperDiagnostics = ready.helperDiagnostics;
}

export async function ensureComputerUseSetup(
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<void> {
  await ensureReady(ctx, signal);
}

export function storeBrowserRootRef(contextId: string): string {
  const existing = runtimeState.browserRootByContext.get(contextId);
  if (existing) return existing;
  const ref = `@r${runtimeState.nextRootRefIndex++}`;
  runtimeState.browserRootByContext.set(contextId, ref);
  runtimeState.browserContextByRoot.set(ref, contextId);
  return ref;
}

export function currentLookOrThrow(): LookResponse {
  const state = operationState();
  if (!state.currentLook || !state.currentCapture) {
    throw new Error(
      "No current look. Call observe_ui first, then act using refs or coordinates from that look.",
    );
  }
  return state.currentLook;
}

export function isBrowserContextId(contextId: string | undefined): contextId is string {
  return Boolean(contextId?.startsWith(BROWSER_CONTEXT_PREFIX));
}

export function currentOutlineOrThrow(stateId?: string): Outline {
  validateStateId(stateId);
  const outline = operationState().currentOutline;
  if (!outline) throw new Error("No observation outline is available. Call observe_ui first.");
  return outline;
}
