import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  isJsonObject,
  isNumber,
  isString,
  type JsonObject,
  type JsonValue,
} from "../../src/json.ts";

/** Verdict of one safety scenario; only PASS and INCONCLUSIVE leave the exit code at 0. */
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
  const effects = eventsIn(input.target, ["fieldValue", "increment", "customHit"], input.window);
  const late = effects.filter((row) => (ts(row) ?? 0) > limit);
  const before = effects.filter(
    (row) => row.event === "fieldValue" && (ts(row) ?? 0) <= input.ackAt!,
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
