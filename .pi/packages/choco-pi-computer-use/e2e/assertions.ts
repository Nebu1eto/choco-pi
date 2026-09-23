import { readFile } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { tools } from "./isolation.ts";
import {
  isJsonObject,
  isNumber,
  isString,
  type JsonObject,
  type JsonField,
  type JsonValue,
} from "../src/json.ts";
import type { ScenarioId } from "./scenarios/index.ts";
import { grantTraceErrors, traceEntries } from "./grant.ts";
import { scoreTierB, type FixtureEvidence, type TierBNotes } from "./tier-b.ts";

export type RecordValue = JsonObject;
export function field(value: JsonField, key: string): JsonField {
  return isJsonObject(value) ? value[key] : undefined;
}
export function text(value: JsonField): string | undefined {
  return isString(value) ? value : undefined;
}
export async function jsonl(path: string): Promise<RecordValue[]> {
  const input = await readFile(path, "utf8");
  return input
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        const data: JsonValue = JSON.parse(line);
        if (isJsonObject(data)) return data;
      } catch {
        /* rejected below */
      }
      throw new Error(`INVALID_JSONL ${path}:${index + 1}`);
    });
}
export type Evidence = {
  events: RecordValue[];
  session: RecordValue[];
  requests: RecordValue[];
  /** Tier B: target/holder fixture logs bracketed by the Pi process lifetime. */
  fixture?: FixtureEvidence;
  intervention?: RecordValue;
};
/** Informational model-behavior evidence; never a verdict on its own. */
export type ScenarioNotes = {
  /** Persisted act_ui tool results. */
  actCalls: number;
  /** act/actBatch requests in the daemon log (including harness-injected ones). */
  dispatchedActRequests: number;
  /** act_ui calls that failed validation before reaching the daemon, with their error text. */
  rejected_before_dispatch: { index: number; error: string }[];
  /** Whether another act_ui call followed a foreground_required refusal; null when none occurred. */
  reissuedAfterForegroundRequired: boolean | null;
  /**
   * S5 only: which layer refused the stale action. `observation_refresh_required` is the TS
   * refusal (no act reached the daemon); `stale_look` is the helper's pre-delivery refusal of the
   * one act that did, attributed by `requestId` (`response`) or, when the daemon log carries no
   * response, by the stale look id (`lookId`).
   */
  staleRefusal?: {
    path: "observation_refresh_required" | "stale_look";
    attributedBy?: "response" | "lookId";
  };
  /** Tier B only: fixture state and scenario-specific evidence (see tier-b.ts). */
  tierB?: TierBNotes;
};
export type Verification = {
  /** Assertion failures; any entry makes the scenario FAIL. */
  errors: string[];
  /** Set when nothing assertion-relevant was dispatched, so the scenario cannot PASS. */
  inconclusive?: "no_dispatch" | "no_effect_observed";
  notes: ScenarioNotes;
};
const allowedPolicies = ["background", "ax_only"];
/** Scenarios whose assertions are about a dispatched action; no dispatch makes them inconclusive. */
const dispatchScenarios: readonly ScenarioId[] = ["S1", "S2", "S3", "S4", "S6"];
/** Mutation the harness sends in S5; the fake daemon logs it like any request. */
const staleMutation = "bump_root_generation";
/** The helper's stale-look refusal text (fake daemon and native bridge.swift). */
const staleLookText = /Look id '([^']+)' is no longer available/;
function resultText(message: JsonField): string {
  const content = field(message, "content");
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => text(field(part, "text")) ?? "")
    .filter((part) => part !== "")
    .join("\n");
}
/** Every `requestId` string anywhere in an execution trace (aggregate, steps, refusals). */
function traceRequestIds(value: JsonField, into: Set<string>): Set<string> {
  if (Array.isArray(value)) for (const item of value) traceRequestIds(item, into);
  else if (isJsonObject(value))
    for (const [key, item] of Object.entries(value)) {
      if (key === "requestId" && isString(item)) into.add(item);
      else traceRequestIds(item, into);
    }
  return into;
}
/** Semantic request ids of a logged act (`requestId`) or actBatch (per-action `requestId`s). */
function wireRequestIds(row: RecordValue): string[] {
  if (isString(row.requestId)) return [row.requestId];
  const actions = row.actions;
  return Array.isArray(actions)
    ? actions.map((action) => field(action, "requestId")).filter(isString)
    : [];
}
function isForegroundRequired(message: JsonField): boolean {
  const details = field(message, "details");
  const execution = field(details, "execution");
  return (
    field(details, "status") === "foreground_required" ||
    field(field(execution, "refusal"), "code") === "foreground_required" ||
    field(execution, "outcome") === "foreground_required" ||
    resultText(message).startsWith("foreground_required")
  );
}
function isActRequest(row: RecordValue): boolean {
  return row.cmd === "act" || row.cmd === "actBatch";
}
/** The action name of a logged act (`action`) or of every action in an actBatch. */
function wireActions(row: RecordValue): string[] {
  if (isString(row.action)) return [row.action];
  const actions = row.actions;
  return Array.isArray(actions)
    ? actions.map((action) => field(action, "action")).filter(isString)
    : [];
}
/**
 * S5: the one act that reached the daemon after the mutation and was refused there as stale before
 * delivery. Attribution is by the logged daemon response (`response.error.code`) when present,
 * otherwise by the stale look id quoted in the only rejected act_ui result. Returns undefined when
 * the evidence does not prove that path.
 */
