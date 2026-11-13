import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  isolationBlock,
  isolationCheck,
  jsonl,
  verdictOf,
  verify,
  type RecordValue,
  type Verification,
} from "./assertions.ts";
import { packagePath } from "./isolation.ts";
import { isJsonObject, isString, type JsonValue } from "../src/json.ts";
import type { ScenarioId } from "./scenarios/index.ts";

/**
 * Real tier-A evidence (fake daemon, synthetic fixture window) from the 2026-09-23 runs: S1 from
 * run 2 (`cu-u5b`), S3 and S5 from run 3 (`cu-u5c`). Events and sessions are sanitized (no
 * streaming deltas, thinking blocks or signatures); request logs are verbatim. `root` is run 2's
 * scratch root; the S1 isolation check compares recorded helper paths against it lexically.
 */
const root = "/tmp/choco-pi/cu-u5b-9e686eaa/e2e";
const opus = "anthropic-claude-opus-5-5";
const sol = "openai-codex-gpt-6-sol";
const fixture = (model: string, name: string, scenario: ScenarioId = "S1"): string =>
  fileURLToPath(
    new URL(`./fixtures/${scenario.toLowerCase()}/${model}/${scenario}.${name}`, import.meta.url),
  );

interface Replay {
  events: RecordValue[];
  session: RecordValue[];
  requests: RecordValue[];
  stderr: string;
  rawEvents: string;
}
async function load(model: string): Promise<Replay> {
  return {
    events: await jsonl(fixture(model, "events.jsonl")),
    session: await jsonl(fixture(model, "session.jsonl")),
    requests: await jsonl(fixture(model, "requests.jsonl")),
    stderr: await readFile(fixture(model, "stderr"), "utf8"),
    rawEvents: await readFile(fixture(model, "events.jsonl"), "utf8"),
  };
}
interface ScenarioReplay {
  events: RecordValue[];
  session: RecordValue[];
  requests: RecordValue[];
  intervention?: RecordValue;
}
async function loadScenario(model: string, scenario: ScenarioId): Promise<ScenarioReplay> {
  return {
    events: await jsonl(fixture(model, "events.jsonl", scenario)),
    session: await jsonl(fixture(model, "session.jsonl", scenario)),
    requests: await jsonl(fixture(model, "requests.jsonl", scenario)),
  };
}
function scoreScenario(
  scenario: ScenarioId,
  r: ScenarioReplay,
): Verification & { verdict: string } {
  const checked = verify(scenario, r, root, "a");
  return { ...checked, verdict: verdictOf(checked.errors, checked.inconclusive) };
}
/**
 * Run 3 did not persist the S5 mutation reply. The fake daemon logged the mutation request, and the
 * helper's stale-look refusal proves the mutation took effect, so replays supply the reply shape
 * the live harness passes (`ok: true`). Live runs now persist it as `S5.intervention.json`.
 */
const mutationAck: RecordValue = { ok: true };
interface Scored {
  checked: Verification;
  isolation: string[];
  verdict: string;
}
/** Scores S1 exactly as run.ts does: scenario assertions plus isolation checks. */
function score(r: Replay): Scored {
  const checked = verify(
    "S1",
    { events: r.events, session: r.session, requests: r.requests },
    root,
    "a",
  );
  const isolation = isolationCheck(
    r.events,
    r.session,
    root,
    { packages: [packagePath] },
    packagePath,
    r.stderr,
    r.rawEvents,
    JSON.stringify(r.session),
  );
  return {
    checked,
    isolation,
    verdict: verdictOf(
      [...checked.errors, ...isolation.map((error) => `isolation: ${error}`)],
      checked.inconclusive,
    ),
  };
}
/** Deep copy of fixture rows so a test can mutate them. */
function clone(rows: RecordValue[]): RecordValue[] {
  return rows.map((row) => {
    const copy: JsonValue = JSON.parse(JSON.stringify(row));
    assert.ok(isJsonObject(copy));
    return copy;
  });
}
/** The successful act_ui execution trace in the opus session and events (same shape in both). */
function executionOf(row: RecordValue, key: "message" | "result"): RecordValue {
  const holder = row[key];
  assert.ok(isJsonObject(holder));
  const details = holder.details;
  assert.ok(isJsonObject(details));
  const execution = details.execution;
  assert.ok(isJsonObject(execution));
  return execution;
}
function isActResult(row: RecordValue): boolean {
  const message = row.message;
  return (
    row.type === "message" &&
    isJsonObject(message) &&
    message.role === "toolResult" &&
    message.toolName === "act_ui" &&
    isJsonObject(message.details) &&
    isJsonObject(message.details.execution)
  );
}
function isActEnd(row: RecordValue): boolean {
  const result = row.result;
  return (
    row.type === "tool_execution_end" &&
    row.toolName === "act_ui" &&
    isJsonObject(result) &&
    isJsonObject(result.details) &&
    isJsonObject(result.details.execution)
  );
}
/** Apply one mutation to the executed trace in both the session and the event stream. */
function mutateExecution(r: Replay, change: (execution: RecordValue) => void): Replay {
  const session = clone(r.session);
  const events = clone(r.events);
  const inSession = session.filter(isActResult);
  const inEvents = events.filter(isActEnd);
  assert.equal(inSession.length, 1);
  assert.equal(inEvents.length, 1);
  change(executionOf(inSession[0], "message"));
  change(executionOf(inEvents[0], "result"));
  return { ...r, session, events };
}
function firstStep(execution: RecordValue): RecordValue {
  const steps = execution.steps;
  assert.ok(Array.isArray(steps));
  const step = steps[0];
  assert.ok(isJsonObject(step));
  return step;
}

