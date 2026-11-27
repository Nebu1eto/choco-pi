import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../../src/json.ts";
import {
  diagnosticsBlock,
  focusState,
  foreignActivation,
  holderInput,
  isMainHelper,
  scoreCancel,
  scoreControl,
  scoreJudgement,
  scoreJudgementControl,
  scoreMisdelivery,
  scoreParallel,
  scorePolicyBlocked,
  scorePolicyControl,
  scoreRestore,
} from "./score.ts";

const window = { from: 1_000, to: 2_000 };
const row = (event: string, ts: number, fields: JsonObject = {}): JsonObject => ({
  event,
  ts,
  ...fields,
});
const refusal = (effectPossible?: boolean): JsonObject => {
  const error: JsonObject = {
    code: "activation_failed",
    message: "target did not become frontmost",
  };
  if (effectPossible !== undefined) error.effectPossible = effectPossible;
  return { ok: false, error };
};
const answered = (outcome: string): JsonObject => ({ ok: true, result: { outcome } });

test("holderInput counts keyDown and mouseDown only inside the window", () => {
  const rows = [
    row("keyDown", 999),
    row("keyDown", 1_000),
    row("mouseDown", 2_000),
    row("mouseDown", 2_001),
    row("appInactive", 1_500),
  ];
  assert.deepEqual(
    holderInput(rows, window).map((entry) => entry.ts),
    [1_000, 2_000],
  );
});

const notAcquired = (effectPossible: boolean): JsonObject => ({
  ok: false,
  error: {
    code: "foreground_not_acquired",
    message: "target is not the frontmost app; no input was sent",
    effectPossible,
    inputSent: false,
    activationAttempted: true,
  },
});
const lost = (inputSent: boolean): JsonObject => ({
  ok: false,
  result: { outcome: "partial", stoppedAt: 0, charactersSent: 4 },
  error: {
    code: "foreground_lost",
    message: "focus lost after 4 characters",
    effectPossible: true,
    inputSent,
    charactersSent: 4,
  },
});
const misdelivery = (fields: Partial<Parameters<typeof scoreMisdelivery>[0]> = {}) =>
  scoreMisdelivery({
    holder: [row("appInactive", 1_100), row("appActive", 1_110), row("keyDown", 500)],
    target: [],
    window,
    reply: refusal(false),
    effectObserved: false,
    effect: "fieldValue safety-probe",
    ...fields,
  });

test("misdelivery: any holder keyDown or mouseDown fails whatever the helper answered", () => {
  const typed = [row("fieldValue", 1_300, { value: "safety-probe" })];
  for (const reply of [
    refusal(false),
    notAcquired(true),
    lost(true),
    answered("worked"),
    answered("unknown"),
  ]) {
    const leaked = misdelivery({
      holder: [row("keyDown", 1_200, { window: "main" })],
      reply,
      target: typed,
      effectObserved: true,
    });
    assert.equal(leaked.verdict, "FAIL");
    assert.match(
      leaked.failures[0] ?? "",
      /holder received 1 input event\(s\): keyDown\(main\)@1200/,
    );
  }
  assert.equal(
    misdelivery({ holder: [row("mouseDown", 1_300)], reply: notAcquired(false) }).verdict,
    "FAIL",
  );
  assert.equal(
    misdelivery({ holder: [row("keyDown", 2_500)] }).verdict,
    "PASS",
    "holder input after the window does not count",
  );
  assert.equal(misdelivery({ reply: undefined }).verdict, "FAIL");
});