function staleLookRefusal(
  acts: RecordValue[],
  rejected: ScenarioNotes["rejected_before_dispatch"],
): { row: RecordValue; attributedBy: "response" | "lookId" } | undefined {
  if (acts.length !== 1) return undefined;
  const [row] = acts;
  if (row.cmd !== "act" || !isString(row.requestId) || !isString(row.lookId)) return undefined;
  const response = row.response;
  if (response !== undefined) {
    return field(response, "ok") !== true &&
      field(field(response, "error"), "code") === "stale_look" &&
      field(field(response, "result"), "outcome") !== "worked"
      ? { row, attributedBy: "response" }
      : undefined;
  }
  const stale = rejected.filter((entry) => staleLookText.test(entry.error));
  if (rejected.length !== 1 || stale.length !== 1) return undefined;
  return staleLookText.exec(stale[0].error)?.[1] === row.lookId
    ? { row, attributedBy: "lookId" }
    : undefined;
}
/** Semantic request id of the typeText in a logged act or actBatch. */
function typingRequestId(row: RecordValue): string | undefined {
  if (isString(row.requestId)) return row.requestId;
  const actions = row.actions;
  const typed = Array.isArray(actions)
    ? actions.find((action) => field(action, "action") === "typeText")
    : undefined;
  return text(field(typed, "requestId"));
}
/**
 * S3: the helper answered the only typeText with `didnt`. Pass when that act was sent once, nothing
 * was sent after it, nothing escalated to the foreground, and the result reports the didnt on the
 * attributed step or as a foreground_required refusal of a didnt background attempt.
 */
function scoreDidnt(all: RecordValue[], typing: RecordValue[], traces: JsonObject[]): string[] {
  const errors: string[] = [];
  if (typing.length !== 1)
    return [`expected exactly one typeText act request, got ${typing.length}`];
  const [typed] = typing;
  if (typed.response !== undefined && field(field(typed.response, "result"), "outcome") !== "didnt")
    errors.push("helper did not answer the typeText with didnt");
  if (all.slice(all.indexOf(typed) + 1).some(isActRequest))
    errors.push("act request after the didnt typeText (retry)");
  if (
    all.some(
      (row) =>
        row.policy === "foreground" || row.foregroundGrant === true || row.cmd === "focusWindow",
    )
  )
    errors.push("daemon foreground request");
  const entries = traces.flatMap(traceEntries);
  for (const entry of [...traces, ...entries]) {
    if (field(entry, "escalatedToForeground") === true || field(entry, "escalationReason"))
      errors.push("escalated to foreground");
    const attempt = field(entry, "backgroundAttempt");
    // The bridge records the refused background try as `backgroundAttempt:{outcome:"didnt"}`;
    // any other outcome means the helper refused or escalation was considered.
    if (attempt !== undefined && field(attempt, "outcome") !== "didnt")
      errors.push(`backgroundAttempt outcome ${String(field(attempt, "outcome"))}`);
  }
  const id = typingRequestId(typed);
  const step = entries.find((entry) => id !== undefined && field(entry, "requestId") === id);
  if (!step) return [...errors, "typeText act not attributable to an executed result"];
  const trace = traces.find((candidate) => traceEntries(candidate).includes(step));
  const refusedDidnt = [step, trace].some(
    (entry) =>
      field(field(entry, "refusal"), "code") === "foreground_required" &&
      field(field(entry, "backgroundAttempt"), "outcome") === "didnt",
  );
  if (field(step, "outcome") !== "didnt" && !refusedDidnt) errors.push("didnt not reported");
  return [...new Set(errors)];
}
/**
 * S4: the helper held the typeText past the transport timeout. Pass when the transport cancelled
 * that request by its semantic id, the helper acknowledged `stopped`, nothing was sent after the
 * cancel, and the act_ui result reports the cancellation with its stop point.
 */
