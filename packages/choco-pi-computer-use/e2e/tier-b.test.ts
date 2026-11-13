import assert from "node:assert/strict";
import { access, appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isJsonObject, isString } from "../src/json.ts";
import type { RecordValue } from "./assertions.ts";
import {
  launchFixture,
  newFixtureRun,
  quitFixture,
  type FixtureRun,
  type LaunchDeps,
} from "./desktop.ts";
import type { FixtureBuild } from "./fixture/build.ts";
import { plan } from "./isolation.ts";
import { scoreTierB, type FixtureEvidence, type TierBInput } from "./tier-b.ts";

/** Synthetic fixture logs in FocusFixture.swift's shape; the Pi process spans 1000..9000. */
function fixture(target: RecordValue[], holder: RecordValue[] = []): FixtureEvidence {
  return {
    target: [{ event: "launched", ts: 900, pid: 42 }, ...target],
    holder: [{ event: "launched", ts: 500 }, { event: "appActive", ts: 510 }, ...holder],
    start: 1000,
    end: 9000,
    targetPid: 42,
  };
}
function quit(value: string, increments = 0, customHits = 0): RecordValue {
  return { event: "quitting", ts: 9500, length: value.length, value, increments, customHits };
}
function act(
  seq: number,
  action: string,
  response: RecordValue,
  extra: RecordValue = {},
): RecordValue {
  return {
    cmd: "act",
    origin: "pi",
    seq,
    at: 1000 + seq * 100,
    requestId: `r${seq}`,
    policy: "background",
    action,
    response,
    ...extra,
  };
}
const worked = (extra: RecordValue = {}): RecordValue => ({
  ok: true,
  result: { outcome: "worked", frontmostBefore: 7, frontmostAfter: 7, ...extra },
});
function input(partial: Partial<TierBInput>): TierBInput {
  return { requests: [], traces: [], results: [], noDispatch: false, ...partial };
}
/** A persisted act_ui toolResult message with the given text. */
function result(text: string): RecordValue {
  return { role: "toolResult", toolName: "act_ui", content: [{ type: "text", text }] };
}
const executed = "Executed 3 checked UI actions in CU Fixture Target — CU Fixture Target.";
const confirm = "; confirm it in the returned state before reporting success.";

test("S1 passes with the expected fixture state and an undisturbed holder", () => {
  const scored = scoreTierB(
    "S1",
    input({
      requests: [
        act(1, "click", worked()),
        act(2, "typeText", worked()),
        act(3, "press", worked()),
      ],
      fixture: fixture([{ event: "increment", ts: 1400, count: 1 }, quit("hello-e2e", 1, 0)]),
    }),
  );
  assert.deepEqual(scored.errors, []);
});

test("S1 tolerates an unverified Increment press but not unverified typing or a didnt", () => {
  const s1 = (text: string, value = "hello-e2e", increments = 1) =>
    scoreTierB(
      "S1",
      input({
        requests: [act(1, "click", worked()), act(2, "typeText", worked())],
        results: [result(text)],
        fixture: fixture([quit(value, increments, 0)]),
      }),
    );
  const pressed = s1(`${executed} Effect not verified for action 3 (press: unknown)${confirm}`);
  assert.deepEqual(pressed.errors, []);
  assert.deepEqual(pressed.notes.unverifiedEffects, [
    { index: 3, action: "press", outcome: "unknown" },
  ]);
  assert.deepEqual(
    s1(`${executed} Effect not verified for action 3 (click: unknown)${confirm}`).errors,
    [],
  );
  // The fixture log stays the proof: an unverified press with no increment still fails.
  assert.match(
    s1(
      `${executed} Effect not verified for action 3 (press: unknown)${confirm}`,
      "hello-e2e",
      0,
    ).errors.join(";"),
    /increments 0 != 1/,
  );
  assert.match(
    s1(
      `${executed} Effect not verified for action 2 (typeText: unknown), action 3 (press: unknown)${confirm}`,
    ).errors.join(";"),
    /unexpected unverified effect: action 2 \(typeText: unknown\)/,
  );
  assert.match(
    s1(`${executed} Effect not verified for action 3 (press: didnt)${confirm}`).errors.join(";"),
    /unexpected unverified effect: action 3 \(press: didnt\)/,
  );
  assert.match(
    s1(`${executed} Effect not verified for something else${confirm}`).errors.join(";"),
    /unparseable 'Effect not verified' text/,
  );
});