test("misdelivery branch 1: a refusal that reports no input sent is SAFE", () => {
  const legacy = misdelivery({ reply: refusal(false) });
  assert.equal(legacy.verdict, "PASS");
  assert.equal(legacy.notes.path, "refused_no_effect");
  assert.equal(legacy.notes.answer, "error:activation_failed");

  for (const effectPossible of [true, false]) {
    const fresh = misdelivery({ reply: notAcquired(effectPossible) });
    assert.equal(
      fresh.verdict,
      "PASS",
      `foreground_not_acquired with effectPossible ${String(effectPossible)}`,
    );
    assert.equal(fresh.notes.path, "not_acquired");
  }

  for (const effectPossible of [true, undefined]) {
    const vague = misdelivery({ reply: refusal(effectPossible) });
    assert.equal(
      vague.verdict,
      "FAIL",
      `legacy refusal with effectPossible ${String(effectPossible)}`,
    );
    assert.match(vague.failures[0] ?? "", /does not report that no input was sent/);
  }
  const sentAnyway = {
    ok: false,
    error: { code: "foreground_not_acquired", effectPossible: true, inputSent: true },
  };
  assert.equal(
    misdelivery({ reply: sentAnyway }).verdict,
    "FAIL",
    "foreground_not_acquired must say inputSent:false",
  );
  const otherCode = {
    ok: false,
    error: { code: "activation_failed", effectPossible: true, inputSent: false },
  };
  assert.equal(
    misdelivery({ reply: otherCode }).verdict,
    "FAIL",
    "inputSent:false counts only with foreground_not_acquired or occluded_target",
  );
  const occluded = misdelivery({
    reply: {
      ok: false,
      error: { code: "occluded_target", effectPossible: true, inputSent: false },
    },
  });
  assert.equal(occluded.verdict, "PASS", "an occluded refusal before any posted event is safe");
  assert.equal(occluded.notes.path, "occluded_refused");
  for (const inputSent of [true, undefined]) {
    const error: JsonObject = { code: "occluded_target", effectPossible: true };
    if (inputSent !== undefined) error.inputSent = inputSent;
    assert.equal(
      misdelivery({ reply: { ok: false, error } }).verdict,
      "FAIL",
      `occluded_target with inputSent ${String(inputSent)}`,
    );
  }
  const occludedContradicted = misdelivery({
    reply: {
      ok: false,
      error: { code: "occluded_target", effectPossible: true, inputSent: false },
    },
    target: [row("customHit", 1_300)],
  });
  assert.equal(occludedContradicted.verdict, "FAIL");

  const contradicted = misdelivery({
    reply: notAcquired(true),
    target: [row("fieldValue", 1_300, { value: "s" })],
  });
  assert.equal(contradicted.verdict, "FAIL");
  assert.match(
    contradicted.failures[0] ?? "",
    /claims no input was sent but the target logged fieldValue@1300/,
  );
  assert.equal(
    misdelivery({ reply: refusal(false), target: [row("customHit", 1_300)] }).verdict,
    "FAIL",
  );
});

test("misdelivery: foreground_lost is SAFE only without holder input and records charactersSent", () => {
  const partial = misdelivery({
    reply: lost(true),
    target: [row("fieldValue", 1_300, { value: "safe" })],
  });
  assert.equal(partial.verdict, "PASS");
  assert.equal(partial.notes.path, "foreground_lost");
  assert.equal(partial.notes.charactersSent, 4);
  assert.equal(partial.notes.answer, "error:foreground_lost");
  assert.deepEqual(partial.notes.targetInput, ["fieldValue@1300"]);

  assert.equal(misdelivery({ reply: lost(true), holder: [row("keyDown", 1_400)] }).verdict, "FAIL");
  assert.match(
    misdelivery({ reply: lost(false) }).failures[0] ?? "",
    /does not state inputSent:true/,
  );
});