function scoreCancel(all: RecordValue[], typing: RecordValue[], messages: JsonField[]): string[] {
  const errors: string[] = [];
  const typed = typing[0];
  const id = typed && typingRequestId(typed);
  if (!typed || id === undefined) return ["no typeText act request with a requestId"];
  const cancelIndex = all.findIndex((row) => row.cmd === "cancel" && row.target === id);
  const cancel = all[cancelIndex];
  if (!cancel || cancelIndex < all.indexOf(typed))
    errors.push("missing cancel for the typeText act");
  else {
    if (field(cancel.ack, "acknowledged") !== true || field(cancel.ack, "state") !== "stopped")
      errors.push("cancel not acknowledged as stopped");
    if (all.slice(cancelIndex + 1).some(isActRequest)) errors.push("act request after cancel");
  }
  const cancelled = messages.some((message) => {
    const details = field(message, "details");
    const execution = field(details, "execution");
    return (
      field(details, "status") === "cancelled" &&
      field(field(details, "error"), "code") === "cancelled" &&
      ["partial", "rejected_before_delivery"].includes(text(field(execution, "outcome")) ?? "") &&
      isNumber(field(execution, "stoppedAt")) &&
      field(field(execution, "cancel"), "state") === "stopped"
    );
  });
  if (!cancelled) errors.push("act_ui result not reported as cancelled with stoppedAt");
  // The fake daemon logs an act when it answers it; a held act answered after the cancel carries
  // the cancelled reply.
  if (field(field(typed.response, "error"), "code") !== "cancelled")
    errors.push("typeText act not answered as cancelled");
  return errors;
}
/**
 * S6: one ungranted background attempt refused with `foreground_required` and `effectPossible:
 * false`, then exactly one granted foreground retry of the same target, reported as an escalation.
 * The retry answers `worked`, or `unknown` when HID delivery cannot attest its effect (the fake,
 * like the helper, answers a granted HID click on a view without an AX action this way); the
 * escalated trace must report the same outcome, so an `unknown` is never scored as a claimed
 * change.
 */
function scoreGrant(requests: RecordValue[], traces: JsonObject[]): string[] {
  const foreground = requests.filter((row) => row.policy === "foreground");
  const retry = foreground[0];
  if (foreground.length !== 1 || retry?.foregroundGrant !== true)
    return [`expected one granted foreground act, got ${foreground.length}`];
  const errors: string[] = [];
  const first = requests[requests.indexOf(retry) - 1];
  const refusal = field(first?.response, "error");
  if (
    first?.policy !== "background" ||
    field(refusal, "code") !== "foreground_required" ||
    field(refusal, "effectPossible") !== false ||
    JSON.stringify(first.target) !== JSON.stringify(retry.target)
  )
    errors.push("foreground act not preceded by a refused background attempt on the same target");
  const outcome = field(field(retry.response, "result"), "outcome");
  if (field(retry.response, "ok") !== true || (outcome !== "worked" && outcome !== "unknown"))
    errors.push(`granted foreground act answered ${String(outcome)}`);
  errors.push(...grantTraceErrors(retry, traces));
  return errors;
}
/**
 * Policy, delivery and frontmost evidence of one executed trace entry. `required` entries (steps,
 * or a step-less aggregate) must carry the fields; an aggregate over steps is checked only for the
 * fields it actually has.
 */
