import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  readAgentParseRecord,
  verdictRecordsDirectory,
} from "../../../extensions/lib/verdict-blocks.ts";
import { recordVerdict, verdictLineMissingFrom } from "../src/verdict-record.ts";
import { claimsVerdictText, fence, REVIEW_TEXT, WORK_TASK } from "./fixtures/verdict-blocks.ts";

async function scratch(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-verdict-record-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const base = (scratchDir: string) => ({
  agentId: "agent-1",
  agentType: "reviewer",
  workTask: WORK_TASK,
  scratchDir,
  status: "completed",
});

test("a reviewer's valid block is parsed, written, and summarized", async (t) => {
  const dir = await scratch(t);
  const outcome = await recordVerdict({ ...base(dir), text: REVIEW_TEXT });
  const path = join(dir, "verdicts", WORK_TASK, "agent-1.json");
  assert.equal(outcome.status, "parsed");
  assert.equal(
    outcome.line,
    `Verdict record: parsed (FINDINGS, 2 findings, 1 candidate) -> ${path}`,
  );
  const read = await readAgentParseRecord(verdictRecordsDirectory(dir, WORK_TASK), "agent-1");
  assert.equal(read.status, "valid");
  if (read.status !== "valid") return;
  assert.equal(read.value.status, "parsed");
  assert.equal(read.value.review?.verdict, "FINDINGS");
});

test("no block is missing; a malformed block is invalid; both say unrecorded", async (t) => {
  const dir = await scratch(t);
  const missing = await recordVerdict({ ...base(dir), text: "All good, no issues." });
  assert.equal(missing.status, "missing");
  assert.match(
    missing.line,
    /^Verdict record: MISSING - the final message has no choco-pi-review block; this review is unrecorded and must not be reported as clean -> /,
  );
  const invalid = await recordVerdict({
    ...base(dir),
    agentId: "agent-2",
    text: fence("choco-pi-review", "{ not json"),
  });
  assert.equal(invalid.status, "invalid");
  assert.match(
    invalid.line,
    /^Verdict record: INVALID - the choco-pi-review block is not valid JSON/,
  );
  const recordsDir = verdictRecordsDirectory(dir, WORK_TASK);
  const records = await Promise.all([
    readAgentParseRecord(recordsDir, "agent-1"),
    readAgentParseRecord(recordsDir, "agent-2"),
  ]);
  assert.deepEqual(
    records.map((read) => (read.status === "valid" ? read.value.status : read.status)),
    ["missing", "invalid"],
  );
});

test("a stopped, failed or aborted run is missing even with a valid block", async (t) => {
  const dir = await scratch(t);
  for (const [index, status] of ["stopped", "error", "aborted"].entries()) {
    const outcome = await recordVerdict({
      ...base(dir),
      agentId: `agent-${index}`,
      text: REVIEW_TEXT,
      status,
      error: "Stopped by user request.",
    });
    assert.equal(outcome.status, "missing", status);
    assert.match(outcome.line, new RegExp(`MISSING - the run ended ${status}: Stopped by user`));
    const read = await readAgentParseRecord(
      verdictRecordsDirectory(dir, WORK_TASK),
      `agent-${index}`,
    );
    assert.equal(read.status === "valid" && read.value.status, "missing");
  }
  const empty = await recordVerdict({ ...base(dir), agentId: "agent-e", text: "  " });
  assert.match(empty.line, /MISSING - the run produced no final message/);
});

test("a verifier's claims verdict is parsed, written, and summarized", async (t) => {
  const dir = await scratch(t);
  const outcome = await recordVerdict({
    ...base(dir),
    agentId: "verifier-1",
    agentType: "verifier",
    text: claimsVerdictText(),
  });
  assert.equal(outcome.status, "parsed");
  assert.match(
    outcome.line,
    /^Verdict record: parsed \(claims, 2 claims: 1 CONFIRMED, 1 UNPROVEN\) -> /,
  );
  const read = await readAgentParseRecord(verdictRecordsDirectory(dir, WORK_TASK), "verifier-1");
  assert.equal(read.status === "valid" && read.value.verdict?.claims[0]?.outcome, "CONFIRMED");
});

test("a verifier reads only choco-pi-verdict, and a foreign work task is invalid", async (t) => {
  const dir = await scratch(t);
  const reviewOnly = await recordVerdict({
    ...base(dir),
    agentType: "verifier",
    text: REVIEW_TEXT,
  });
  assert.match(
    reviewOnly.line,
    /MISSING - the final message has no choco-pi-verdict block; this verification is unrecorded/,
  );
  const foreign = await recordVerdict({
    ...base(dir),
    agentType: "verifier",
    text: claimsVerdictText("other-task"),
  });
  assert.equal(foreign.status, "invalid");
  assert.match(foreign.line, /workTask other-task does not match demo-task/);
});

test("an unwritable records directory yields a FAILED line and never throws", async (t) => {
  const dir = await scratch(t);
  await writeFile(join(dir, "verdicts"), "a file where the directory should be");
  const outcome = await recordVerdict({ ...base(dir), text: REVIEW_TEXT });
  assert.equal(outcome.status, "failed");
  assert.match(
    outcome.line,
    /^Verdict record: FAILED - could not write the record \(.+\); this review is unrecorded and must not be reported as clean$/,
  );
  const relative = await recordVerdict({ ...base("relative/dir"), text: REVIEW_TEXT });
  assert.equal(relative.status, "failed");
  const badTask = await recordVerdict({ ...base(dir), workTask: "../escape", text: REVIEW_TEXT });
  assert.equal(badTask.status, "failed");
});

test("a notification repeats the line only when its preview lost it", () => {
  const record = {
    verdictRecord: "Verdict record: parsed (NO_FINDINGS) -> /x.json",
    verdictRecordedGeneration: 2,
    terminalResultGeneration: 2,
    resultGeneration: 2,
  };
  assert.equal(verdictLineMissingFrom(record, `long text...\n${record.verdictRecord}`), undefined);
  assert.equal(verdictLineMissingFrom(record, "long text...(truncated"), record.verdictRecord);
  assert.equal(
    verdictLineMissingFrom({ ...record, verdictRecordedGeneration: 1 }, "x"),
    undefined,
    "an earlier generation's line is never shown",
  );
});
