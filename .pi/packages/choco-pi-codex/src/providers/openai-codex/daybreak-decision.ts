import { Type } from "typebox";
import { Check } from "typebox/value";
import {
  type CodexLikeModelDescriptor,
  isCanonicalCodexSubscriptionModel,
} from "../../adapter/prompt/codex-model.ts";
import {
  DAYBREAK_BRIDGE_SYMBOL,
  type CodexDaybreakDecision,
  type DaybreakBridge,
  type DaybreakController,
  type DaybreakOutcome,
  type DaybreakState,
} from "./daybreak-types.ts";
import {
  copyDaybreakHeaders,
  daybreakAccount,
  type DaybreakLookupCredentials,
  lookupCodexDaybreakEntitlement,
} from "./daybreak-entitlement.ts";

export {
  configureCodexDaybreakEntitlementForTest,
  invalidateCodexDaybreakEntitlement,
} from "./daybreak-entitlement.ts";

import { lookupCodexDaybreakModelSupport } from "./daybreak-model-support.ts";

export type CodexAccessPrograms = { cyber: "daybreak_blue" | "daybreak_red" };

/** Opaque per-request ownership token; only tickets minted here can enable the wire field. */
export type CodexDaybreakTicket = Readonly<{ sessionId: string }>;

export type CodexDaybreakCredentials = Readonly<{
  apiKey: string | undefined;
  headers?: Readonly<Record<string, string | null>> | undefined;
  modelHeaders?: Readonly<Record<string, string>> | undefined;
}>;

type DaybreakModel = Partial<CodexLikeModelDescriptor>;

type TicketRecord = {
  readonly controller: DaybreakController | undefined;
  readonly state: DaybreakState | undefined;
  readonly sessionId: string;
  readonly model: Readonly<DaybreakModel>;
  readonly credentials: DaybreakLookupCredentials | undefined;
  readonly turnedOn: boolean;
  resolution?: Promise<CodexDaybreakDecision>;
};

type DecisionOwner = Readonly<{ controller: DaybreakController | undefined }>;
type Observation = Readonly<{ requested: boolean; revision: number }>;
type BridgeHost = typeof globalThis & { [DAYBREAK_BRIDGE_SYMBOL]?: DaybreakBridge };

const SourceSchema = Type.Union([
  Type.Literal("default"),
  Type.Literal("explicit"),
  Type.Literal("inherited"),
]);
const OutcomeSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("blue"),
  Type.Literal("red"),
  Type.Literal("not-granted"),
  Type.Literal("lookup-failed"),
  Type.Literal("model-not-supported"),
  Type.Literal("auth-not-eligible"),
]);
const StateSchema = Type.Object({
  sessionId: Type.String(),
  requested: Type.Boolean(),
  source: SourceSchema,
  revision: Type.Integer({ minimum: 0 }),
  generation: Type.Integer({ minimum: 0 }),
  outcome: OutcomeSchema,
});
const BridgeSchema = Type.Object({
  version: Type.Literal(1),
  register: Type.Function([], Type.Unknown()),
  get: Type.Function([Type.String()], Type.Unknown()),
  createExtension: Type.Function([], Type.Unknown()),
});
const ControllerSchema = Type.Object({
  getState: Type.Function([], StateSchema),
  set: Type.Function([], StateSchema),
  report: Type.Function([], Type.Undefined()),
  dispose: Type.Function([], Type.Undefined()),
});

const tickets = new WeakMap<CodexDaybreakTicket, TicketRecord>();
const genuineDecisions = new WeakMap<CodexDaybreakDecision, DecisionOwner>();
const observations = new WeakMap<DaybreakController, Observation>();

function validatedBridge(): DaybreakBridge | undefined {
  const host: BridgeHost = globalThis;
  const candidate = host[DAYBREAK_BRIDGE_SYMBOL];
  return Check(BridgeSchema, candidate) ? candidate : undefined;
}

function currentController(sessionId: string): DaybreakController | undefined {
  if (!sessionId) return undefined;
  const controller = validatedBridge()?.get(sessionId);
  return controller && Check(ControllerSchema, controller) ? controller : undefined;
}