function checkDelivery(entry: JsonField, required: boolean, label: string, errors: string[]): void {
  const policy = text(field(entry, "deliveryPolicy"));
  if (
    (required || field(entry, "deliveryPolicy") !== undefined) &&
    !allowedPolicies.includes(policy ?? "")
  )
    errors.push(`${label}: foreground/unknown policy (${policy ?? "missing"})`);
  for (const [key, bad] of [
    ["delivery", "hid"],
    ["escalatedToForeground", true],
    ["activated", true],
    ["raised", true],
  ] as const) {
    const actual =
      key === "activated" || key === "raised"
        ? field(field(entry, "performed"), key)
        : field(entry, key);
    if (actual === bad) errors.push(`${label}: forbidden ${key}`);
  }
  const before = field(entry, "frontmostBefore");
  const after = field(entry, "frontmostAfter");
  if (required || before !== undefined || after !== undefined) {
    if (before === undefined || after === undefined) errors.push(`${label}: frontmost unmeasured`);
    else if (JSON.stringify(before) !== JSON.stringify(after))
      errors.push(`${label}: frontmost changed`);
  }
}
export function verdictOf(errors: readonly string[], inconclusive?: string): string {
  if (errors.length) return `FAIL(${errors.join("; ")})`;
  return inconclusive ? `INCONCLUSIVE(${inconclusive})` : "PASS";
}
/**
 * Whether later scenarios are blocked after S1. Only S1's isolation checks decide this: a scenario
 * assertion failure never blocks, while failed or never-run isolation checks do.
 */