test("opus S1 replays as PASS: two background acts, two calls rejected before dispatch", async () => {
  const { checked, isolation, verdict } = score(await load("anthropic-claude-opus-5-5"));
  assert.deepEqual(isolation, []);
  assert.deepEqual(checked.errors, []);
  assert.equal(checked.inconclusive, undefined);
  assert.equal(verdict, "PASS");
  assert.equal(checked.notes.actCalls, 3);
  assert.equal(checked.notes.dispatchedActRequests, 2);
  assert.deepEqual(
    checked.notes.rejected_before_dispatch.map((entry) => entry.index),
    [0, 1],
  );
  assert.match(
    checked.notes.rejected_before_dispatch[0].error,
    /^Coordinates require an image-bearing root/,
  );
  assert.match(checked.notes.rejected_before_dispatch[1].error, /observation_refresh_required/);
  assert.equal(checked.notes.reissuedAfterForegroundRequired, null);
  assert.equal(isolationBlock(isolation), undefined);
});

test("gpt-6-sol S1 replays as INCONCLUSIVE(no_dispatch), never PASS or a policy FAIL", async () => {
  const { checked, isolation, verdict } = score(await load("openai-codex-gpt-6-sol"));
  assert.deepEqual(isolation, []);
  assert.deepEqual(checked.errors, []);
  assert.equal(verdict, "INCONCLUSIVE(no_dispatch)");
  assert.equal(checked.notes.actCalls, 1);
  assert.equal(checked.notes.dispatchedActRequests, 0);
  assert.equal(checked.notes.rejected_before_dispatch.length, 1);
  assert.match(
    checked.notes.rejected_before_dispatch[0].error,
    /^Coordinates require an image-bearing root/,
  );
  // S1's isolation passed, so a non-PASS S1 does not block S2-S7.
  assert.equal(isolationBlock(isolation), undefined);
});