function controllerState(
  controller: DaybreakController | undefined,
  sessionId: string,
): DaybreakState | undefined {
  if (!controller) return undefined;
  const state = controller.getState();
  return Check(StateSchema, state) && state.sessionId === sessionId ? state : undefined;
}

function cyberFor(outcome: DaybreakOutcome): CodexDaybreakDecision["cyber"] {
  if (outcome === "blue") return "daybreak_blue";
  if (outcome === "red") return "daybreak_red";
  return undefined;
}

function decisionFrom(
  sessionId: string,
  state: DaybreakState | undefined,
  outcome: DaybreakOutcome,
): CodexDaybreakDecision {
  return Object.freeze({
    sessionId,
    requested: state?.requested ?? false,
    source: state?.source ?? "default",
    revision: state?.revision ?? 0,
    generation: state?.generation ?? 0,
    outcome,
    cyber: cyberFor(outcome),
  });
}

/** True only for Codex subscription transport on the canonical ChatGPT backend. */
export function isDaybreakEligibleModel(model: DaybreakModel | null | undefined): boolean {
  return isCanonicalCodexSubscriptionModel(model);
}

/**
 * Synchronous status snapshot. Carries the controller's latest reported outcome; with a model,
 * a requested-on state on an ineligible model reports `auth-not-eligible`. Never enables the wire.
 */
export function snapshotCodexDaybreakDecision(
  sessionId: string | undefined,
  model?: DaybreakModel | null,
): CodexDaybreakDecision {
  const id = sessionId ?? "";
  const state = controllerState(currentController(id), id);
  if (!state?.requested) return decisionFrom(id, state, "off");
  if (model !== undefined && !isDaybreakEligibleModel(model))
    return decisionFrom(id, state, "auth-not-eligible");
  return decisionFrom(id, state, state.outcome === "off" ? "lookup-failed" : state.outcome);
}

function frozenModel(model: DaybreakModel): Readonly<DaybreakModel> {
  const copy: DaybreakModel = {};
  if (model.provider !== undefined) copy.provider = model.provider;
  if (model.api !== undefined) copy.api = model.api;
  if (model.id !== undefined) copy.id = model.id;
  if (model.baseUrl !== undefined) copy.baseUrl = model.baseUrl;
  return Object.freeze(copy);
}

function frozenCredentials(
  credentials: CodexDaybreakCredentials | undefined,
): DaybreakLookupCredentials | undefined {
  const apiKey = credentials?.apiKey;
  if (!apiKey) return undefined;
  return Object.freeze({
    apiKey,
    headers: copyDaybreakHeaders(credentials.headers),
    modelHeaders: copyDaybreakHeaders(credentials.modelHeaders),
  });
}

/**
 * A completed entitlement entry is stale after a set-on transition: requested went false->true,
 * or the revision moved while on (an off->on cycle between requests). The first observation of
 * a controller is not a transition, so a new same-account session reuses the shared cache.
 */
function observeToggleOn(controller: DaybreakController, state: DaybreakState): boolean {
  const previous = observations.get(controller);
  observations.set(
    controller,
    Object.freeze({ requested: state.requested, revision: state.revision }),
  );
  if (!previous || !state.requested) return false;
  return !previous.requested || previous.revision !== state.revision;
}

/** Freezes the session's Daybreak owner, state, and credentials before any asynchronous work. */
export function beginCodexDaybreakRequest(input: {
  sessionId: string | undefined;
  model: DaybreakModel;
  credentials?: CodexDaybreakCredentials | undefined;
}): CodexDaybreakTicket {
  const sessionId = input.sessionId ?? "";
  const controller = currentController(sessionId);
  const observedState = controllerState(controller, sessionId);
  const state = observedState ? Object.freeze({ ...observedState }) : undefined;
  const turnedOn = controller && state ? observeToggleOn(controller, state) : false;
  const ticket: CodexDaybreakTicket = Object.freeze({ sessionId });
  tickets.set(ticket, {
    controller,
    state,
    sessionId,
    model: frozenModel(input.model),
    credentials: frozenCredentials(input.credentials),
    turnedOn,
  });
  return ticket;
}