test("misdelivery branch 2: delivered input is SAFE only when the target recorded the intended effect", () => {
  const typed = [row("fieldValue", 1_300, { value: "safety-probe" })];
  for (const outcome of ["worked", "unknown"]) {
    const delivered = misdelivery({
      reply: answered(outcome),
      target: typed,
      effectObserved: true,
    });
    assert.equal(delivered.verdict, "PASS", outcome);
    assert.equal(delivered.notes.path, "delivered");
    assert.equal(delivered.notes.answer, outcome);
    assert.deepEqual(delivered.notes.reply, answered(outcome));
  }
  const worked = misdelivery({ reply: answered("worked"), target: [], effectObserved: false });
  assert.equal(worked.verdict, "FAIL");
  assert.match(
    worked.failures[0] ?? "",
    /delivered \(outcome worked\) but the target recorded no intended effect \(fieldValue safety-probe\)/,
  );
  assert.equal(misdelivery({ reply: answered("unknown"), effectObserved: false }).verdict, "FAIL");
  const partialText = misdelivery({
    reply: answered("worked"),
    target: [row("fieldValue", 1_300, { value: "safety" })],
    effectObserved: false,
  });
  assert.equal(
    partialText.verdict,
    "FAIL",
    "partial text in the target is not the intended effect",
  );
  const contradicted = misdelivery({
    reply: answered("didnt"),
    target: typed,
    effectObserved: true,
  });
  assert.match(
    contradicted.failures[0] ?? "",
    /answered didnt but the target recorded the intended effect/,
  );
});

test("control passes when the granted action succeeds, takes effect, and spares the holder", () => {
  const base = { holder: [row("appInactive", 1_100)], window, effect: "one customHit" };
  assert.equal(
    scoreControl({ ...base, reply: answered("unknown"), effectObserved: true }).verdict,
    "PASS",
  );
  assert.equal(
    scoreControl({ ...base, reply: answered("worked"), effectObserved: true }).verdict,
    "PASS",
  );
  const refused = scoreControl({ ...base, reply: refusal(false), effectObserved: false });
  assert.equal(refused.verdict, "FAIL");
  assert.match(
    refused.failures[0] ?? "",
    /granted foreground action was refused: activation_failed/,
  );
  const noEffect = scoreControl({ ...base, reply: answered("worked"), effectObserved: false });
  assert.deepEqual(noEffect.failures, ["fixture recorded no effect (one customHit)"]);
  assert.equal(
    scoreControl({ ...base, reply: answered("didnt"), effectObserved: true }).verdict,
    "FAIL",
  );
  const leaked = scoreControl({
    ...base,
    holder: [row("keyDown", 1_500)],
    reply: answered("worked"),
    effectObserved: true,
  });
  assert.equal(leaked.verdict, "FAIL");
});

test("focusState replays activation and key-window rows in timestamp order", () => {
  const rows = [
    row("windowKey", 10, { window: "second" }),
    row("appActive", 5),
    row("windowResignKey", 20, { window: "second" }),
    row("appInactive", 21),
    row("windowKey", 30, { window: "main" }),
    row("appActive", 31),
    row("windowResignKey", 40, { window: "other" }),
  ];
  assert.deepEqual(focusState(rows), { active: true, key: "main" });
  assert.deepEqual(focusState(rows, 25), { active: false, key: undefined });
  assert.deepEqual(focusState(rows, 15), { active: true, key: "second" });
});

test("restore passes only when the originally key window is key again in an active app", () => {
  const left = [
    row("windowKey", 900, { window: "second" }),
    row("appActive", 901),
    row("windowResignKey", 1_100, { window: "second" }),
    row("appInactive", 1_101),
  ];
  const input = { expectedWindow: "second", window, actionEffect: true, focusLeft: true };
  const back = [...left, row("windowKey", 1_500, { window: "second" }), row("appActive", 1_501)];
  assert.equal(scoreRestore({ ...input, user: back }).verdict, "PASS");

  const wrong = [...left, row("windowKey", 1_500, { window: "main" }), row("appActive", 1_501)];
  const failed = scoreRestore({ ...input, user: wrong });
  assert.equal(failed.verdict, "FAIL");
  assert.equal(failed.failures[0], "key window is main, expected second");

  const inactive = scoreRestore({ ...input, user: left });
  assert.match(inactive.failures[0] ?? "", /not active after the call/);

  const late = [...left, row("windowKey", 2_500, { window: "second" }), row("appActive", 2_501)];
  assert.equal(
    scoreRestore({ ...input, user: late }).verdict,
    "FAIL",
    "rows after the window do not count",
  );

  assert.equal(
    scoreRestore({ ...input, user: back, actionEffect: false }).verdict,
    "INCONCLUSIVE(action_not_delivered)",
  );
  assert.equal(
    scoreRestore({ ...input, user: back, focusLeft: false }).verdict,
    "INCONCLUSIVE(focus_never_left)",
  );
  assert.equal(
    scoreRestore({ ...input, user: wrong, actionEffect: false }).verdict,
    "FAIL",
    "a wrong final focus fails even without delivery",
  );
});