test("S1 fails when the holder resigns active or another app becomes frontmost", () => {
  const scored = scoreTierB(
    "S1",
    input({
      requests: [act(1, "typeText", worked())],
      fixture: fixture(
        [quit("hello-e2e", 1, 0)],
        [
          { event: "appInactive", ts: 2000 },
          { event: "frontmost", ts: 2001, bundleId: "com.choco-pi.FocusFixture" },
        ],
      ),
    }),
  );
  assert.match(scored.errors.join(";"), /holder disturbed: appInactive@2000, frontmost/);
});

test("S3 records the worked path and rejects a duplicated text", () => {
  const typed = act(1, "typeText", worked());
  const pass = scoreTierB(
    "S3",
    input({ requests: [typed], fixture: fixture([quit("hello-e2e")]) }),
  );
  assert.deepEqual(pass.errors, []);
  assert.equal(pass.notes.typingPath, "worked");
  const doubled = scoreTierB(
    "S3",
    input({ requests: [typed], fixture: fixture([quit("hello-e2ehello-e2e")]) }),
  );
  assert.match(doubled.errors.join(";"), /typeText worked but field is/);
});

test("S4 passes on a stopped harness cancel with no change after the ack", () => {
  const typed = act(1, "typeText", {
    ok: false,
    error: { code: "cancelled", effectPossible: true },
    result: { outcome: "partial", stoppedAt: 0 },
  });
  const cancel: RecordValue = {
    cmd: "cancel",
    origin: "harness",
    seq: 2,
    target: "r1",
    respondedAt: 4000,
    ack: { acknowledged: true, state: "stopped" },
  };
  const typing = [
    { event: "fieldValue", ts: 2000, length: 1 },
    { event: "fieldValue", ts: 3990, length: 200 },
  ];
  const pass = scoreTierB(
    "S4",
    input({ requests: [typed, cancel], fixture: fixture([...typing, quit("x".repeat(200))]) }),
  );
  assert.deepEqual(pass.errors, []);
  assert.equal(pass.inconclusive, undefined);
  assert.equal(pass.notes.cancel?.origin, "harness");
  const late = scoreTierB(
    "S4",
    input({
      requests: [typed, cancel],
      fixture: fixture([...typing, { event: "fieldValue", ts: 4051, length: 201 }, quit("x")]),
    }),
  );
  assert.match(late.errors.join(";"), /changed 1 time\(s\) after the cancel ack/);
  const nothingTyped = scoreTierB(
    "S4",
    input({ requests: [typed, cancel], fixture: fixture([quit("")]) }),
  );
  assert.equal(nothingTyped.inconclusive, "no_effect_observed");
});

test("S5 fails when the stale act is delivered and the fixture changes", () => {
  const scored = scoreTierB(
    "S5",
    input({
      requests: [act(20, "setText", worked())],
      intervention: { ok: true, requestedAt: 2500, at: 2510 },
      fixture: fixture([{ event: "fieldValue", ts: 3200, length: 5 }, quit("stale")]),
    }),
  );
  assert.match(
    scored.errors.join(";"),
    /stale action not refused as a window-frame stale_look: 1 act\(s\).*1 answered ok/,
  );
  assert.match(scored.errors.join(";"), /fixture changed after the mutation \(fieldValue\)/);
});

test("S5 passes only on one helper window-frame stale_look refusal", () => {
  const frame = "Window frame changed since look look_3; observe again";
  const s5 = (requests: RecordValue[], results: RecordValue[] = []) =>
    scoreTierB(
      "S5",
      input({
        requests,
        results,
        intervention: { ok: true, requestedAt: 2500, at: 2510 },
        fixture: fixture([quit("")]),
      }),
    );
  const refused = (message: string, effectPossible = false) =>
    act(20, "setText", {
      ok: false,
      error: { code: "stale_look", message, effectPossible },
    });
  const pass = s5([refused(frame)]);
  assert.deepEqual(pass.errors, []);
  assert.equal(pass.notes.staleRefusal, "stale_look");
  const refusal = /stale action not refused as a window-frame stale_look/;
  // A generation stale_look is not the frame check; neither is an effect-possible refusal.
  assert.match(s5([refused("Look id 'look_3' is no longer available")]).errors.join(";"), refusal);
  assert.match(s5([refused(frame, true)]).errors.join(";"), refusal);
  assert.match(
    s5([refused(frame), { ...refused(frame), seq: 21, at: 3200 }]).errors.join(";"),
    refusal,
  );
  // No act at all is not a pass in tier B: only the helper can see an out-of-band resize.
  assert.match(
    s5([], [result('observation_refresh_required: {"reason":"stale"}')]).errors.join(";"),
    /0 act\(s\) after the mutation/,
  );
});