function ownerCurrent(controller: DaybreakController | undefined, decision: CodexDaybreakDecision) {
  if (!controller) return false;
  if (currentController(decision.sessionId) !== controller) return false;
  return controllerState(controller, decision.sessionId)?.generation === decision.generation;
}

/** Identity, generation, and revision all still match the frozen decision. */
export function isCurrentCodexDaybreakDecision(decision: CodexDaybreakDecision): boolean {
  const owner = genuineDecisions.get(decision);
  if (!owner) return false;
  if (!owner.controller) return !decision.requested;
  if (!ownerCurrent(owner.controller, decision)) return false;
  return controllerState(owner.controller, decision.sessionId)?.revision === decision.revision;
}

function publish(owner: DecisionOwner, decision: CodexDaybreakDecision): CodexDaybreakDecision {
  genuineDecisions.set(decision, owner);
  if (owner.controller && isCurrentCodexDaybreakDecision(decision)) {
    owner.controller.report(decision.outcome, decision.revision);
  }
  return decision;
}

async function resolveTicket(record: TicketRecord): Promise<CodexDaybreakDecision> {
  const owner: DecisionOwner = { controller: record.controller };
  const { state, sessionId, credentials } = record;
  // Off never performs a lookup.
  if (!record.controller || !state?.requested)
    return publish(owner, decisionFrom(sessionId, state, "off"));
  const account =
    credentials && isDaybreakEligibleModel(record.model)
      ? daybreakAccount(credentials.apiKey, record.model.baseUrl)
      : undefined;
  if (!credentials || !account)
    return publish(owner, decisionFrom(sessionId, state, "auth-not-eligible"));
  const modelId = record.model.id ?? "";
  const result = await lookupCodexDaybreakEntitlement(account, credentials, record.turnedOn);
  if (result.entitlement !== "blue" && result.entitlement !== "red")
    return publish(owner, decisionFrom(sessionId, state, result.entitlement));
  const granted = decisionFrom(sessionId, state, result.entitlement);
  if (!ownerCurrent(owner.controller, granted)) return publish(owner, granted);
  const support = await lookupCodexDaybreakModelSupport(
    account,
    credentials,
    modelId,
    result.entitlement === "blue" ? "daybreak_blue" : "daybreak_red",
  );
  const outcome =
    support === "supported"
      ? result.entitlement
      : support === "unsupported"
        ? "model-not-supported"
        : "lookup-failed";
  return publish(owner, decisionFrom(sessionId, state, outcome));
}

/**
 * Resolves a ticket's effective Daybreak result once; retries reuse the same frozen result.
 * Forged or missing tickets resolve to `undefined` so finalizers omit the field.
 */
export function resolveCodexDaybreakTicket(
  ticket: CodexDaybreakTicket | undefined,
): Promise<CodexDaybreakDecision | undefined> {
  const record = ticket ? tickets.get(ticket) : undefined;
  if (!record) return Promise.resolve(undefined);
  record.resolution ??= resolveTicket(record);
  return record.resolution;
}

type AccessProgramsCarrier = { access_programs?: unknown };

export function withoutCodexAccessPrograms<Body extends AccessProgramsCarrier>(body: Body): Body {
  if (!Object.hasOwn(body, "access_programs")) return body;
  const copy = { ...body };
  delete copy.access_programs;
  return copy;
}

/**
 * Final wire authority: always removes any inbound `access_programs`, then writes the frozen
 * Daybreak program only for a genuine decision whose owner identity and generation are current.
 */
export function applyCodexDaybreakAccessPrograms<Body extends AccessProgramsCarrier>(
  body: Body,
  decision: CodexDaybreakDecision | undefined,
): Body {
  const stripped = withoutCodexAccessPrograms(body);
  if (!decision?.cyber) return stripped;
  const owner = genuineDecisions.get(decision);
  if (!owner || !ownerCurrent(owner.controller, decision)) return stripped;
  const accessPrograms: CodexAccessPrograms = { cyber: decision.cyber };
  return { ...stripped, access_programs: accessPrograms };
}
