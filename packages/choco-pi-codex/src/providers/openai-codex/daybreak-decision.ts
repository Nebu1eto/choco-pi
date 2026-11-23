import { isJsonObject } from "@choco-pi/code-mode/runtime-values";
import { isBoolean, isFunction, isRevision, isString } from "@choco-pi/code-mode/value-guards";
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
  invalidateCodexDaybreakAccount,
  lookupCodexDaybreakEntitlement,
} from "./daybreak-entitlement.ts";

export {
  configureCodexDaybreakEntitlementForTest,
  invalidateCodexDaybreakEntitlement,
} from "./daybreak-entitlement.ts";

import {
  lookupCodexDaybreakModelSupport,
  type DaybreakTargetProgram,
} from "./daybreak-model-support.ts";
import {
  isOpenAIPlatformModel,
  OPENAI_SIGN_IN_DAYBREAK_REASON,
} from "../../adapter/openai-sign-in.ts";

export type CodexAccessPrograms = { cyber: "daybreak_blue" | "daybreak_red" };

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
  readonly isCurrent: (() => boolean) | undefined;
  resolution?: Promise<CodexDaybreakDecision>;
};

type DecisionOwner = Readonly<{
  controller: DaybreakController | undefined;
  isCurrent?: (() => boolean) | undefined;
}>;
type Observation = Readonly<{ requested: DaybreakState["requested"]; revision: number }>;
type BridgeHost = typeof globalThis & { [DAYBREAK_BRIDGE_SYMBOL]?: DaybreakBridge };

const SOURCES: ReadonlySet<unknown> = new Set<DaybreakState["source"]>([
  "default",
  "explicit",
  "inherited",
]);
const OUTCOMES: ReadonlySet<unknown> = new Set<DaybreakOutcome>([
  "off",
  "pending",
  "blue",
  "red",
  "not-granted",
  "lookup-failed",
  "model-not-supported",
  "auth-not-eligible",
  "security-key-required",
]);

function isDaybreakState<Value>(value: Value): value is Value & DaybreakState {
  return (
    isJsonObject(value) &&
    isString(value["sessionId"]) &&
    (isBoolean(value["requested"]) || value["requested"] === "auto") &&
    SOURCES.has(value["source"]) &&
    isRevision(value["revision"]) &&
    isRevision(value["generation"]) &&
    OUTCOMES.has(value["outcome"])
  );
}

function isDaybreakBridge<Value>(value: Value): value is Value & DaybreakBridge {
  return (
    isJsonObject(value) &&
    value["version"] === 1 &&
    isFunction(value["register"]) &&
    isFunction(value["get"]) &&
    isFunction(value["createExtension"])
  );
}

function isDaybreakController<Value>(value: Value): value is Value & DaybreakController {
  return (
    isJsonObject(value) &&
    isFunction(value["getState"]) &&
    isFunction(value["subscribe"]) &&
    isFunction(value["set"]) &&
    isFunction(value["report"]) &&
    isFunction(value["dispose"])
  );
}

const tickets = new WeakMap<CodexDaybreakTicket, TicketRecord>();
const genuineDecisions = new WeakMap<CodexDaybreakDecision, DecisionOwner>();
const observations = new WeakMap<DaybreakController, Observation>();

function validatedBridge(): DaybreakBridge | undefined {
  const host: BridgeHost = globalThis;
  const candidate = host[DAYBREAK_BRIDGE_SYMBOL];
  return isDaybreakBridge(candidate) ? candidate : undefined;
}

function currentController(sessionId: string): DaybreakController | undefined {
  if (!sessionId) return undefined;
  const controller = validatedBridge()?.get(sessionId);
  return controller && isDaybreakController(controller) ? controller : undefined;
}

export function getCodexDaybreakController(sessionId: string): DaybreakController | undefined {
  return currentController(sessionId);
}