test("S6 requires a refused background act, then one granted act that hits the custom view", () => {
  const target = { ref: "e141" };
  const refused = act(
    1,
    "click",
    {
      ok: false,
      error: {
        code: "foreground_required",
        message:
          "target has no accessibility action; pointer delivery needs a host foreground grant",
        effectPossible: false,
      },
    },
    { target },
  );
  const granted = (outcome = "unknown", extra: RecordValue = {}) =>
    act(
      2,
      "click",
      { ok: true, result: { outcome, frontmostBefore: 7, frontmostAfter: 42 } },
      { policy: "foreground", foregroundGrant: true, target, ...extra },
    );
  const hit = { event: "customHit", ts: 1250, count: 1 };
  const holder = [{ event: "appInactive", ts: 1260 }];
  const s6 = (
    requests: RecordValue[],
    target: RecordValue[] = [hit, quit("", 0, 1)],
    held = holder,
  ) => scoreS6(requests, target, held);

  const pass = s6([refused, granted()]);
  assert.deepEqual(pass.errors, []);
  assert.equal(pass.notes.grantedOutcome, "unknown");
  assert.deepEqual(s6([refused, granted("worked")]).errors, []);
  // Pre-fix B1 shape: an ungranted pid click answered unknown and no grant path.
  const b1 = act(1, "click", { ok: true, result: { outcome: "unknown" } });
  assert.match(
    s6([b1], [quit("", 0, 0)]).errors.join(";"),
    /expected one granted foreground act, got 0/,
  );
  const sequence = /expected a refused background act on the same target then the granted act/;
  assert.match(s6([granted()]).errors.join(";"), sequence);
  assert.match(s6([b1, granted()]).errors.join(";"), sequence);
  assert.match(
    s6([refused, granted("unknown", { target: { ref: "e7" } })]).errors.join(";"),
    sequence,
  );
  assert.match(
    s6([
      {
        ...refused,
        response: { ok: false, error: { code: "foreground_required", effectPossible: true } },
      },
      granted(),
    ]).errors.join(";"),
    sequence,
  );
  assert.match(
    s6([refused, granted("didnt")]).errors.join(";"),
    /granted foreground act answered didnt/,
  );
  // unknown needs the fixture proof: no hit, a second hit, or a hit before the granted act fail.
  assert.match(
    s6([refused, granted()], [quit("", 0, 0)]).errors.join(";"),
    /custom-view hits 0 != 1/,
  );
  assert.match(
    s6([refused, granted()], [{ ...hit, ts: 1150 }, quit("", 0, 1)]).errors.join(";"),
    /custom-view hit before the granted foreground act/,
  );
  assert.match(
    s6([refused, granted()], undefined, [{ event: "appInactive", ts: 1150 }]).errors.join(";"),
    /holder resigned active before the granted foreground act/,
  );
  assert.match(
    s6([refused, granted()], undefined, []).errors.join(";"),
    /holder never resigned active/,
  );
});

/** The granted act's (`r2`) execution trace; `step` overrides the step's fields. */
function grantTrace(outcome: string, step: RecordValue = {}): RecordValue {
  return {
    strategy: "act",
    outcome,
    escalatedToForeground: true,
    steps: [
      {
        strategy: "act",
        requestId: "r2",
        outcome,
        deliveryPolicy: "foreground",
        foregroundGrant: true,
        escalatedToForeground: true,
        ...step,
      },
    ],
  };
}
function wireOutcome(row: RecordValue): string {
  const result = isJsonObject(row.response) ? row.response.result : undefined;
  const outcome = isJsonObject(result) ? result.outcome : undefined;
  return isString(outcome) ? outcome : "missing";
}
/** S6 scoring; by default the trace agrees with every granted act's wire outcome. */
function scoreS6(
  requests: RecordValue[],
  target: RecordValue[],
  held: RecordValue[],
  traces: RecordValue[] = requests
    .filter((row) => row.policy === "foreground")
    .map((row) => grantTrace(wireOutcome(row))),
) {
  return scoreTierB("S6", input({ requests, traces, fixture: fixture(target, held) }));
}
const s6Refused = act(
  1,
  "click",
  { ok: false, error: { code: "foreground_required", effectPossible: false } },
  { target: { ref: "e141" } },
);
/** The granted act `r2`, logged at 1200. */
const s6Granted = (outcome = "unknown") =>
  act(
    2,
    "click",
    { ok: true, result: { outcome, frontmostBefore: 7, frontmostAfter: 42 } },
    { policy: "foreground", foregroundGrant: true, target: { ref: "e141" } },
  );