export function isolationBlock(isolation: readonly string[] | undefined): string | undefined {
  if (isolation === undefined) return "isolation-unproven";
  return isolation.length ? "isolation" : undefined;
}
export function verify(
  scenario: ScenarioId,
  e: Evidence,
  root: string,
  tier: "a" | "b",
): Verification {
  const errors: string[] = [];
  const allowedTools = tools.split(",");
  const ends = e.events.filter(
    (row) => row.type === "tool_execution_end" && row.toolName === "act_ui",
  );
  const cuResults = e.session.filter(
    (row) =>
      row.type === "message" &&
      field(row.message, "role") === "toolResult" &&
      allowedTools.includes(text(field(row.message, "toolName")) ?? ""),
  );
  const sessionResults = cuResults.filter((row) => field(row.message, "toolName") === "act_ui");
  const executions = sessionResults.map((row) => field(field(row.message, "details"), "execution"));
  /** Only results that reached the daemon carry an execution trace. */
  const traces = executions.filter(isJsonObject);
  const rejected: ScenarioNotes["rejected_before_dispatch"] = [];
  sessionResults.forEach((row, index) => {
    if (isJsonObject(executions[index])) return;
    if (field(row.message, "isError") === true)
      rejected.push({ index, error: resultText(row.message) || "(no error text)" });
    else errors.push(`act_ui result ${index} succeeded without an execution trace`);
  });
  if (e.events.some((row) => row.type === "agent_settled") === false)
    errors.push("missing agent_settled");
  if (!sessionResults.length) errors.push("missing persisted act_ui toolResult");
  if (ends.length !== sessionResults.length)
    errors.push("tool result count differs between events and session");
  for (let i = 0; i < Math.min(ends.length, sessionResults.length); i++) {
    if (
      JSON.stringify(field(field(ends[i].result, "details"), "execution")) !==
      JSON.stringify(executions[i])
    )
      errors.push(`execution mismatch at ${i}`);
  }
  // Headless configuration is a property of the scenario, checked once over every CU result
  // that reports it (find_roots/observe_ui/act_ui); rejected calls carry no config.
  const configs = cuResults
    .map((row) => field(field(row.message, "details"), "config"))
    .filter(isJsonObject);
  if (!configs.length) errors.push("headless config missing");
  else if (configs.some((config) => config.headless !== false))
    errors.push("headless config incorrect");
  const requests = e.requests.filter(isActRequest);
  // S5: acts logged after the harness mutation, and the stale-look refusal they may prove.
  const mutationIndex = e.requests.findIndex((row) => row.fixtureMutation === staleMutation);
  const actsAfterMutation =
    mutationIndex < 0 ? [] : e.requests.slice(mutationIndex + 1).filter(isActRequest);
  const staleLook = scenario === "S5" ? staleLookRefusal(actsAfterMutation, rejected) : undefined;
  // A rejected call must not have reached the daemon: every act request must belong to an
  // executed result (or a cancellation). S7's harness-injected second-session act has no
  // requestId and is excluded there only; S5's act proven refused as stale by the helper is
  // attributed to that refusal.
  if (rejected.length) {
    const attributed = new Set<string>();
    for (const trace of traces) traceRequestIds(trace, attributed);
    for (const row of e.requests)
      if (row.cmd === "cancel")
        for (const key of ["requestId", "target"]) if (isString(row[key])) attributed.add(row[key]);
    const unattributed = requests.filter((row) => {
      const ids = wireRequestIds(row);
      if (scenario === "S7" && ids.length === 0) return false;
      if (row === staleLook?.row) return false;
      // Tier B S5: the helper refused this act as stale before delivery (logged reply).
      if (
        tier === "b" &&
        scenario === "S5" &&
        field(field(row.response, "error"), "code") === "stale_look"
      )
        return false;
      return !ids.some((id) => attributed.has(id));
    });
    if (unattributed.length)
      errors.push(
        `rejected act_ui call may have dispatched: ${unattributed.length} act request(s) not attributable to an executed result`,
      );
  }
  const foregroundIndex = sessionResults.findIndex((row) => isForegroundRequired(row.message));
  const notes: ScenarioNotes = {
    actCalls: sessionResults.length,
    dispatchedActRequests: requests.length,
    rejected_before_dispatch: rejected,
    reissuedAfterForegroundRequired:
      foregroundIndex < 0 ? null : sessionResults.length > foregroundIndex + 1,
  };
  const noDispatch =
    dispatchScenarios.includes(scenario) && traces.length === 0 && requests.length === 0;
  const typing = requests.filter((row) => wireActions(row).includes("typeText"));
  if (scenario === "S1") {
    traces.forEach((trace, index) => {
      const steps = field(trace, "steps");
      const list = Array.isArray(steps) ? steps : [];
      list.forEach((step, stepIndex) =>
        checkDelivery(step, true, `execution ${index} step ${stepIndex}`, errors),
      );
      checkDelivery(trace, list.length === 0, `execution ${index}`, errors);
    });
    if (
      e.requests.some(
        (row) =>
          row.policy === "foreground" || row.cmd === "focusWindow" || row.foregroundGrant === true,
      )
    )
      errors.push("daemon foreground request");
  }
  if (scenario === "S2" && !noDispatch) {
    if (
      requests.length !== 1 ||
      requests[0]?.cmd !== "act" ||
      requests.some((row) => row.policy === "foreground")
    )
      errors.push("refusal retried or foreground");
    if (
      !sessionResults.some((row) => {
        const details = field(row.message, "details");
        const refusal = field(field(details, "execution"), "refusal");
        return (
          (field(details, "status") === "foreground_required" ||
            field(refusal, "code") === "foreground_required") &&
          field(refusal, "target") !== undefined &&
          field(refusal, "action") !== undefined &&
          field(refusal, "capability") !== undefined &&
          field(refusal, "effectPossible") === false
        );
      })
    )
      errors.push("missing structured refusal");
  }
  if (scenario === "S3" && !noDispatch && tier === "a") {
    errors.push(...scoreDidnt(e.requests, typing, traces));
  }
  if (scenario === "S4" && tier === "a") {
    if (!noDispatch)
      errors.push(
        ...scoreCancel(
          e.requests,
          typing,
          sessionResults.map((row) => row.message),
        ),
      );
  }
  if (scenario === "S5" && tier === "a") {
    if (e.intervention?.ok !== true) errors.push("fixture mutation not acknowledged");
    if (mutationIndex < 0) errors.push("fixture mutation not logged");
    const refreshRequired = sessionResults.some((row) => {
      // The bridge reports the stale refusal in the result text; details may be empty.
      const evidence = `${JSON.stringify(field(row.message, "details") ?? null)}\n${resultText(row.message)}`;
      return evidence.includes("observation_refresh_required") && evidence.includes('"stale"');
    });
    if (
      traces.some((trace) =>
        traceEntries(trace).some((entry) => field(entry, "outcome") === "worked"),
      )
    )
      errors.push("stale action was delivered");
    if (mutationIndex >= 0 && actsAfterMutation.length === 0 && refreshRequired)
      notes.staleRefusal = { path: "observation_refresh_required" };
    else if (staleLook)
      notes.staleRefusal = { path: "stale_look", attributedBy: staleLook.attributedBy };
    else errors.push("stale action was delivered or not refused");
  }
  if (scenario === "S5" && tier === "b") {
    if (
      traces.some((trace) =>
        traceEntries(trace).some((entry) => field(entry, "outcome") === "worked"),
      )
    )
      errors.push("stale action was delivered");
  }
  if (scenario === "S6" && !noDispatch && tier === "a")
    errors.push(...scoreGrant(requests, traces));
  if (
    scenario === "S7" &&
    (e.requests.filter((row) => row.cmd === "act").length < 3 ||
      e.intervention?.ok !== false ||
      field(e.intervention?.error, "code") !== "owned_by_other_session" ||
      traces.some((trace) => field(trace, "outcome") !== "worked"))
  )
    errors.push("second client not refused");
  let inconclusive: Verification["inconclusive"] = noDispatch ? "no_dispatch" : undefined;
  if (tier === "b") {
    const scored = scoreTierB(scenario, {
      requests: e.requests,
      traces,
      results: sessionResults.map((row) => row.message),
      fixture: e.fixture,
      intervention: e.intervention,
      noDispatch,
    });
    errors.push(...scored.errors);
    notes.tierB = scored.notes;
    inconclusive ??= scored.inconclusive;
  }
  return inconclusive ? { errors, inconclusive, notes } : { errors, notes };
}
export function isolationCheck(
  events: RecordValue[],
  session: RecordValue[],
  root: string,
  settings: RecordValue,
  packagePath: string,
  stderr: string,
  rawEvents: string,
  rawSession: string,
  /** Tier B: the dev helper executable, which may live outside the scratch root. */
  allowedHelper?: string,
): string[] {
  const errors: string[] = [];
  const scratchOrHelper = (executable: string): boolean =>
    isAbsolute(executable) &&
    (!relative(root, executable).startsWith("..") || executable === allowedHelper);
  const configured = events.find((event) => event.type === "agent_start");
  const announced = field(configured, "tools");
  if (
    Array.isArray(announced) &&
    (announced.length !== 8 ||
      announced.some((item) => !isString(item)) ||
      [...announced].sort().join(",") !== tools.split(",").sort().join(","))
  )
    errors.push("tool list not exactly eight allowed tools");
  if (JSON.stringify(settings.packages) !== JSON.stringify([packagePath]))
    errors.push("scratch agent has extra/missing packages");
  if (
    /(warning|error).{0,100}extension|extension.{0,100}(warning|error|failed|duplicate)|duplicate.{0,100}(act_ui|tool)/i.test(
      stderr,
    )
  )
    errors.push("extension load or duplicate registration diagnostic");
  if (
    rawEvents.includes("/Users/Nebuleto/.pi/agent") ||
    rawSession.includes("/Users/Nebuleto/.pi/agent")
  )
    errors.push("global agent path leaked into run evidence");
  if (
    events.some(
      (row) =>
        row.type === "tool_execution_start" &&
        (!isString(row.toolName) || !tools.split(",").includes(row.toolName)),
    )
  )
    errors.push("unlisted tool invoked");
  const results = session.filter(
    (row) =>
      row.type === "message" &&
      field(row.message, "role") === "toolResult" &&
      tools.split(",").includes(text(field(row.message, "toolName")) ?? ""),
  );
  const first = results.find((row) => isJsonObject(field(field(row.message, "details"), "helper")));
  const firstExecutable = text(
    field(field(field(first?.message, "details"), "helper"), "executablePath"),
  );
  if (!firstExecutable || !scratchOrHelper(firstExecutable))
    errors.push("first helper-bearing CU result lacks scratch executable path");
  for (const row of results) {
    const details = field(row.message, "details");
    const executable = text(field(field(details, "helper"), "executablePath"));
    if (executable && !scratchOrHelper(executable))
      errors.push("helper executable escaped scratch");
  }
  if (!results.length) errors.push("no tool result to prove isolation");
  return errors;
}