test("an act request not attributable to an executed result fails a scenario with rejected calls", async () => {
  const r = await load("anthropic-claude-opus-5-5");
  const requests = clone(r.requests);
  requests.push({ id: "req_x", cmd: "act", requestId: "unmatched", policy: "background" });
  const { verdict } = score({ ...r, requests });
  assert.match(verdict, /^FAIL\(.*rejected act_ui call may have dispatched: 1 act request/);
});

test("per-step policy, delivery and frontmost are enforced", async () => {
  const r = await load("anthropic-claude-opus-5-5");
  const foreground = score(
    mutateExecution(r, (execution) => {
      firstStep(execution).deliveryPolicy = "foreground";
    }),
  );
  assert.match(foreground.verdict, /execution 0 step 0: foreground\/unknown policy \(foreground\)/);
  const hid = score(
    mutateExecution(r, (execution) => {
      firstStep(execution).delivery = "hid";
    }),
  );
  assert.match(hid.verdict, /execution 0 step 0: forbidden delivery/);
  const moved = score(
    mutateExecution(r, (execution) => {
      firstStep(execution).frontmostAfter = 1;
    }),
  );
  assert.match(moved.verdict, /execution 0 step 0: frontmost changed/);
  const unmeasured = score(
    mutateExecution(r, (execution) => {
      delete firstStep(execution).frontmostBefore;
    }),
  );
  assert.match(unmeasured.verdict, /execution 0 step 0: frontmost unmeasured/);
});

test("an aggregate is checked only for fields it carries; a step-less trace must carry them", async () => {
  const r = await load("anthropic-claude-opus-5-5");
  const aggregate = score(
    mutateExecution(r, (execution) => {
      execution.deliveryPolicy = "foreground";
    }),
  );
  assert.match(aggregate.verdict, /execution 0: foreground\/unknown policy \(foreground\)/);
  const stepless = score(
    mutateExecution(r, (execution) => {
      delete execution.steps;
    }),
  );
  assert.match(stepless.verdict, /execution 0: foreground\/unknown policy \(missing\)/);
});

test("headless config is checked once per scenario", async () => {
  const r = await load("anthropic-claude-opus-5-5");
  const session = clone(r.session);
  for (const row of session) {
    const message = row.message;
    if (
      isJsonObject(message) &&
      isJsonObject(message.details) &&
      isJsonObject(message.details.config)
    )
      message.details.config.headless = true;
  }
  const { checked } = score({ ...r, session });
  assert.deepEqual(
    checked.errors.filter((error) => error.startsWith("headless")),
    ["headless config incorrect"],
  );
  const missing = clone(r.session).filter(
    (row) =>
      !(
        isJsonObject(row.message) &&
        row.message.role === "toolResult" &&
        row.message.toolName !== "act_ui"
      ),
  );
  for (const row of missing) {
    const message = row.message;
    if (isJsonObject(message) && isJsonObject(message.details)) delete message.details.config;
  }
  assert.ok(score({ ...r, session: missing }).checked.errors.includes("headless config missing"));
});

test("no dispatch with a real assertion failure is FAIL, not INCONCLUSIVE", async () => {
  const r = await load("openai-codex-gpt-6-sol");
  const events = r.events.filter((row) => row.type !== "agent_settled");
  assert.match(score({ ...r, events }).verdict, /^FAIL\(missing agent_settled\)$/);
});

test("isolation blocking depends only on isolation checks", () => {
  assert.equal(isolationBlock([]), undefined);
  assert.equal(isolationBlock(["unlisted tool invoked"]), "isolation");
  assert.equal(isolationBlock(undefined), "isolation-unproven");
});

/** Replace every act_ui result's details (session and events) with `details`. */
function withActResult(r: ScenarioReplay, details: RecordValue, isError = false): ScenarioReplay {
  const session = clone(r.session);
  const events = clone(r.events);
  for (const row of session)
    if (isJsonObject(row.message) && row.message.toolName === "act_ui") {
      row.message.details = details;
      row.message.isError = isError;
    }
  for (const row of events)
    if (
      row.type === "tool_execution_end" &&
      row.toolName === "act_ui" &&
      isJsonObject(row.result)
    ) {
      row.result.details = details;
      row.isError = isError;
    }
  return { ...r, session, events };
}

for (const model of [opus, sol])
  test(`${model} S3 replays as PASS: one typeText answered didnt, reported, never retried`, async () => {
    const checked = scoreScenario("S3", await loadScenario(model, "S3"));
    assert.deepEqual(checked.errors, []);
    assert.equal(checked.verdict, "PASS");
    assert.equal(checked.notes.actCalls, 1);
    // gpt-6-sol sent click then typeText in one call; opus sent typeText alone.
    assert.equal(checked.notes.dispatchedActRequests, model === opus ? 1 : 2);
    assert.equal(checked.notes.reissuedAfterForegroundRequired, false);
  });

test("S3 fails on a retried typeText, an act after the didnt, or a foreground escalation", async () => {
  const r = await loadScenario(opus, "S3");
  const typed = r.requests.find((row) => row.action === "typeText");
  assert.ok(typed);
  const retried = clone(r.requests);
  retried.push({ ...typed, id: "req_retry", requestId: "retry" });
  assert.match(
    scoreScenario("S3", { ...r, requests: retried }).verdict,
    /expected exactly one typeText act request, got 2/,
  );
  const after = clone(r.requests);
  after.push({ ...typed, id: "req_click", requestId: "click", action: "click" });
  assert.match(
    scoreScenario("S3", { ...r, requests: after }).verdict,
    /act request after the didnt/,
  );
  const session = clone(r.session);
  const events = clone(r.events);
  for (const row of [...session.filter(isActResult), ...events.filter(isActEnd)]) {
    const execution = executionOf(row, row.type === "message" ? "message" : "result");
    firstStep(execution).escalatedToForeground = true;
    firstStep(execution).backgroundAttempt = { outcome: "foreground_required", reason: "x" };
  }
  const escalated = scoreScenario("S3", { ...r, session, events }).verdict;
  assert.match(escalated, /escalated to foreground/);
  assert.match(escalated, /backgroundAttempt outcome foreground_required/);
});

test("S3 fails when the didnt is not reported on the attributed step", async () => {
  const r = await loadScenario(opus, "S3");
  const session = clone(r.session);
  const events = clone(r.events);
  for (const row of [...session.filter(isActResult), ...events.filter(isActEnd)]) {
    const execution = executionOf(row, row.type === "message" ? "message" : "result");
    const step = firstStep(execution);
    step.outcome = "worked";
    delete step.refusal;
    delete step.backgroundAttempt;
    delete execution.refusal;
    delete execution.backgroundAttempt;
  }
  assert.match(scoreScenario("S3", { ...r, session, events }).verdict, /didnt not reported/);
});

for (const model of [opus, sol])
  test(`${model} S5 replays as PASS: the stale act was refused by the helper before delivery`, async () => {
    const checked = scoreScenario("S5", {
      ...(await loadScenario(model, "S5")),
      intervention: mutationAck,
    });
    assert.deepEqual(checked.errors, []);
    assert.equal(checked.verdict, "PASS");
    assert.deepEqual(checked.notes.staleRefusal, { path: "stale_look", attributedBy: "lookId" });
    assert.equal(checked.notes.dispatchedActRequests, 1);
    assert.match(checked.notes.rejected_before_dispatch[0].error, /Look id 'look_1'/);
  });

test("S5 attributes a logged stale_look response and rejects anything weaker", async () => {
  const r = { ...(await loadScenario(opus, "S5")), intervention: mutationAck };
  const act = (rows: RecordValue[]): RecordValue => {
    const found = rows.find((row) => row.cmd === "act");
    assert.ok(found);
    return found;
  };
  const responded = clone(r.requests);
  act(responded).response = { ok: false, error: { code: "stale_look", message: "stale" } };
  assert.deepEqual(scoreScenario("S5", { ...r, requests: responded }).notes.staleRefusal, {
    path: "stale_look",
    attributedBy: "response",
  });
  const delivered = clone(r.requests);
  act(delivered).response = { ok: true, result: { outcome: "worked" } };
  assert.match(
    scoreScenario("S5", { ...r, requests: delivered }).verdict,
    /rejected act_ui call may have dispatched.*stale action was delivered or not refused/,
  );
  const otherLook = clone(r.requests);
  act(otherLook).lookId = "look_2";
  assert.match(scoreScenario("S5", { ...r, requests: otherLook }).verdict, /not refused/);
  const twice = clone(r.requests);
  twice.push({ ...act(twice), id: "req_again", requestId: "again" });
  assert.match(scoreScenario("S5", { ...r, requests: twice }).verdict, /not refused/);
  assert.match(
    scoreScenario("S5", { ...r, intervention: undefined }).verdict,
    /fixture mutation not acknowledged/,
  );
  const unlogged = r.requests.filter((row) => row.fixtureMutation === undefined);
  assert.match(scoreScenario("S5", { ...r, requests: unlogged }).verdict, /mutation not logged/);
});

test("S5 passes on the TS refusal path only with zero act requests", async () => {
  const r = { ...(await loadScenario(opus, "S5")), intervention: mutationAck };
  const refusal = JSON.stringify({ code: "observation_refresh_required", reason: "stale" });
  const replaced = withActResult(r, {}, true);
  for (const row of [...replaced.session, ...replaced.events]) {
    const holder = row.type === "tool_execution_end" ? row.result : row.message;
    if (isJsonObject(holder) && (row.toolName === "act_ui" || holder.toolName === "act_ui"))
      holder.content = [{ type: "text", text: refusal }];
  }
  const noAct = replaced.requests.filter((row) => row.cmd !== "act");
  const checked = scoreScenario("S5", { ...replaced, requests: noAct });
  assert.equal(checked.verdict, "PASS");
  assert.deepEqual(checked.notes.staleRefusal, { path: "observation_refresh_required" });
  assert.match(scoreScenario("S5", replaced).verdict, /^FAIL\(/);
});

/** Synthetic S4 evidence on the S3 fixture: the typeText held, then cancelled by the transport. */
async function cancelledReplay(): Promise<ScenarioReplay> {
  const r = await loadScenario(opus, "S3");
  const typed = r.requests.find((row) => row.action === "typeText");
  assert.ok(typed && isString(typed.requestId));
  const requests = clone(r.requests);
  const held = requests.find((row) => row.action === "typeText");
  assert.ok(held);
  // Fake-daemon log shape: the held act is logged when answered (cancelled), then the cancel row.
  held.response = {
    ok: false,
    error: { code: "cancelled", message: "Request was cancelled", effectPossible: true },
    result: { outcome: "partial", stoppedAt: 1, reason: "cancelled" },
  };
  const cancel = { acknowledged: true, state: "stopped", stoppedAt: 1, effectPossible: true };
  requests.splice(requests.indexOf(held) + 1, 0, {
    id: "cancel_1",
    cmd: "cancel",
    target: typed.requestId,
    ack: cancel,
  });
  return withActResult(
    { ...r, requests },
    {
      tool: "act_ui",
      status: "cancelled",
      execution: {
        strategy: "act",
        outcome: "partial",
        effectPossible: true,
        stoppedAt: 1,
        cancel,
      },
      error: { code: "cancelled", message: "Daemon command 'act' timed out after 15000ms." },
      config: { headless: false },
    },
  );
}

test("S4 passes when the transport cancels the held typeText and the result reports it", async () => {
  const checked = scoreScenario("S4", await cancelledReplay());
  assert.deepEqual(checked.errors, []);
  assert.equal(checked.verdict, "PASS");
});

test("S4 fails without a stopped ack, with an act after cancel, or without a cancelled result", async () => {
  const r = await cancelledReplay();
  const cancelRow = (rows: RecordValue[]): RecordValue => {
    const found = rows.find((row) => row.cmd === "cancel");
    assert.ok(found);
    return found;
  };
  const unacked = clone(r.requests);
  cancelRow(unacked).ack = { acknowledged: false, state: "unacknowledged" };
  assert.match(scoreScenario("S4", { ...r, requests: unacked }).verdict, /not acknowledged/);
  const wrongTarget = clone(r.requests);
  cancelRow(wrongTarget).target = "other";
  assert.match(scoreScenario("S4", { ...r, requests: wrongTarget }).verdict, /missing cancel/);
  const after = clone(r.requests);
  after.splice(after.indexOf(cancelRow(after)) + 1, 0, { id: "req_x", cmd: "act", requestId: "x" });
  assert.match(scoreScenario("S4", { ...r, requests: after }).verdict, /act request after cancel/);
  const noStop = withActResult(r, {
    tool: "act_ui",
    status: "cancelled",
    execution: { strategy: "act", outcome: "partial", effectPossible: true },
    error: { code: "cancelled", message: "cancelled" },
    config: { headless: false },
  });
  assert.match(scoreScenario("S4", noStop).verdict, /not reported as cancelled with stoppedAt/);
  const answered = clone(r.requests);
  const act = answered.find((row) => row.action === "typeText");
  assert.ok(act);
  act.response = { ok: true, result: { outcome: "worked" } };
  assert.match(
    scoreScenario("S4", { ...r, requests: answered }).verdict,
    /typeText act not answered as cancelled/,
  );
});

test("S3 fails when the logged helper reply is not didnt", async () => {
  const r = await loadScenario(opus, "S3");
  const requests = clone(r.requests);
  const typed = requests.find((row) => row.action === "typeText");
  assert.ok(typed);
  typed.response = { ok: true, result: { outcome: "didnt" } };
  assert.equal(scoreScenario("S3", { ...r, requests }).verdict, "PASS");
  typed.response = { ok: true, result: { outcome: "worked" } };
  assert.match(scoreScenario("S3", { ...r, requests }).verdict, /did not answer the typeText/);
});

/**
 * Synthetic S6 evidence on the S3 fixture, in the fake daemon's s6-grant shape: a background click
 * on custom-1 refused with effectPossible:false, then one granted foreground retry that worked.
 */
async function grantReplay(): Promise<ScenarioReplay> {
  const r = await loadScenario(opus, "S3");
  const requests = clone(r.requests);
  const typed = requests.find((row) => row.action === "typeText");
  assert.ok(typed);
  const click = { ...typed, action: "click", target: { ref: "custom-1" } };
  const background = {
    ...click,
    id: "req_bg",
    requestId: "bg",
    policy: "background",
    response: {
      ok: false,
      error: { code: "foreground_required", message: "needs foreground", effectPossible: false },
    },
  };
  const foreground = {
    ...click,
    id: "req_fg",
    requestId: "fg",
    policy: "foreground",
    foregroundGrant: true,
    response: { ok: true, result: { outcome: "worked" } },
  };
  requests.splice(requests.indexOf(typed), 1, background, foreground);
  const step = {
    strategy: "act",
    outcome: "worked",
    deliveryPolicy: "foreground",
    foregroundGrant: true,
    requestId: "fg",
    escalatedToForeground: true,
  };
  return withActResult(
    { ...r, requests },
    {
      tool: "act_ui",
      execution: { strategy: "act", outcome: "worked", steps: [step], escalatedToForeground: true },
      config: { headless: false },
    },
  );
}

test("S6 passes on one refused background attempt and one granted foreground retry", async () => {
  const r = await grantReplay();
  assert.equal(scoreScenario("S6", r).verdict, "PASS");
  const ungranted = clone(r.requests);
  const retry = ungranted.find((row) => row.policy === "foreground");
  assert.ok(retry);
  retry.foregroundGrant = false;
  assert.match(
    scoreScenario("S6", { ...r, requests: ungranted }).verdict,
    /expected one granted foreground act/,
  );
  const direct = clone(r.requests).filter((row) => row.requestId !== "bg");
  assert.match(
    scoreScenario("S6", { ...r, requests: direct }).verdict,
    /not preceded by a refused background attempt/,
  );
  const possible = clone(r.requests);
  const first = possible.find((row) => row.requestId === "bg");
  assert.ok(first && isJsonObject(first.response) && isJsonObject(first.response.error));
  first.response.error.effectPossible = true;
  assert.match(
    scoreScenario("S6", { ...r, requests: possible }).verdict,
    /not preceded by a refused background attempt/,
  );
});

/** The grant replay with the granted HID retry answered `unknown`, as the updated fake does. */
function withGrantOutcome(
  r: ScenarioReplay,
  response: string,
  trace: string,
  step: string = trace,
): ScenarioReplay {
  const requests = clone(r.requests);
  const retry = requests.find((row) => row.requestId === "fg");
  assert.ok(retry);
  retry.response = {
    ok: true,
    result: {
      outcome: response,
      performed: { delivery: "hid", grounding: "coordinates", activated: true },
    },
  };
  return withActResult(
    { ...r, requests },
    {
      tool: "act_ui",
      execution: {
        strategy: "act",
        outcome: trace,
        escalatedToForeground: true,
        steps: [
          {
            strategy: "act",
            outcome: step,
            deliveryPolicy: "foreground",
            foregroundGrant: true,
            requestId: "fg",
            escalatedToForeground: true,
          },
        ],
      },
      config: { headless: false },
    },
  );
}

test("S6 accepts an unknown granted HID retry only when the escalated trace reports unknown", async () => {
  const r = await grantReplay();
  const unknown = withGrantOutcome(r, "unknown", "unknown");
  assert.equal(scoreScenario("S6", unknown).verdict, "PASS");
  assert.match(
    scoreScenario("S6", withGrantOutcome(r, "unknown", "worked")).verdict,
    /granted foreground act fg trace disagrees with the wire reply: step outcome "worked" != "unknown", trace outcome "worked" != "unknown"/,
  );
  assert.match(
    scoreScenario("S6", withGrantOutcome(r, "unknown", "unknown", "worked")).verdict,
    /step outcome "worked" != "unknown"/,
  );
  assert.match(
    scoreScenario("S6", withGrantOutcome(r, "didnt", "didnt")).verdict,
    /granted foreground act answered didnt/,
  );
  const requests = clone(unknown.requests);
  const retry = requests.find((row) => row.requestId === "fg");
  assert.ok(retry);
  retry.requestId = "other";
  assert.match(
    scoreScenario("S6", { ...unknown, requests }).verdict,
    /expected one trace step for the granted foreground act other, got 0/,
  );
});

test("fixtures carry no thinking blocks, signatures or streaming deltas", async () => {
  const base = fileURLToPath(new URL("./fixtures/", import.meta.url));
  const files = (await readdir(base, { recursive: true })).filter((name) =>
    /\.(events|session)\.jsonl$/.test(name),
  );
  assert.ok(files.length >= 10);
  for (const name of files) {
    const raw = await readFile(`${base}${name}`, "utf8");
    assert.doesNotMatch(raw, /"type":"(thinking|redacted_thinking|message_update)"/, name);
    assert.doesNotMatch(raw, /[Ss]ignature"|encrypted_content/, name);
  }
});