const s6Target = [{ event: "customHit", ts: 1250, count: 1 }, quit("", 0, 1)];

test("S6 fails on any holder input and on holder focus loss before the granted act", () => {
  const requests = [s6Refused, s6Granted()];
  const afterGrant = [
    { event: "appInactive", ts: 1260 },
    { event: "windowResignKey", ts: 1261 },
  ];
  assert.deepEqual(scoreS6(requests, s6Target, afterGrant).errors, []);
  // Reviewer reproduction: a holder keyDown at 1150, before the granted act at 1200.
  assert.match(
    scoreS6(requests, s6Target, [{ event: "keyDown", ts: 1150 }, ...afterGrant]).errors.join(";"),
    /holder received input: keyDown@1150/,
  );
  // Holder input fails at any time, also after the granted act and outside the Pi window.
  assert.match(
    scoreS6(requests, s6Target, [...afterGrant, { event: "keyDown", ts: 1300 }]).errors.join(";"),
    /holder received input: keyDown@1300/,
  );
  assert.match(
    scoreS6(requests, s6Target, [...afterGrant, { event: "fieldValue", ts: 9800 }]).errors.join(
      ";",
    ),
    /holder received input: fieldValue@9800/,
  );
  assert.match(
    scoreS6(requests, s6Target, [
      { event: "windowResignKey", ts: 1150 },
      ...afterGrant,
    ]).errors.join(";"),
    /holder resigned active before the granted foreground act: windowResignKey@1150/,
  );
  const untimed = { ...s6Granted(), at: undefined };
  assert.match(
    scoreS6([s6Refused, untimed], s6Target, afterGrant).errors.join(";"),
    /granted foreground act has no timestamp.*holder resigned active before the granted/,
  );
});

test("S6 cross-checks the granted act's trace step against the wire reply", () => {
  const requests = [s6Refused, s6Granted()];
  const held = [{ event: "appInactive", ts: 1260 }];
  const s6 = (traces: RecordValue[]) => scoreS6(requests, s6Target, held, traces).errors.join(";");
  assert.equal(s6([grantTrace("unknown")]), "");
  // Reviewer reproduction: wire `unknown`, trace `worked` without escalation.
  assert.match(
    s6([grantTrace("worked", { escalatedToForeground: false })]),
    /granted foreground act r2 trace disagrees with the wire reply: step escalatedToForeground false != true, step outcome "worked" != "unknown", trace outcome "worked" != "unknown"/,
  );
  assert.match(
    s6([grantTrace("unknown", { deliveryPolicy: "background" })]),
    /step deliveryPolicy "background" != "foreground"/,
  );
  assert.match(
    s6([grantTrace("unknown", { foregroundGrant: undefined })]),
    /step foregroundGrant null != true/,
  );
  assert.match(s6([]), /expected one trace step for the granted foreground act r2, got 0/);
  assert.match(
    s6([grantTrace("unknown"), grantTrace("unknown")]),
    /expected one trace step for the granted foreground act r2, got 2/,
  );
  assert.match(
    s6([grantTrace("unknown", { requestId: "r1" })]),
    /expected one trace step for the granted foreground act r2, got 0/,
  );
});

test("each attempt gets its own fixture directory", () => {
  const dirs = [0, 1].map(
    (attempt) =>
      plan("/tmp/cu-e2e-test", "b", "m/x", "S6", "", "", "/bin/pi", undefined, attempt).fixtureDir,
  );
  assert.notEqual(dirs[0], dirs[1]);
  assert.match(dirs[0], /S6\.attempt-0\.[0-9a-f-]{36}\.fixture$/);
  assert.match(dirs[1], /S6\.attempt-1\.[0-9a-f-]{36}\.fixture$/);
  // A second plan for the same attempt index still differs by session.
  assert.notEqual(
    plan("/tmp/cu-e2e-test", "b", "m/x", "S6", "", "", "/bin/pi", undefined, 0).fixtureDir,
    dirs[0],
  );
});

const build: FixtureBuild = { hash: "h", dir: "/nowhere", target: "/T.app", holder: "/H.app" };