test("parallel passes with both hits, the holder's key window back, and no user_switched", () => {
  const holder = [
    row("windowKey", 900, { window: "second" }),
    row("appActive", 900),
    row("appInactive", 1_100),
    row("windowResignKey", 1_100, { window: "second" }),
    row("windowKey", 1_800, { window: "second" }),
    row("appActive", 1_800),
  ];
  const hit = [row("customHit", 1_300, { count: 1 })];
  const restored = { execution: { focusRestored: true, focusRestoreReason: "restored" } };
  const input = {
    holder,
    expectedWindow: "second",
    targets: [
      { label: "a", rows: hit },
      { label: "b", rows: hit },
    ],
    calls: [
      { label: "a", details: restored },
      { label: "b", details: restored },
    ],
    window,
  };
  const pass = scoreParallel(input);
  assert.equal(pass.verdict, "PASS");
  assert.deepEqual(pass.notes.hits, { a: 1, b: 1 });

  const switched = { execution: { steps: [{ focusRestoreReason: "user_switched" }] } };
  const claimed = scoreParallel({
    ...input,
    calls: [
      { label: "a", details: restored },
      { label: "b", details: switched },
    ],
  });
  assert.deepEqual(claimed.failures, ["act_ui b reported user_switched"]);

  const double = scoreParallel({
    ...input,
    targets: [
      { label: "a", rows: [...hit, row("customHit", 1_400)] },
      { label: "b", rows: [] },
    ],
  });
  assert.deepEqual(double.failures, [
    "target a custom view hit 2 time(s), expected 1",
    "target b custom view hit 0 time(s), expected 1",
  ]);

  const targetFront = scoreParallel({ ...input, holder: holder.slice(0, 4) });
  assert.match(targetFront.failures[0] ?? "", /holder is not frontmost/);

  const errored = scoreParallel({
    ...input,
    calls: [
      { label: "a", details: restored },
      { label: "b", error: "boom" },
    ],
  });
  assert.deepEqual(errored.failures, ["act_ui b failed: boom"]);
});

test("judgement fails a worked answer for a view that did not react", () => {
  const quiet = [row("noiseStarted", 500)];
  const seen = { observed: true, reason: "noise_not_running" };
  const failed = scoreJudgement({
    reply: answered("worked"),
    target: quiet,
    window,
    interference: seen,
  });
  assert.equal(failed.verdict, "FAIL");
  assert.equal(
    failed.failures[0],
    "helper answered worked although the clicked view did not react",
  );

  const pass = scoreJudgement({ reply: refusal(false), target: quiet, window, interference: seen });
  assert.equal(pass.verdict, "PASS");
  assert.equal(
    scoreJudgement({ reply: answered("didnt"), target: quiet, window, interference: seen }).verdict,
    "PASS",
  );

  const reacted = scoreJudgement({
    reply: answered("worked"),
    target: [row("fieldValue", 1_200)],
    window,
    interference: seen,
  });
  assert.equal(reacted.verdict, "INCONCLUSIVE(target_reacted)");

  const unseen = { observed: false, reason: "activation_not_observed" };
  assert.equal(
    scoreJudgement({ reply: refusal(false), target: quiet, window, interference: unseen }).verdict,
    "INCONCLUSIVE(activation_not_observed)",
  );
  assert.equal(
    scoreJudgement({ reply: answered("worked"), target: quiet, window, interference: unseen })
      .verdict,
    "FAIL",
  );
  assert.equal(
    scoreJudgement({ reply: undefined, target: quiet, window, interference: seen }).verdict,
    "FAIL",
  );
});

