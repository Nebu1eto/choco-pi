import type { Api, Model } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
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
  /** Why an otherwise selectable Fast mode is disabled for this model, for status display. */
  reason?: string | undefined;
}>;

/**
 * Subscription sign-in evidence for `snapshotCodexFastModeDecision`: a registry exposing
 * `isUsingOAuth` (e.g. `ctx.modelRegistry`), or a boolean the caller already resolved.
 * Omitted or `false` preserves the pre-sign-in behavior for every provider.
 */
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
const FastModeBridgeSchema = Type.Object({
  version: Type.Literal(1),
  get: Type.Function([Type.String()], Type.Undefined()),
  register: Type.Function([Type.Object({ sessionId: Type.String() })], Type.Undefined()),
  createExtension: Type.Function([Type.Object({ sessionId: Type.String() })], Type.Undefined()),
});
const FastModeDecisionSchema = Type.Object({
  sessionId: Type.String(),
  requested: Type.Boolean(),
  source: Type.Union([
    Type.Literal("default"),
    Type.Literal("explicit"),
    Type.Literal("inherited"),
  ]),
  revision: Type.Integer({ minimum: 0 }),
  supported: Type.Boolean(),
  active: Type.Boolean(),
  serviceTier: Type.Optional(
    Type.Union([Type.Literal("priority"), Type.Literal("standard"), Type.Undefined()]),
  ),
  reason: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
});
const FastModeStateSchema = Type.Object({
  sessionId: Type.String(),
  requested: Type.Boolean(),
  source: Type.Union([
    Type.Literal("default"),
    Type.Literal("explicit"),
    Type.Literal("inherited"),
  ]),
  revision: Type.Integer({ minimum: 0 }),
});
const FastModeControllerSchema = Type.Object({
  getState: Type.Function([], FastModeStateSchema),
  decide: Type.Function([], FastModeDecisionSchema),
  set: Type.Function([], FastModeStateSchema),
});
type ParsedFastModeBridge = Static<typeof FastModeBridgeSchema>;

function validatedBridge(): FastModeBridge | undefined {
  const host: FastModeBridgeHost = globalThis;
  const candidate = host[FAST_MODE_BRIDGE_SYMBOL];
  if (!Check(FastModeBridgeSchema, candidate)) return undefined;
  const parsed: ParsedFastModeBridge = candidate;
  // TypeBox validates the callable bridge surface; the named contract supplies its domain results.
  if (parsed.version !== 1) return undefined;
  return candidate;
}

function validDecision(
  decision: CodexFastModeDecision,
  sessionId: string,
): decision is CodexFastModeDecision {
  return decision.sessionId === sessionId && Check(FastModeDecisionSchema, decision);
}

/** True when `model` is the stock `openai` provider on api.openai.com with subscription OAuth. */
export function isOpenAISignInFastModeModel(
  model: Model<Api> | null | undefined,
  signIn: CodexFastModeSignIn,
): boolean {
  if (!signIn || !model) return false;
  return signIn === true
    ? isOpenAIPlatformModel(model)
    : isOpenAISubscriptionSignInModel(model, signIn);
}

/**
 * Visible-but-disabled Fast decision for api.openai.com subscription sign-in: the server accepts
 * `service_tier: "priority"` but echoes `default`, so no tier is ever emitted. Keeps the
 * request/source/revision so status and revision-drift checks still reflect the user's choice.
 */
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

/**
 * Freezes one Fast decision for a request. `signIn` (optional) identifies api.openai.com
 * subscription sign-in; when it does, any bridge or fallback decision is neutralized to
 * unsupported with `OPENAI_SIGN_IN_FAST_REASON`. Omitting it keeps the previous behavior.
 */
export function snapshotCodexFastModeDecision(
  sessionId: string | undefined,
  model: Model<Api>,
  legacyFast: boolean,
  signIn?: CodexFastModeSignIn,
): CodexFastModeDecision {
  const neutralize = isOpenAISignInFastModeModel(model, signIn);
  const controller = sessionId ? validatedBridge()?.get(sessionId) : undefined;
  if (controller && Check(FastModeControllerSchema, controller) && sessionId) {
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
  if (!controller || !Check(FastModeControllerSchema, controller)) return false;
  const state = controller.getState();
  return Check(FastModeStateSchema, state) && state.revision === decision.revision;
}

export function initializeCodexFastModeDefault(
  sessionId: string,
  requested: boolean,
): FastModeState | undefined {
  const controller = validatedBridge()?.get(sessionId);
  if (!controller || !Check(FastModeControllerSchema, controller)) return undefined;
  const state = controller.getState();
  if (!Check(FastModeStateSchema, state) || state.source !== "default") return state;
  return state.requested === requested ? state : controller.set(requested, "default");
}

/**
 * Mirrors openai/codex `service_tier_for_request`: only `priority` is sent; standard omits the
 * field rather than sending `default`.
 */
export function codexServiceTierForDecision(
  decision: CodexFastModeDecision,
): "priority" | undefined {
  return decision.serviceTier === "priority" ? "priority" : undefined;
}

/** Whether a frozen decision requires removing any `service_tier` already on the payload. */
export function codexDecisionOmitsServiceTier(decision: CodexFastModeDecision): boolean {
  return decision.serviceTier === "standard";
}
