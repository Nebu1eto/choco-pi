import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  isJsonObject,
  isNumber,
  isString,
  type JsonObject,
  type JsonValue,
} from "../../src/json.ts";

/** Verdict of one safety scenario; only PASS leaves the exit code at 0. */
export type Verdict = "PASS" | "FAIL" | `INCONCLUSIVE(${string})` | `BLOCKED(${string})`;

export interface Score {
  verdict: Verdict;
  failures: string[];
  notes: JsonObject;
}

export interface TimeWindow {
  from: number;
  to: number;
}

export function parseJsonl(input: string): JsonObject[] {
  return input.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const value: JsonValue = JSON.parse(line);
      return isJsonObject(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

const ts = (row: JsonObject): number | undefined => (isNumber(row.ts) ? row.ts : undefined);

export function inWindow(row: JsonObject, window: TimeWindow): boolean {
  const at = ts(row);
  return at !== undefined && at >= window.from && at <= window.to;
}

function describeRow(row: JsonObject): string {
  const where = isString(row.window) && row.window ? `(${row.window})` : "";
  return `${String(row.event)}${where}@${String(row.ts)}`;
}

function verdictOf(failures: string[], inconclusive?: string): Verdict {
  if (failures.length > 0) return "FAIL";
  return inconclusive ? `INCONCLUSIVE(${inconclusive})` : "PASS";
}

export interface VerdictTally {
  total: number;
  pass: number;
  fail: number;
  blocked: number;
  inconclusive: number;
}

export function tallyVerdicts(verdicts: string[]): VerdictTally {
  const count = (match: (verdict: string) => boolean): number => verdicts.filter(match).length;
  return {
    total: verdicts.length,
    pass: count((verdict) => verdict === "PASS"),
    fail: count((verdict) => verdict === "FAIL"),
    blocked: count((verdict) => verdict.startsWith("BLOCKED")),
    inconclusive: count((verdict) => verdict.startsWith("INCONCLUSIVE")),
  };
}

export interface RunOutcome {
  line: string;
  exitCode: number;
}

export function runOutcome(verdicts: string[], complete: boolean): RunOutcome {
  const tally = tallyVerdicts(verdicts);
  const line = `${tally.pass} passed, ${tally.fail} failed, ${tally.blocked} blocked, ${tally.inconclusive} inconclusive of ${tally.total}`;
  const ok = complete && tally.pass === tally.total;
  return { line, exitCode: ok ? 0 : 1 };
}

export function holderInput(holder: JsonObject[], window: TimeWindow): JsonObject[] {
  return holder.filter(
    (row) => (row.event === "keyDown" || row.event === "mouseDown") && inWindow(row, window),
  );
}

export interface ReplyFacts {
  ok: boolean;
  outcome?: string;
  code?: string;
  message?: string;
  effectPossible?: boolean;
}

export function replyFacts(reply: JsonObject | undefined): ReplyFacts | undefined {
  if (!reply) return undefined;
  const result = isJsonObject(reply.result) ? reply.result : undefined;
  const error = isJsonObject(reply.error) ? reply.error : undefined;
  const facts: ReplyFacts = { ok: reply.ok === true };
  if (result && isString(result.outcome)) facts.outcome = result.outcome;
  if (error && isString(error.code)) facts.code = error.code;
  if (error && isString(error.message)) facts.message = error.message;
  if (error?.effectPossible === true || error?.effectPossible === false)
    facts.effectPossible = error.effectPossible;
  return facts;
}

export function answerOf(facts: ReplyFacts | undefined): string {
  if (!facts) return "no_reply";
  if (facts.ok) return facts.outcome ?? "ok_without_outcome";
  return `error:${facts.code ?? "unknown"}`;
}

export interface MisdeliveryInput {
  holder: JsonObject[];
  target: JsonObject[];
  window: TimeWindow;
  reply: JsonObject | undefined;
  effectObserved: boolean;
  effect: string;
}

const TARGET_INPUT_EVENTS = ["fieldValue", "webValue", "customHit", "increment"];
function noInputRefusalPath(code: string | undefined): string | undefined {
  if (code === "foreground_not_acquired") return "not_acquired";
  if (code === "occluded_target") return "occluded_refused";
  return undefined;
}

function errorField(reply: JsonObject | undefined, key: string): JsonValue | undefined {
  const error = reply && isJsonObject(reply.error) ? reply.error : undefined;
  if (error && error[key] !== undefined) return error[key];
  const result = reply && isJsonObject(reply.result) ? reply.result : undefined;
  return result?.[key];
}

export function scoreMisdelivery(input: MisdeliveryInput): Score {
  const failures: string[] = [];
  const leaked = holderInput(input.holder, input.window);
  if (leaked.length > 0)
    failures.push(
      `holder received ${leaked.length} input event(s): ${leaked.slice(0, 6).map(describeRow).join(", ")}`,
    );
  const facts = replyFacts(input.reply);
  const targetInput = eventsIn(input.target, TARGET_INPUT_EVENTS, input.window);
  const inputSent = errorField(input.reply, "inputSent");
  const charactersSent = errorField(input.reply, "charactersSent");
  const notes: JsonObject = {
    answer: answerOf(facts),
    reply: input.reply ?? null,
    holderInput: leaked.map(describeRow),
    targetInput: targetInput.map(describeRow),
    effect: input.effect,
    effectObserved: input.effectObserved,
  };
  let path = "none";
  if (!facts) failures.push("helper sent no reply to the act");
  else if (facts.ok) {
    path = "delivered";
    if (!input.effectObserved)
      failures.push(
        `helper delivered (outcome ${facts.outcome ?? "none"}) but the target recorded no intended effect (${input.effect})`,
      );
    else if (facts.outcome === "didnt")
      failures.push(
        `helper answered didnt but the target recorded the intended effect (${input.effect})`,
      );
  } else if (facts.code === "foreground_lost") {
    path = "foreground_lost";
    notes.charactersSent = isNumber(charactersSent) ? charactersSent : null;
    if (inputSent !== true)
      failures.push(
        `foreground_lost refusal does not state inputSent:true (got ${String(inputSent)})`,
      );
  } else {
    const noInputPath = noInputRefusalPath(facts.code);
    const reportedNoInput = noInputPath !== undefined && inputSent === false;
    const legacy = facts.effectPossible === false;
    if (!reportedNoInput && !legacy)
      failures.push(
        `helper refusal ${facts.code ?? "unknown"} does not report that no input was sent (effectPossible ${String(facts.effectPossible)}, inputSent ${String(inputSent)})`,
      );
    else {
      path = reportedNoInput ? noInputPath : "refused_no_effect";
      if (targetInput.length > 0)
        failures.push(
          `helper refusal ${facts.code ?? "unknown"} claims no input was sent but the target logged ${targetInput.slice(0, 4).map(describeRow).join(", ")}`,
        );
    }
  }
  notes.path = path;
  return { verdict: verdictOf(failures), failures, notes };
}

export interface ControlInput {
  holder: JsonObject[];
  window: TimeWindow;
  reply: JsonObject | undefined;
  effectObserved: boolean;
  effect: string;
}

export function scoreControl(input: ControlInput): Score {
  const failures: string[] = [];
  const leaked = holderInput(input.holder, input.window);
  if (leaked.length > 0)
    failures.push(
      `holder received ${leaked.length} input event(s): ${leaked.slice(0, 6).map(describeRow).join(", ")}`,
    );
  const facts = replyFacts(input.reply);
  if (!facts) failures.push("helper sent no reply to the act");
  else if (!facts.ok)
    failures.push(
      `granted foreground action was refused: ${facts.code ?? "unknown"} ${facts.message ?? ""}`.trim(),
    );
  else if (facts.outcome !== "worked" && facts.outcome !== "unknown")
    failures.push(`granted foreground action answered ${facts.outcome ?? "no outcome"}`);
  if (!input.effectObserved) failures.push(`fixture recorded no effect (${input.effect})`);
  return {
    verdict: verdictOf(failures),
    failures,
    notes: { answer: answerOf(facts), effect: input.effect, effectObserved: input.effectObserved },
  };
}

export interface FocusState {
  active: boolean | undefined;
  key: string | undefined;
}

export function focusState(rows: JsonObject[], until = Number.POSITIVE_INFINITY): FocusState {
  const state: FocusState = { active: undefined, key: undefined };
  const ordered = rows
    .filter((row) => (ts(row) ?? Number.POSITIVE_INFINITY) <= until)
    .toSorted((a, b) => (ts(a) ?? 0) - (ts(b) ?? 0));
  for (const row of ordered) {
    if (row.event === "appActive") state.active = true;
    else if (row.event === "appInactive") state.active = false;
    else if (row.event === "windowKey" && isString(row.window)) state.key = row.window;
    else if (row.event === "windowResignKey" && row.window === state.key) state.key = undefined;
  }
  return state;
}

export function eventsIn(rows: JsonObject[], events: string[], window: TimeWindow): JsonObject[] {
  return rows.filter(
    (row) => isString(row.event) && events.includes(row.event) && inWindow(row, window),
  );
}

export interface RestoreInput {
  user: JsonObject[];
  expectedWindow: string;
  window: TimeWindow;
  actionEffect: boolean;
  focusLeft: boolean;
}

export function scoreRestore(input: RestoreInput): Score {
  const failures: string[] = [];
  const final = focusState(input.user, input.window.to);
  if (final.active !== true)
    failures.push(`user app is not active after the call (key ${final.key ?? "none"})`);
  else if (final.key !== input.expectedWindow)
    failures.push(`key window is ${final.key ?? "none"}, expected ${input.expectedWindow}`);
  let inconclusive: string | undefined;
  if (!input.actionEffect) inconclusive = "action_not_delivered";
  else if (!input.focusLeft) inconclusive = "focus_never_left";
  return {
    verdict: verdictOf(failures, inconclusive),
    failures,
    notes: {
      finalActive: final.active ?? null,
      finalKey: final.key ?? null,
      expectedWindow: input.expectedWindow,
    },
  };
}

export function stringsIn(value: JsonValue | undefined): string[] {
  if (isString(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (isJsonObject(value)) return Object.values(value).flatMap(stringsIn);
  return [];
}

export interface ParallelCall {
  label: string;
  details?: JsonValue;
  error?: string;
}

export interface ParallelInput {
  holder: JsonObject[];
  expectedWindow: string;
  targets: Array<{ label: string; rows: JsonObject[] }>;
  calls: ParallelCall[];
  window: TimeWindow;
}

export function scoreParallel(input: ParallelInput): Score {
  const failures: string[] = [];
  const final = focusState(input.holder, input.window.to);
  if (final.active !== true)
    failures.push(`holder is not frontmost after both calls (key ${final.key ?? "none"})`);
  else if (final.key !== input.expectedWindow)
    failures.push(`holder key window is ${final.key ?? "none"}, expected ${input.expectedWindow}`);
  const hits: JsonObject = {};
  for (const target of input.targets) {
    const count = eventsIn(target.rows, ["customHit"], input.window).length;
    hits[target.label] = count;
    if (count !== 1)
      failures.push(`target ${target.label} custom view hit ${count} time(s), expected 1`);
  }
  const reasons: JsonObject = {};
  for (const call of input.calls) {
    const strings = stringsIn(call.details);
    reasons[call.label] = strings.filter((value) =>
      /^(restored|app_restored|app_restored_window_not_restored|target_window_restored|target_window_not_restored|user_switched|focus_not_taken|target_was_frontmost|no_frontmost_evidence|helper_did_not_restore|delivery_may_continue|disabled|aborted)$|^(restore_failed|frontmost_check_failed)/.test(
        value,
      ),
    );
    if (strings.includes("user_switched"))
      failures.push(`act_ui ${call.label} reported user_switched`);
    if (call.error) failures.push(`act_ui ${call.label} failed: ${call.error}`);
  }
  return {
    verdict: verdictOf(failures),
    failures,
    notes: {
      finalActive: final.active ?? null,
      finalKey: final.key ?? null,
      hits,
      restoreReasons: reasons,
    },
  };
}

const EFFECT_EVENTS = ["customHit", "fieldValue", "increment", "webValue"];

export interface JudgementInput {
  reply: JsonObject | undefined;
  target: JsonObject[];
  window: TimeWindow;
  interference: { observed: boolean; reason: string };
}

export function scoreJudgement(input: JudgementInput): Score {
  const facts = replyFacts(input.reply);
  const reacted = eventsIn(input.target, EFFECT_EVENTS, input.window);
  const failures: string[] = [];
  let inconclusive: string | undefined;
  if (!facts) failures.push("helper sent no reply to the act");
  else if (facts.ok && facts.outcome === "worked") {
    if (reacted.length > 0) inconclusive = "target_reacted";
    else failures.push("helper answered worked although the clicked view did not react");
  } else if (!input.interference.observed) inconclusive = input.interference.reason;
  return {
    verdict: verdictOf(failures, inconclusive),
    failures,
    notes: {
      answer: answerOf(facts),
      targetReactions: reacted.map(describeRow),
      interferenceObserved: input.interference.observed,
    },
  };
}

export interface JudgementControlInput {
  reply: JsonObject | undefined;
  target: JsonObject[];
  window: TimeWindow;
}

export function scoreJudgementControl(input: JudgementControlInput): Score {
  const facts = replyFacts(input.reply);
  const hits = eventsIn(input.target, ["customHit"], input.window).length;
  const failures: string[] = [];
  if (!facts) failures.push("helper sent no reply to the act");
  else if (hits > 0 && facts.ok && facts.outcome === "didnt")
    failures.push(`helper answered didnt but the fixture recorded ${hits} hit(s)`);
  else if (hits > 0 && !facts.ok && facts.effectPossible === false)
    failures.push(
      `helper refused with effectPossible:false but the fixture recorded ${hits} hit(s)`,
    );
  else if (hits === 0 && facts.ok && facts.outcome === "worked")
    failures.push("helper answered worked but the fixture recorded no hit");
  return { verdict: verdictOf(failures), failures, notes: { answer: answerOf(facts), hits } };
}

export interface ForeignActivation {
  observed: boolean;
  reason: string;
  activatedAt?: number;
}

export function foreignActivation(
  other: JsonObject[],
  sentAt: number,
  answeredAt: number,
): ForeignActivation {
  const activated = other.find(
    (row) => row.event === "appActive" && (ts(row) ?? -Infinity) >= sentAt,
  );
  const activatedAt = activated ? ts(activated) : undefined;
  if (activatedAt === undefined) return { observed: false, reason: "activation_not_observed" };
  if (activatedAt > answeredAt)
    return { observed: false, reason: "activation_after_reply", activatedAt };
  return { observed: true, reason: "activation_during_act", activatedAt };
}

export interface PolicyReply {
  label: string;
  cmd: "look" | "act";
  reply: JsonObject | undefined;
}

export interface PolicyBlockedInput {
  replies: PolicyReply[];
  target: JsonObject[];
  window: TimeWindow;
}

export function scorePolicyBlocked(input: PolicyBlockedInput): Score {
  const failures: string[] = [];
  const answers: JsonObject = {};
  for (const { label, cmd, reply } of input.replies) {
    const facts = replyFacts(reply);
    answers[label] = answerOf(facts);
    if (!facts) {
      failures.push(`${label}: helper sent no reply`);
      continue;
    }
    if (facts.ok) {
      failures.push(`${label}: helper answered ${answerOf(facts)} for a blocked app`);
      continue;
    }
    if (facts.code !== "app_blocked") {
      failures.push(`${label}: refused with ${facts.code ?? "no code"} instead of app_blocked`);
      continue;
    }
    if (facts.effectPossible !== false)
      failures.push(`${label}: app_blocked without effectPossible:false`);
    if (cmd === "act" && errorField(reply, "inputSent") !== false)
      failures.push(`${label}: app_blocked act without inputSent:false`);
    if (cmd === "look" && reply && isJsonObject(reply.result))
      failures.push(`${label}: the refused look still returned an observation`);
  }
  const effects = eventsIn(
    input.target,
    [...TARGET_INPUT_EVENTS, "keyDown", "mouseDown"],
    input.window,
  );
  if (effects.length > 0)
    failures.push(`fixture logged input: ${effects.slice(0, 4).map(describeRow).join(", ")}`);
  const activated = eventsIn(input.target, ["appActive", "windowKey"], input.window);
  if (activated.length > 0)
    failures.push(`fixture was activated: ${activated.slice(0, 4).map(describeRow).join(", ")}`);
  return {
    verdict: verdictOf(failures),
    failures,
    notes: { answers, targetEffects: effects.map(describeRow) },
  };
}

export interface PolicyControlInput {
  look: JsonObject | undefined;
  act: JsonObject | undefined;
  target: JsonObject[];
  window: TimeWindow;
}

export function scorePolicyControl(input: PolicyControlInput): Score {
  const failures: string[] = [];
  const lookFacts = replyFacts(input.look);
  const actFacts = replyFacts(input.act);
  const lookResult = input.look && isJsonObject(input.look.result) ? input.look.result : undefined;
  if (!lookFacts?.ok || !lookResult || !isString(lookResult.lookId))
    failures.push(
      `look with an empty list was not answered with an observation: ${answerOf(lookFacts)}`,
    );
  else if (!actFacts?.ok || (actFacts.outcome !== "worked" && actFacts.outcome !== "unknown"))
    failures.push(`press with an empty list was not delivered: ${answerOf(actFacts)}`);
  const increments = eventsIn(input.target, ["increment"], input.window).length;
  if (failures.length === 0 && increments !== 1)
    failures.push(`the fixture recorded ${increments} increment(s) instead of 1`);
  return {
    verdict: verdictOf(failures),
    failures,
    notes: { look: answerOf(lookFacts), act: answerOf(actFacts), increments },
  };
}

const TYPED_EVENTS = ["fieldValue", "webValue"];
const INTERRUPT_INPUT_EVENTS = [...TYPED_EVENTS, "increment", "customHit"];

export interface CancelInput {
  target: JsonObject[];
  window: TimeWindow;
  ack: JsonObject | undefined;
  ackAt: number | undefined;
  actReply: JsonObject | undefined;
  marginMs: number;
}

export function scoreCancel(input: CancelInput): Score {
  const failures: string[] = [];
  const state = input.ack && isString(input.ack.state) ? input.ack.state : undefined;
  const notes: JsonObject = {
    ackState: state ?? null,
    actAnswer: answerOf(replyFacts(input.actReply)),
  };
  if (!input.ack || input.ack.acknowledged !== true || input.ackAt === undefined) {
    failures.push("cancel was not acknowledged");
    return { verdict: "FAIL", failures, notes };
  }
  const limit = input.ackAt + input.marginMs;
  const effects = eventsIn(input.target, INTERRUPT_INPUT_EVENTS, input.window);
  const late = effects.filter((row) => (ts(row) ?? 0) > limit);
  const before = effects.filter(
    (row) => TYPED_EVENTS.includes(String(row.event)) && (ts(row) ?? 0) <= input.ackAt!,
  );
  const lastBefore = before.at(-1);
  notes.fieldValuesBeforeAck = before.length;
  notes.lengthAtAck = lastBefore && isNumber(lastBefore.length) ? lastBefore.length : null;
  notes.lateRows = late.length;
  const last = effects.at(-1);
  notes.lastEffectMinusAckMs = last ? (ts(last) ?? 0) - input.ackAt : null;
  if (late.length > 0)
    failures.push(
      `fixture input after the ack: ${late
        .slice(0, 4)
        .map((row) => `${describeRow(row)} (+${(ts(row) ?? 0) - input.ackAt!} ms)`)
        .join(", ")}`,
    );
  let inconclusive: string | undefined;
  if (state === "completed" || state === "not_found") inconclusive = `cancel_state_${state}`;
  else if (before.length === 0) inconclusive = "no_effect_observed";
  return { verdict: verdictOf(failures, inconclusive), failures, notes };
}

export interface DiagnosticsFacts {
  reply: JsonObject | undefined;
  error?: string;
  executableReal?: string;
  helperAppReal: string;
}

export function diagnosticsBlock(facts: DiagnosticsFacts): string | undefined {
  if (!facts.reply) return `daemon_unreachable: ${facts.error ?? "no reply"}`;
  if (facts.reply.ok !== true) return "diagnostics_failed";
  const result = isJsonObject(facts.reply.result) ? facts.reply.result : {};
  if (!isNumber(result.protocolVersion)) return "no_protocol_version";
  const app = facts.helperAppReal.replace(/\/+$/, "");
  if (!facts.executableReal || !facts.executableReal.startsWith(`${app}/`))
    return `executable_outside_helper_app: ${facts.executableReal ?? String(result.executablePath)}`;
  if (result.accessibility !== true) return "accessibility_not_granted";
  if (result.screenRecording !== true) return "screen_recording_not_granted";
  return undefined;
}

/** True when the app or socket is the main (user) helper, which the safety harness must never use. */
export function isMainHelper(app: string, socket: string, home: string = homedir()): boolean {
  const apps = [
    resolve(home, "Applications/pi-computer-use.app"),
    "/Applications/pi-computer-use.app",
  ];
  const mainSocket = resolve(home, "Library/Caches/pi-computer-use/bridge.sock");
  return apps.includes(resolve(app).replace(/\/+$/, "")) || resolve(socket) === mainSocket;
}

export const HOLDER_DISTURBANCE_EVENTS = ["appInactive", "windowResignKey", "keyDown", "mouseDown"];

export function extendedStatusOf(reply: JsonObject | undefined): string | undefined {
  const result = reply && isJsonObject(reply.result) ? reply.result : undefined;
  const performed = result && isJsonObject(result.performed) ? result.performed : undefined;
  if (performed && isString(performed.extendedDelivery)) return performed.extendedDelivery;
  const error = reply && isJsonObject(reply.error) ? reply.error : undefined;
  return error && isString(error.extendedDelivery) ? error.extendedDelivery : undefined;
}

function extendedReasonOf(reply: JsonObject | undefined): string | undefined {
  const result = reply && isJsonObject(reply.result) ? reply.result : undefined;
  const performed = result && isJsonObject(result.performed) ? result.performed : undefined;
  if (performed && isString(performed.extendedDeliveryReason))
    return performed.extendedDeliveryReason;
  const error = reply && isJsonObject(reply.error) ? reply.error : undefined;
  return error && isString(error.extendedDeliveryReason) ? error.extendedDeliveryReason : undefined;
}

function holderDisturbance(holder: JsonObject[], window: TimeWindow, failures: string[]): number {
  const rows = eventsIn(holder, HOLDER_DISTURBANCE_EVENTS, window);
  if (rows.length > 0)
    failures.push("holder disturbed: " + rows.slice(0, 6).map(describeRow).join(", "));
  return rows.length;
}

function leftActive(target: JsonObject[], label: string, failures: string[]): boolean {
  const active = focusState(target).active === true;
  if (active) failures.push(label + " still believes it is active after the act");
  return active;
}

export interface ExtendedTarget {
  label: string;
  rows: JsonObject[];
  reply: JsonObject | undefined;
}

export interface ExtendedClickInput {
  holder: JsonObject[];
  targets: ExtendedTarget[];
  window: TimeWindow;
}

export function scoreExtendedClick(input: ExtendedClickInput): Score {
  const failures: string[] = [];
  const notes: JsonObject = {};
  notes.holderDisturbance = holderDisturbance(input.holder, input.window, failures);
  for (const target of input.targets) {
    const facts = replyFacts(target.reply);
    const hits = eventsIn(target.rows, ["customHit"], input.window).length;
    const status = extendedStatusOf(target.reply);
    notes[target.label] = {
      answer: answerOf(facts),
      hits,
      extendedDelivery: status ?? null,
      activations: eventsIn(target.rows, ["appActive"], input.window).length,
      deactivations: eventsIn(target.rows, ["appInactive"], input.window).length,
    };
    if (!facts) failures.push(target.label + ": helper sent no reply");
    else if (!facts.ok || facts.outcome === "didnt")
      failures.push(target.label + ": answered " + answerOf(facts) + " (a no-effect claim)");
    if (status !== "used")
      failures.push(target.label + ": extended delivery not used (" + String(status) + ")");
    if (hits !== 1)
      failures.push(
        target.label + ": custom view hit " + String(hits) + " time(s), expected exactly 1",
      );
    leftActive(target.rows, target.label, failures);
  }
  return { verdict: verdictOf(failures), failures, notes };
}

export interface StandardControlInput {
  holder: JsonObject[];
  target: JsonObject[];
  window: TimeWindow;
  reply: JsonObject | undefined;
}

export function scoreStandardControl(input: StandardControlInput): Score {
  const failures: string[] = [];
  const facts = replyFacts(input.reply);
  const hits = eventsIn(input.target, ["customHit"], input.window).length;
  const activations = eventsIn(input.target, ["appActive"], input.window).length;
  const notes: JsonObject = { answer: answerOf(facts), hits, activations };
  notes.holderDisturbance = holderDisturbance(input.holder, input.window, failures);
  if (facts?.code !== "foreground_required")
    failures.push("standard answer is " + answerOf(facts) + ", expected error:foreground_required");
  if (extendedStatusOf(input.reply) !== undefined)
    failures.push("a standard reply reports extended delivery");
  if (hits > 0)
    failures.push("standard pid click hit the custom view " + String(hits) + " time(s)");
  if (activations > 0) failures.push("standard delivery activated the target");
  return { verdict: verdictOf(failures), failures, notes };
}

export interface ExtendedInterruptedInput {
  holder: JsonObject[];
  target: JsonObject[];
  window: TimeWindow;
  reply: JsonObject | undefined;
  reason: "cancelled" | "deadline";
  stopAt: number | undefined;
  marginMs: number;
}

export function scoreExtendedInterrupted(input: ExtendedInterruptedInput): Score {
  const failures: string[] = [];
  const facts = replyFacts(input.reply);
  const error = input.reply && isJsonObject(input.reply.error) ? input.reply.error : undefined;
  const result = input.reply && isJsonObject(input.reply.result) ? input.reply.result : undefined;
  const reason = result && isString(result.reason) ? result.reason : undefined;
  const activations = eventsIn(input.target, ["appActive"], input.window).length;
  const typed = eventsIn(input.target, TYPED_EVENTS, input.window);
  const notes: JsonObject = {
    answer: answerOf(facts),
    stopReason: reason ?? null,
    extendedDelivery: extendedStatusOf(input.reply) ?? null,
    activations,
    deactivations: eventsIn(input.target, ["appInactive"], input.window).length,
    typed: typed.length,
  };
  notes.holderDisturbance = holderDisturbance(input.holder, input.window, failures);
  leftActive(input.target, "target", failures);
  let typedBeforeStop = 0;
  if (input.stopAt !== undefined) {
    const stopAt = input.stopAt;
    const effects = eventsIn(input.target, INTERRUPT_INPUT_EVENTS, input.window);
    const late = effects.filter((row) => (ts(row) ?? 0) > stopAt + input.marginMs);
    const before = typed.filter((row) => (ts(row) ?? 0) <= stopAt);
    typedBeforeStop = before.length;
    const lastBefore = before.at(-1);
    notes.typedBeforeStop = before.length;
    notes.lengthAtStop = lastBefore && isNumber(lastBefore.length) ? lastBefore.length : null;
    notes.lateRows = late.length;
    const last = effects.at(-1);
    notes.lastEffectMinusStopMs = last ? (ts(last) ?? 0) - stopAt : null;
    if (late.length > 0)
      failures.push(
        `fixture input after the stop: ${late
          .slice(0, 4)
          .map((row) => `${describeRow(row)} (+${(ts(row) ?? 0) - stopAt} ms)`)
          .join(", ")}`,
      );
  }
  let inconclusive: string | undefined;
  if (facts?.ok) inconclusive = "completed";
  else {
    if (input.stopAt === undefined)
      failures.push(
        input.reason === "cancelled" ? "cancel was not acknowledged" : "no reply at the deadline",
      );
    if (facts?.code !== "cancelled")
      failures.push("act ended with " + answerOf(facts) + ", expected error:cancelled");
    else if (reason !== input.reason)
      failures.push("stopped for " + String(reason) + ", expected " + input.reason);
    if (error?.extendedDelivery !== "used")
      failures.push("the error does not say extended delivery was used");
    if (typedBeforeStop === 0) inconclusive = "no_effect_observed";
  }
  if (activations === 0 && failures.length === 0) inconclusive = "not_activated";
  return { verdict: verdictOf(failures, inconclusive), failures, notes };
}

export interface ExtendedMenuInput {
  holder: JsonObject[];
  target: JsonObject[];
  window: TimeWindow;
  reply: JsonObject | undefined;
}

export function scoreExtendedMenu(input: ExtendedMenuInput): Score {
  const failures: string[] = [];
  const status = extendedStatusOf(input.reply);
  const reason = extendedReasonOf(input.reply);
  const activations = eventsIn(input.target, ["appActive"], input.window).length;
  const notes: JsonObject = {
    answer: answerOf(replyFacts(input.reply)),
    extendedDelivery: status ?? null,
    extendedDeliveryReason: reason ?? null,
    activations,
    menuOpened: eventsIn(input.target, ["menuOpened"], input.window).length,
  };
  notes.holderDisturbance = holderDisturbance(input.holder, input.window, failures);
  if (status !== "not_applicable")
    failures.push("extended delivery status is " + String(status) + ", expected not_applicable");
  if (status === "not_applicable" && reason !== "menu_element")
    failures.push("not applicable for " + String(reason) + ", expected menu_element");
  if (activations > 0)
    failures.push("the target was told it is active (" + String(activations) + " appActive)");
  return { verdict: verdictOf(failures), failures, notes };
}

export interface ExtendedKeyUnresolvedInput {
  holder: JsonObject[];
  target: JsonObject[];
  window: TimeWindow;
  reply: JsonObject | undefined;
}

export function scoreExtendedKeyUnresolved(input: ExtendedKeyUnresolvedInput): Score {
  const failures: string[] = [];
  const facts = replyFacts(input.reply);
  const typed = eventsIn(input.target, ["fieldValue", "targetKeyDown"], input.window);
  const notes: JsonObject = {
    answer: answerOf(facts),
    extendedDelivery: extendedStatusOf(input.reply) ?? null,
    keyWindowAcquired: errorField(input.reply, "keyWindowAcquired") ?? null,
    observedWindowResolved: errorField(input.reply, "observedWindowResolved") ?? null,
    targetInput: typed.map(describeRow),
    activations: eventsIn(input.target, ["appActive"], input.window).length,
  };
  notes.holderDisturbance = holderDisturbance(input.holder, input.window, failures);
  if (facts?.code !== "foreground_required")
    failures.push("answered " + answerOf(facts) + ", expected the key-window refusal");
  else {
    if (errorField(input.reply, "keyWindowAcquired") !== false)
      failures.push("the refusal does not say keyWindowAcquired:false");
    if (errorField(input.reply, "observedWindowResolved") !== false)
      failures.push("the refusal does not say the observed window was unresolved");
    if (extendedStatusOf(input.reply) !== "used")
      failures.push("the refusal does not say extended delivery was used");
  }
  if (typed.length > 0)
    failures.push("the target got key input: " + typed.slice(0, 4).map(describeRow).join(", "));
  leftActive(input.target, "target", failures);
  return { verdict: verdictOf(failures), failures, notes };
}

export interface DeepAncestryInput {
  control: JsonObject | undefined;
  blocked: JsonObject | undefined;
  targetPid: number;
  depth: number;
  target: JsonObject[];
  window: TimeWindow;
}

export function scoreDeepAncestry(input: DeepAncestryInput): Score {
  const failures: string[] = [];
  const control = replyFacts(input.control);
  const blocked = replyFacts(input.blocked);
  const notes: JsonObject = {
    control: answerOf(control),
    blocked: answerOf(blocked),
    blockMatch: errorField(input.blocked, "blockMatch") ?? null,
    blockedPid: errorField(input.blocked, "blockedPid") ?? null,
    depth: input.depth,
  };
  if (!control?.ok)
    failures.push("control look answered " + answerOf(control) + ", expected an observation");
  if (blocked?.ok)
    failures.push(
      "look under a " +
        String(input.depth) +
        "-deep chain was answered " +
        answerOf(blocked) +
        " for an ancestor of the client",
    );
  else if (blocked?.code !== "app_blocked")
    failures.push("refused with " + answerOf(blocked) + " instead of app_blocked");
  else {
    if (errorField(input.blocked, "blockMatch") !== "pid") failures.push("blockMatch is not pid");
    if (errorField(input.blocked, "blockedPid") !== input.targetPid)
      failures.push("blockedPid is not the target");
    if (blocked.effectPossible !== false) failures.push("app_blocked without effectPossible:false");
    if (input.blocked && isJsonObject(input.blocked.result))
      failures.push("the refused look still returned an observation");
  }
  const effects = eventsIn(input.target, [...TARGET_INPUT_EVENTS, "appActive"], input.window);
  if (effects.length > 0)
    failures.push("fixture logged: " + effects.slice(0, 4).map(describeRow).join(", "));
  return { verdict: verdictOf(failures), failures, notes };
}

export type PointRect = { x: number; y: number; w: number; h: number };

export type FixtureWindow = { name: string; frame: PointRect };

export interface FixtureLayout {
  primary?: PointRect;
  windows: FixtureWindow[];
  defects: string[];
}

function cocoaFrameOf(value: JsonValue | undefined): PointRect | undefined {
  if (!isJsonObject(value)) return undefined;
  const { x, y, width, height } = value;
  return isNumber(x) && isNumber(y) && isNumber(width) && isNumber(height)
    ? { x, y, w: width, h: height }
    : undefined;
}

const sameRect = (a: PointRect, b: PointRect): boolean =>
  Math.abs(a.x - b.x) <= 0.5 &&
  Math.abs(a.y - b.y) <= 0.5 &&
  Math.abs(a.w - b.w) <= 0.5 &&
  Math.abs(a.h - b.h) <= 0.5;

const showRect = (rect: PointRect): string => `(${rect.x},${rect.y} ${rect.w}x${rect.h})`;

export function fixtureLayout(instance: string, rows: JsonObject[]): FixtureLayout {
  const defects: string[] = [];
  const launched = rows.find((row) => row.event === "launched");
  if (!launched) return { windows: [], defects: [instance + ": no launched row"] };
  const screens = Array.isArray(launched.screens) ? launched.screens.filter(isJsonObject) : [];
  const primaryRow = screens.find((screen) => screen.primary === true);
  const primaryCocoa = primaryRow ? cocoaFrameOf(primaryRow.frame) : undefined;
  if (!primaryCocoa)
    return { windows: [], defects: [instance + ": launched row has no primary screen"] };
  const primary = { x: 0, y: 0, w: primaryCocoa.w, h: primaryCocoa.h };
  const toTopLeft = (rect: PointRect): PointRect => ({
    x: rect.x,
    y: primary.h - rect.y - rect.h,
    w: rect.w,
    h: rect.h,
  });
  const windows: FixtureWindow[] = [];
  const entries = Array.isArray(launched.windows) ? launched.windows.filter(isJsonObject) : [];
  for (const entry of entries) {
    const name = instance + ":" + String(entry.window);
    const frame = cocoaFrameOf(entry.frame);
    const requested = cocoaFrameOf(entry.requestedFrame);
    if (!frame) {
      defects.push(name + ": no frame");
      continue;
    }
    if (!requested) defects.push(name + ": no requested frame");
    else if (!sameRect(frame, requested))
      defects.push(`${name}: at ${showRect(frame)}, asked for ${showRect(requested)} (Cocoa)`);
    windows.push({ name, frame: toTopLeft(frame) });
  }
  const covered = rows.filter((row) => row.event === "covered").at(-1);
  const coveredFrame = covered ? cocoaFrameOf(covered.frame) : undefined;
  if (covered && coveredFrame) {
    const name = instance + ":" + String(covered.window);
    const index = windows.findIndex((window) => window.name === name);
    if (index >= 0) windows[index] = { name, frame: toTopLeft(coveredFrame) };
  }
  return { primary, windows, defects };
}

const contains = (rect: PointRect, point: { x: number; y: number }): boolean =>
  point.x >= rect.x &&
  point.x <= rect.x + rect.w &&
  point.y >= rect.y &&
  point.y <= rect.y + rect.h;

export function windowsAt(
  point: { x: number; y: number },
  windows: FixtureWindow[],
  observed: string,
): string[] {
  return windows
    .filter((window) => window.name !== observed && contains(window.frame, point))
    .map((window) => window.name)
    .sort();
}

export function windowsOutside(primary: PointRect, windows: FixtureWindow[]): string[] {
  return windows
    .filter(
      (window) =>
        window.frame.x < primary.x ||
        window.frame.y < primary.y ||
        window.frame.x + window.frame.w > primary.x + primary.w ||
        window.frame.y + window.frame.h > primary.y + primary.h,
    )
    .map((window) => window.name + " " + showRect(window.frame));
}

export interface ExtendedOwnWindowInput {
  holder: JsonObject[];
  target: JsonObject[];
  window: TimeWindow;
  reply: JsonObject | undefined;
  observedWindow: string;
}

export function scoreExtendedOwnWindowClick(input: ExtendedOwnWindowInput): Score {
  const failures: string[] = [];
  const facts = replyFacts(input.reply);
  const status = extendedStatusOf(input.reply);
  const presses = eventsIn(input.target, ["dragDown"], input.window).length;
  const downs = eventsIn(input.target, ["targetMouseDown"], input.window);
  const elsewhere = downs.filter((row) => row.window !== input.observedWindow);
  const swiftui = eventsIn(
    input.target,
    ["swiftuiTap", "swiftuiButton", "swiftuiToggle"],
    input.window,
  );
  const notes: JsonObject = {
    answer: answerOf(facts),
    extendedDelivery: status ?? null,
    extendedDeliveryReason: extendedReasonOf(input.reply) ?? null,
    presses,
    mouseDowns: downs.map(describeRow),
    activations: eventsIn(input.target, ["appActive"], input.window).length,
  };
  notes.holderDisturbance = holderDisturbance(input.holder, input.window, failures);
  if (!facts) failures.push("helper sent no reply");
  else if (!facts.ok || facts.outcome === "didnt")
    failures.push("answered " + answerOf(facts) + " (a no-effect claim)");
  if (status !== "used")
    failures.push(
      "extended delivery not used (" +
        String(status) +
        (extendedReasonOf(input.reply) ? ": " + String(extendedReasonOf(input.reply)) : "") +
        ")",
    );
  if (elsewhere.length > 0)
    failures.push("input reached another target window: " + elsewhere.map(describeRow).join(", "));
  if (swiftui.length > 0)
    failures.push(
      "a control of the covering window reacted: " + swiftui.map(describeRow).join(", "),
    );
  if (presses !== 1)
    failures.push("drag view pressed " + String(presses) + " time(s), expected exactly 1");
  leftActive(input.target, "target", failures);
  return { verdict: verdictOf(failures), failures, notes };
}