function controllerState(
  controller: DaybreakController | undefined,
  sessionId: string,
): DaybreakState | undefined {
  if (!controller) return undefined;
  const state = controller.getState();
  return isDaybreakState(state) && state.sessionId === sessionId ? state : undefined;
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

export function isDaybreakEligibleModel(model: DaybreakModel | null | undefined): boolean {
  return isCanonicalCodexSubscriptionModel(model);
}

export function snapshotCodexDaybreakDecision(
  sessionId: string | undefined,
  model?: DaybreakModel | null,
  signIn = false,
): CodexDaybreakDecision {
  const id = sessionId ?? "";
  const state = controllerState(currentController(id), id);
  if (!state?.requested) return decisionFrom(id, state, "off");
  if (signIn && isOpenAIPlatformModel(model))
    return Object.freeze({
      ...decisionFrom(id, state, "auth-not-eligible"),
      reason: OPENAI_SIGN_IN_DAYBREAK_REASON,
    });
  if (model !== undefined && !isDaybreakEligibleModel(model))
    return decisionFrom(id, state, "auth-not-eligible");
  return decisionFrom(id, state, state.outcome === "off" ? "pending" : state.outcome);
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

function observeToggleOn(controller: DaybreakController, state: DaybreakState): boolean {
  const previous = observations.get(controller);
  observations.set(
    controller,
    Object.freeze({ requested: state.requested, revision: state.revision }),
  );
  if (!previous || !state.requested) return false;
  return !previous.requested || previous.revision !== state.revision;
}

export function beginCodexDaybreakRequest(input: {
  sessionId: string | undefined;
  model: DaybreakModel;
  credentials?: CodexDaybreakCredentials | undefined;
  isCurrent?: (() => boolean) | undefined;
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
    isCurrent: input.isCurrent,
  });
  return ticket;
}

function ownerCurrent(controller: DaybreakController | undefined, decision: CodexDaybreakDecision) {
  if (!controller) return false;
  if (currentController(decision.sessionId) !== controller) return false;
  return controllerState(controller, decision.sessionId)?.generation === decision.generation;
}

export function isCurrentCodexDaybreakDecision(decision: CodexDaybreakDecision): boolean {
  const owner = genuineDecisions.get(decision);
  if (!owner || owner.isCurrent?.() === false) return false;
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
  const { state, sessionId, credentials } = record;
  const account =
    credentials && isDaybreakEligibleModel(record.model)
      ? daybreakAccount(credentials.apiKey, record.model.baseUrl)
      : undefined;
  const owner: DecisionOwner = { controller: record.controller, isCurrent: record.isCurrent };
  if (!record.controller || !state?.requested)
    return publish(owner, decisionFrom(sessionId, state, "off"));
  if (!credentials || !account)
    return publish(owner, decisionFrom(sessionId, state, "auth-not-eligible"));
  const modelId = record.model.id ?? "";
  if (record.turnedOn) invalidateCodexDaybreakAccount(account);
  const availability = await lookupCodexDaybreakModelSupport(account, credentials, modelId, "any");
  if (availability !== "supported")
    return publish(
      owner,
      decisionFrom(
        sessionId,
        state,
        availability === "unsupported" ? "model-not-supported" : "lookup-failed",
      ),
    );
  const checked = decisionFrom(sessionId, state, "off");
  if (record.isCurrent?.() === false || !ownerCurrent(owner.controller, checked))
    return publish(owner, checked);
  const result = await lookupCodexDaybreakEntitlement(account, credentials, record.turnedOn);
  if (result.entitlement === "security-key-required")
    return publish(owner, decisionFrom(sessionId, state, "security-key-required"));
  const preferred: DaybreakTargetProgram =
    result.entitlement === "red" ? "daybreak_red" : "daybreak_blue";
  const current = decisionFrom(sessionId, state, "off");
  if (record.isCurrent?.() === false || !ownerCurrent(owner.controller, current))
    return publish(owner, current);
  let program: DaybreakTargetProgram | undefined;
  const candidates: readonly DaybreakTargetProgram[] =
    preferred === "daybreak_red" ? ["daybreak_red", "daybreak_blue"] : ["daybreak_blue"];
  for (const candidate of candidates) {
    const support = await lookupCodexDaybreakModelSupport(account, credentials, modelId, candidate);
    if (support !== "supported") continue;
    program = candidate;
    break;
  }
  let outcome: DaybreakOutcome = "model-not-supported";
  if (program === "daybreak_red") outcome = "red";
  else if (program === "daybreak_blue") outcome = "blue";
  return publish(owner, decisionFrom(sessionId, state, outcome));
}

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
