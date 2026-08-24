import assert from "node:assert/strict";
import test from "node:test";
import {
  BATCHING_REMINDER_MARKER,
  BATCHING_REMINDER_MARKER_END,
  BATCHING_STREAK_FIRST_NUDGE,
  createBatchingAdvice,
  formatBatchingAdvice,
  isSingleCallBlock,
} from "../.pi/packages/choco-pi-codex/src/tools/code-mode/batching-advice.ts";

test("single-call blocks are detected; composing blocks are not", () => {
  assert.equal(isSingleCallBlock('const r = await tools.exec_command({cmd: "ls"});'), true);
  assert.equal(isSingleCallBlock("tools.view_image({path: 'a.png'});"), true);
  assert.equal(isSingleCallBlock("text('no tools at all');"), true);
  assert.equal(
    isSingleCallBlock(
      'const [a, b] = await Promise.all([tools.exec_command({cmd: "a"}), tools.exec_command({cmd: "b"})]);',
    ),
    false,
    "Promise.all batching resets",
  );
  assert.equal(
    isSingleCallBlock(
      'const a = await tools.exec_command({cmd: "a"}); const b = await tools.exec_command({cmd: "b"});',
    ),
    false,
    "multiple tools calls reset",
  );
  assert.equal(
    isSingleCallBlock('for (const f of files) { await tools.exec_command({cmd: "cat " + f}); }'),
    false,
    "loop fan-out resets",
  );
});

test("the nudge fires at the streak threshold and on the interval thereafter", () => {
  const advice = createBatchingAdvice();
  const single = 'await tools.exec_command({cmd: "ls"});';
  for (let i = 1; i < BATCHING_STREAK_FIRST_NUDGE; i++) {
    assert.equal(advice.record(single), undefined, "no nudge below threshold (streak " + i + ")");
  }
  const first = advice.record(single);
  assert.ok(first?.includes(String(BATCHING_STREAK_FIRST_NUDGE)), "nudge names the streak");
  for (let i = 1; i < 10; i++) {
    assert.equal(advice.record(single), undefined, "no nag between nudges");
  }
  const repeat = advice.record(single);
  assert.ok(repeat?.includes(String(BATCHING_STREAK_FIRST_NUDGE + 10)), "repeat nudge at interval");
});

test("a composing block resets the streak", () => {
  const advice = createBatchingAdvice();
  const single = 'await tools.exec_command({cmd: "ls"});';
  for (let i = 0; i < BATCHING_STREAK_FIRST_NUDGE - 1; i++) advice.record(single);
  assert.equal(advice.streak, BATCHING_STREAK_FIRST_NUDGE - 1);
  const batch =
    'await Promise.all([tools.exec_command({cmd: "a"}), tools.exec_command({cmd: "b"})]);';
  assert.equal(advice.record(batch), undefined);
  assert.equal(advice.streak, 0);
});

test("the advisory is a system-reminder block, not prose framing", () => {
  const text = formatBatchingAdvice(7);
  assert.ok(text.startsWith(BATCHING_REMINDER_MARKER), "opens with the reminder tag");
  assert.ok(text.endsWith(BATCHING_REMINDER_MARKER_END), "closes with the reminder tag");
  assert.ok(!text.includes("[harness note]"), "no bracketed harness prefix");
  assert.ok(text.includes("7"), "names the streak");
  assert.ok(text.includes("Promise.all"), "references the batching primitive");
  assert.ok(text.includes("Composition"), "references the injected guidance section");
});

test("a due nudge is delivered as the tagged block", () => {
  const advice = createBatchingAdvice();
  const single = 'await tools.exec_command({cmd: "ls"});';
  let delivered: string | undefined;
  for (let i = 0; i < BATCHING_STREAK_FIRST_NUDGE; i++) delivered = advice.record(single);
  assert.ok(delivered?.startsWith(BATCHING_REMINDER_MARKER));
  assert.ok(delivered?.trimEnd().endsWith(BATCHING_REMINDER_MARKER_END));
});
