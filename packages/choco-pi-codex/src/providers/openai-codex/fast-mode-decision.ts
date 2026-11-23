import type { Api, Model } from "@earendil-works/pi-ai";
import { isJsonObject } from "@choco-pi/code-mode/runtime-values";
import { isBoolean, isFunction, isRevision, isString } from "@choco-pi/code-mode/value-guards";
import {
  isOpenAIPlatformModel,
  isOpenAISubscriptionSignInModel,
  OPENAI_SIGN_IN_FAST_REASON,
  type OAuthAwareModelRegistry,
} from "../../adapter/openai-sign-in.ts";

const FAST_MODE_BRIDGE_SYMBOL = Symbol.for("choco-pi.fast-mode-state");

export type CodexFastModeDecision = Readonly<{
  sessionId: string;
  requested: boolean;
  source: "default" | "explicit" | "inherited";
  revision: number;
  supported: boolean;
  active: boolean;
  serviceTier: "priority" | "standard" | undefined;
  reason?: string | undefined;
}>;

export type CodexFastModeSignIn = boolean | OAuthAwareModelRegistry | null | undefined;

type FastModeController = Readonly<{
  getState(): FastModeState;
  decide(model: Model<Api> | undefined): CodexFastModeDecision;
  set(requested: boolean, source?: "default" | "explicit" | "inherited"): FastModeState;
}>;

type FastModeState = Readonly<{
  sessionId: string;
  requested: boolean;
  source: "default" | "explicit" | "inherited";
  revision: number;
}>;
type FastModeRegistrationProbe = Readonly<{ sessionId: string }>;
type FastModeExtensionProbe = Readonly<{ sessionId: string }>;

type FastModeBridge = Readonly<{
  version: 1;
  get(sessionId: string): FastModeController | undefined;
  register(input: FastModeRegistrationProbe): void;
  createExtension(input: FastModeExtensionProbe): void;
}>;

type FastModeBridgeHost = typeof globalThis & {
  [FAST_MODE_BRIDGE_SYMBOL]?: FastModeBridge;
};

const bridgeDecisions = new WeakSet<CodexFastModeDecision>();
function isFastModeSource<Value>(value: Value): value is Value & FastModeState["source"] {
  return value === "default" || value === "explicit" || value === "inherited";
}

function isFastModeBridge<Value>(value: Value): value is Value & FastModeBridge {
  return (
    isJsonObject(value) &&
    value["version"] === 1 &&
    isFunction(value["get"]) &&
    isFunction(value["register"]) &&
    isFunction(value["createExtension"])
  );
}

function isFastModeState<Value>(value: Value): value is Value & FastModeState {
  return (
    isJsonObject(value) &&
    isString(value["sessionId"]) &&
    isBoolean(value["requested"]) &&
    isFastModeSource(value["source"]) &&
    isRevision(value["revision"])
  );
}

function isFastModeDecision<Value>(value: Value): value is Value & CodexFastModeDecision {
  if (!isFastModeState(value) || !isJsonObject(value)) return false;
  const serviceTier = value["serviceTier"];
  const reason = value["reason"];
  return (
    isBoolean(value["supported"]) &&
    isBoolean(value["active"]) &&
    (serviceTier === undefined || serviceTier === "priority" || serviceTier === "standard") &&
    (reason === undefined || isString(reason))
  );
}

function isFastModeController<Value>(value: Value): value is Value & FastModeController {
  return (
    isJsonObject(value) &&
    isFunction(value["getState"]) &&
    isFunction(value["decide"]) &&
    isFunction(value["set"])
  );
}

function validatedBridge(): FastModeBridge | undefined {
  const host: FastModeBridgeHost = globalThis;
  const candidate = host[FAST_MODE_BRIDGE_SYMBOL];
  return isFastModeBridge(candidate) ? candidate : undefined;
}

function validDecision(
  decision: CodexFastModeDecision,
  sessionId: string,
): decision is CodexFastModeDecision {
  return decision.sessionId === sessionId && isFastModeDecision(decision);
}

export function isOpenAISignInFastModeModel(
  model: Model<Api> | null | undefined,
  signIn: CodexFastModeSignIn,
): boolean {
  if (!signIn || !model) return false;
  return signIn === true
    ? isOpenAIPlatformModel(model)
    : isOpenAISubscriptionSignInModel(model, signIn);
}

export function openAISignInFastModeDecision(
  decision: CodexFastModeDecision,
): CodexFastModeDecision {
  return Object.freeze({
    sessionId: decision.sessionId,
    requested: decision.requested,
    source: decision.source,
    revision: decision.revision,
    supported: false,
    active: false,
    serviceTier: undefined,
    reason: OPENAI_SIGN_IN_FAST_REASON,
  });
}

export function snapshotCodexFastModeDecision(
  sessionId: string | undefined,
  model: Model<Api>,
  legacyFast: boolean,
  signIn?: CodexFastModeSignIn,
): CodexFastModeDecision {
  const neutralize = isOpenAISignInFastModeModel(model, signIn);
  const controller = sessionId ? validatedBridge()?.get(sessionId) : undefined;
  if (controller && isFastModeController(controller) && sessionId) {
    const decision = controller.decide(model);
    if (validDecision(decision, sessionId)) {
      const snapshot = neutralize
        ? openAISignInFastModeDecision(decision)
        : Object.freeze({ ...decision });
      bridgeDecisions.add(snapshot);
      return snapshot;
    }
  }
  const supported = model.provider === "openai" || model.provider === "openai-codex";
  const fallback: CodexFastModeDecision = Object.freeze({
    sessionId: sessionId ?? "",
    requested: legacyFast,
    source: "default",
    revision: 0,
    supported,
    active: supported && legacyFast,
    serviceTier: supported ? (legacyFast ? "priority" : "standard") : undefined,
  });
  return neutralize ? openAISignInFastModeDecision(fallback) : fallback;
}

export function isCurrentCodexFastModeDecision(decision: CodexFastModeDecision): boolean {
  if (!bridgeDecisions.has(decision)) return true;
  const controller = validatedBridge()?.get(decision.sessionId);
  if (!controller || !isFastModeController(controller)) return false;
  const state = controller.getState();
  return isFastModeState(state) && state.revision === decision.revision;
}

export function initializeCodexFastModeDefault(
  sessionId: string,
  requested: boolean,
): FastModeState | undefined {
  const controller = validatedBridge()?.get(sessionId);
  if (!controller || !isFastModeController(controller)) return undefined;
  const state = controller.getState();
  if (!isFastModeState(state) || state.source !== "default") return state;
  return state.requested === requested ? state : controller.set(requested, "default");
}

export function codexServiceTierForDecision(
  decision: CodexFastModeDecision,
): "priority" | undefined {
  return decision.serviceTier === "priority" ? "priority" : undefined;
}

export function codexDecisionOmitsServiceTier(decision: CodexFastModeDecision): boolean {
  return decision.serviceTier === "standard";
}