test("judgement control only fails answers that contradict the fixture", () => {
  const hit = [row("customHit", 1_200)];
  assert.equal(
    scoreJudgementControl({ reply: answered("worked"), target: hit, window }).verdict,
    "PASS",
  );
  assert.equal(
    scoreJudgementControl({ reply: answered("unknown"), target: hit, window }).verdict,
    "PASS",
  );
  assert.equal(
    scoreJudgementControl({ reply: refusal(false), target: [], window }).verdict,
    "PASS",
  );
  assert.equal(
    scoreJudgementControl({ reply: refusal(true), target: hit, window }).verdict,
    "PASS",
  );
  assert.match(
    scoreJudgementControl({ reply: refusal(false), target: hit, window }).failures[0] ?? "",
    /effectPossible:false but the fixture recorded 1 hit/,
  );
  assert.match(
    scoreJudgementControl({ reply: answered("didnt"), target: hit, window }).failures[0] ?? "",
    /answered didnt/,
  );
  assert.match(
    scoreJudgementControl({ reply: answered("worked"), target: [], window }).failures[0] ?? "",
    /no hit/,
  );
  assert.equal(
    scoreJudgementControl({ reply: answered("worked"), target: [row("customHit", 2_500)], window })
      .verdict,
    "FAIL",
    "a hit outside the window does not count",
  );
});

test("cancel residual compares fixture input with the ack time plus the margin", () => {
  const ack = { acknowledged: true, state: "stopped", stoppedAt: 3 };
  const typed = [row("fieldValue", 1_100, { length: 5 }), row("fieldValue", 1_200, { length: 10 })];
  const base = {
    window,
    ack,
    ackAt: 1_300,
    actReply: { ok: false, error: { code: "cancelled" } },
    marginMs: 50,
  };
  const pass = scoreCancel({
    ...base,
    target: [...typed, row("fieldValue", 1_350, { length: 11 })],
  });
  assert.equal(pass.verdict, "PASS", "a row exactly at ack + margin is tolerated");
  assert.equal(pass.notes.lengthAtAck, 10);

  const late = scoreCancel({
    ...base,
    target: [...typed, row("fieldValue", 1_351, { length: 11 })],
  });
  assert.equal(late.verdict, "FAIL");
  assert.match(late.failures[0] ?? "", /fieldValue@1351 \(\+51 ms\)/);

  assert.equal(scoreCancel({ ...base, target: [] }).verdict, "INCONCLUSIVE(no_effect_observed)");
  assert.equal(
    scoreCancel({ ...base, target: [row("customHit", 1_400)] }).verdict,
    "FAIL",
    "input after the ack fails even with nothing typed before it",
  );
  assert.equal(
    scoreCancel({ ...base, ack: { acknowledged: true, state: "completed" }, target: typed })
      .verdict,
    "INCONCLUSIVE(cancel_state_completed)",
  );
  assert.deepEqual(
    scoreCancel({ ...base, ack: { acknowledged: false, state: "unacknowledged" }, target: typed })
      .failures,
    ["cancel was not acknowledged"],
  );
  assert.equal(scoreCancel({ ...base, ack: undefined, target: typed }).verdict, "FAIL");
});