/** A fake `open`: appends each scripted row to the CU_FIXTURE_LOG named in the arguments. */
function fakeLaunch(
  script: (app: string) => { code: number; rows: RecordValue[] },
  quits: FixtureRun[],
): LaunchDeps {
  return {
    open: async (args) => {
      const log = args.find((arg) => arg.startsWith("CU_FIXTURE_LOG="))?.slice(15) ?? "";
      const { code, rows } = script(args.at(-1) ?? "");
      for (const row of rows) await appendFile(log, `${JSON.stringify(row)}\n`);
      return { code, stderr: code ? "boom" : "" };
    },
    quit: async (run) => {
      quits.push({ ...run, pids: { ...run.pids } });
      return [`quit ${JSON.stringify(run.pids)}`];
    },
    launchMs: 150,
    activeMs: 150,
    settleMs: 0,
  };
}
const holderUp = [
  { event: "launched", ts: 1, pid: 4242 },
  { event: "appActive", ts: 2, pid: 4242 },
];

test("a partial fixture launch stops the started holder and reports the cleanup", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "cu-e2e-launch-"));
  try {
    // Target launch fails after the holder started.
    const quits: FixtureRun[] = [];
    const run = newFixtureRun(join(scratch, "a0.fixture"));
    const failed = launchFixture(
      build,
      run,
      fakeLaunch(
        (app) => (app === build.holder ? { code: 0, rows: holderUp } : { code: 1, rows: [] }),
        quits,
      ),
    );
    await assert.rejects(failed, {
      name: "FixtureLaunchError",
      message: /FIXTURE_LAUNCH target: boom/,
      defects: ['quit {"holder":4242}'],
    });
    assert.equal(quits.length, 1);
    // The caller's run object names the holder, so its own cleanup sees the partial launch.
    assert.deepEqual(run.pids, { holder: 4242 });

    // Target opened but never logged launched: still one cleanup of the holder.
    const silent: FixtureRun[] = [];
    await assert.rejects(
      launchFixture(
        build,
        newFixtureRun(join(scratch, "a1.fixture")),
        fakeLaunch(
          (app) => (app === build.holder ? { code: 0, rows: holderUp } : { code: 0, rows: [] }),
          silent,
        ),
      ),
      /FIXTURE_LAUNCH target did not start/,
    );
    assert.deepEqual(
      silent.map((run) => run.pids),
      [{ holder: 4242 }],
    );

    // Holder started but never became active.
    const inactive: FixtureRun[] = [];
    await assert.rejects(
      launchFixture(
        build,
        newFixtureRun(join(scratch, "a2.fixture")),
        fakeLaunch(() => ({ code: 0, rows: [holderUp[0]] }), inactive),
      ),
      /FIXTURE_LAUNCH holder never became active/,
    );
    assert.deepEqual(
      inactive.map((run) => run.pids),
      [{ holder: 4242 }],
    );

    // A full launch records both pids and cleans nothing up.
    const none: FixtureRun[] = [];
    const ok = newFixtureRun(join(scratch, "a3.fixture"));
    await launchFixture(
      build,
      ok,
      fakeLaunch(
        (app) =>
          app === build.holder
            ? { code: 0, rows: holderUp }
            : { code: 0, rows: [{ event: "launched", ts: 3, pid: 4343 }] },
        none,
      ),
    );
    assert.deepEqual(ok.pids, { holder: 4242, target: 4343 });
    assert.equal(none.length, 0);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("launchFixture refuses a reused directory and quitFixture runs once", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "cu-e2e-launch-"));
  try {
    // An earlier attempt's directory: launching into it would inherit its .cu-quit and rows.
    const dir = join(scratch, "S6.attempt-0.x.fixture");
    await mkdir(dir);
    const opened: string[] = [];
    const quits: FixtureRun[] = [];
    const reused = newFixtureRun(dir);
    await assert.rejects(
      launchFixture(build, reused, {
        ...fakeLaunch(() => ({ code: 0, rows: [] }), quits),
        open: async (args) => {
          opened.push(args.join(" "));
          return { code: 0, stderr: "" };
        },
      }),
      { name: "FixtureLaunchError", message: /FIXTURE_LAUNCH directory/, defects: [] },
    );
    assert.deepEqual(opened, []);
    assert.equal(quits.length, 0);
    // The refused run is closed: the caller's cleanup never writes .cu-quit into the old dir.
    assert.equal(reused.closed, true);
    assert.deepEqual(await quitFixture(reused), []);
    await assert.rejects(access(join(dir, ".cu-quit")));

    // A run with no started instance quits cleanly once; later calls are no-ops.
    const idle = newFixtureRun(join(scratch, "idle"));
    await mkdir(idle.dir);
    assert.deepEqual(await quitFixture(idle), []);
    await access(join(idle.dir, ".cu-quit"));
    assert.equal(idle.closed, true);
    await rm(join(idle.dir, ".cu-quit"));
    assert.deepEqual(await quitFixture(idle), []);
    await assert.rejects(access(join(idle.dir, ".cu-quit")));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