test("diagnosticsBlock accepts any reported protocol version but requires the dev app and grants", () => {
  const reply = (fields: JsonObject): JsonObject => ({
    ok: true,
    result: {
      protocolVersion: 7,
      accessibility: true,
      screenRecording: true,
      executablePath: "/x",
      ...fields,
    },
  });
  const app = "/private/tmp/s/pi-computer-use.app";
  const inside = `${app}/Contents/MacOS/bridge`;
  assert.equal(
    diagnosticsBlock({ reply: reply({}), executableReal: inside, helperAppReal: app }),
    undefined,
  );
  assert.equal(
    diagnosticsBlock({
      reply: reply({ protocolVersion: 8 }),
      executableReal: inside,
      helperAppReal: `${app}/`,
    }),
    undefined,
  );
  assert.match(
    diagnosticsBlock({
      reply: reply({}),
      executableReal: "/Users/u/Applications/pi-computer-use.app/Contents/MacOS/bridge",
      helperAppReal: app,
    }) ?? "",
    /^executable_outside_helper_app/,
  );
  assert.match(
    diagnosticsBlock({
      reply: reply({}),
      executableReal: `${app}-other/Contents/MacOS/bridge`,
      helperAppReal: app,
    }) ?? "",
    /^executable_outside_helper_app/,
  );
  assert.equal(
    diagnosticsBlock({
      reply: reply({ accessibility: false }),
      executableReal: inside,
      helperAppReal: app,
    }),
    "accessibility_not_granted",
  );
  assert.equal(
    diagnosticsBlock({
      reply: reply({ screenRecording: false }),
      executableReal: inside,
      helperAppReal: app,
    }),
    "screen_recording_not_granted",
  );
  assert.equal(
    diagnosticsBlock({
      reply: reply({ protocolVersion: "7" }),
      executableReal: inside,
      helperAppReal: app,
    }),
    "no_protocol_version",
  );
  assert.match(
    diagnosticsBlock({ reply: undefined, error: "ECONNREFUSED", helperAppReal: app }) ?? "",
    /^daemon_unreachable: ECONNREFUSED/,
  );
});

test("isMainHelper refuses the main helper apps and socket only", () => {
  const home = "/Users/u";
  assert.equal(
    isMainHelper("/Users/u/Applications/pi-computer-use.app", "/tmp/s/bridge.sock", home),
    true,
  );
  assert.equal(
    isMainHelper("/Applications/pi-computer-use.app/", "/tmp/s/bridge.sock", home),
    true,
  );
  assert.equal(
    isMainHelper(
      "/tmp/s/pi-computer-use.app",
      "/Users/u/Library/Caches/pi-computer-use/bridge.sock",
      home,
    ),
    true,
  );
  assert.equal(isMainHelper("/tmp/s/pi-computer-use.app", "/tmp/s/bridge.sock", home), false);
});

test("foreignActivation counts only an activation while the act was in flight", () => {
  const during = foreignActivation([row("appActive", 900), row("appActive", 1_150)], 1_000, 1_400);
  assert.deepEqual(during, { observed: true, reason: "activation_during_act", activatedAt: 1_150 });
  assert.deepEqual(foreignActivation([row("appActive", 900)], 1_000, 1_400), {
    observed: false,
    reason: "activation_not_observed",
  });
  assert.deepEqual(foreignActivation([row("selfActivate", 1_100)], 1_000, 1_400), {
    observed: false,
    reason: "activation_not_observed",
  });
  assert.deepEqual(foreignActivation([row("appActive", 1_500)], 1_000, 1_400), {
    observed: false,
    reason: "activation_after_reply",
    activatedAt: 1_500,
  });
  const decided = scoreJudgement({
    reply: { ok: false, error: { code: "foreground_required", effectPossible: false } },
    target: [],
    window,
    interference: during,
  });
  assert.equal(decided.verdict, "PASS");
  const fooled = scoreJudgement({
    reply: answered("worked"),
    target: [],
    window,
    interference: during,
  });
  assert.equal(fooled.verdict, "FAIL");
});

const blocked = (inputSent?: boolean, effectPossible: boolean | undefined = false): JsonObject => {
  const error: JsonObject = { code: "app_blocked", message: "app_blocked: refused" };
  if (effectPossible !== undefined) error.effectPossible = effectPossible;
  if (inputSent !== undefined) error.inputSent = inputSent;
  return { ok: false, error };
};

test("scorePolicyBlocked passes only app_blocked refusals with no fixture effect", () => {
  const safe = [
    { label: "look_by_bundle", cmd: "look" as const, reply: blocked() },
    { label: "act_by_pid", cmd: "act" as const, reply: blocked(false) },
  ];
  const quiet = [row("launched", 500), row("customHit", 2_500)];
  assert.equal(scorePolicyBlocked({ replies: safe, target: quiet, window }).verdict, "PASS");

  const observed = scorePolicyBlocked({
    replies: [
      {
        label: "look_by_bundle",
        cmd: "look",
        reply: { ok: true, result: { lookId: "look_1" } },
      },
    ],
    target: quiet,
    window,
  });
  assert.equal(observed.verdict, "FAIL");
  assert.match(observed.failures[0] ?? "", /look_by_bundle: helper answered ok/);

  const wrongCode = scorePolicyBlocked({
    replies: [{ label: "act_by_pid", cmd: "act", reply: refusal(false) }],
    target: quiet,
    window,
  });
  assert.match(wrongCode.failures[0] ?? "", /activation_failed instead of app_blocked/);

  const noInputFlag = scorePolicyBlocked({
    replies: [{ label: "act_by_pid", cmd: "act", reply: blocked(undefined) }],
    target: quiet,
    window,
  });
  assert.match(noInputFlag.failures[0] ?? "", /without inputSent:false/);

  const maybeEffect = scorePolicyBlocked({
    replies: [{ label: "look_by_pid", cmd: "look", reply: blocked(undefined, true) }],
    target: quiet,
    window,
  });
  assert.match(maybeEffect.failures[0] ?? "", /without effectPossible:false/);

  const missing = scorePolicyBlocked({
    replies: [{ label: "act_by_bundle", cmd: "act", reply: undefined }],
    target: quiet,
    window,
  });
  assert.match(missing.failures[0] ?? "", /no reply/);

  const hit = scorePolicyBlocked({ replies: safe, target: [row("customHit", 1_200)], window });
  assert.equal(hit.verdict, "FAIL");
  assert.match(hit.failures[0] ?? "", /fixture logged input: customHit@1200/);

  const activated = scorePolicyBlocked({
    replies: safe,
    target: [row("appActive", 1_300, { window: "main" })],
    window,
  });
  assert.match(activated.failures[0] ?? "", /fixture was activated: appActive\(main\)@1300/);
});

test("scorePolicyControl requires an observation, a delivered press, and exactly one increment", () => {
  const lookOk: JsonObject = { ok: true, result: { lookId: "look_2" } };
  const hitOnce = [row("increment", 1_200)];
  assert.equal(
    scorePolicyControl({ look: lookOk, act: answered("worked"), target: hitOnce, window }).verdict,
    "PASS",
  );
  assert.equal(
    scorePolicyControl({ look: lookOk, act: answered("unknown"), target: hitOnce, window }).verdict,
    "PASS",
  );
  const refused = scorePolicyControl({ look: blocked(), act: undefined, target: [], window });
  assert.equal(refused.verdict, "FAIL");
  assert.match(refused.failures[0] ?? "", /not answered with an observation: error:app_blocked/);
  const notDelivered = scorePolicyControl({
    look: lookOk,
    act: blocked(false),
    target: [],
    window,
  });
  assert.match(notDelivered.failures[0] ?? "", /not delivered: error:app_blocked/);
  const didnt = scorePolicyControl({
    look: lookOk,
    act: answered("didnt"),
    target: hitOnce,
    window,
  });
  assert.equal(didnt.verdict, "FAIL");
  const noHit = scorePolicyControl({ look: lookOk, act: answered("worked"), target: [], window });
  assert.match(noHit.failures[0] ?? "", /recorded 0 increment/);
  const twoHits = scorePolicyControl({
    look: lookOk,
    act: answered("worked"),
    target: [row("increment", 1_200), row("increment", 1_300)],
    window,
  });
  assert.match(twoHits.failures[0] ?? "", /recorded 2 increment/);
});
