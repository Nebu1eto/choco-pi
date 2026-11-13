import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  verdictRecordsDirectory,
  writeAgentParseRecord,
  type AgentParseRecord,
  type ReviewFinding,
} from "../.pi/extensions/lib/verdict-blocks.ts";
import { readRecords, type RecordsReader } from "../.pi/extensions/lib/changes/findings.ts";
import { file, flush, harness, hunk, textBody, until } from "./diff-actions-fakes.ts";

const REVIEWED_AT = "2026-01-01T00:00:00.000Z";
const REVIEWED_MS = Date.parse(REVIEWED_AT);

function finding(
  id: string,
  path: string,
  severity: ReviewFinding["severity"],
  kind: ReviewFinding["class"],
  startLine?: number,
): ReviewFinding {
  const value: ReviewFinding = {
    id,
    class: kind,
    severity,
    path,
    invariant: `${id} invariant`,
    evidence: "code_path",
    reproduction: "",
  };
  if (startLine !== undefined) value.startLine = startLine;
  return value;
}

function reviewRecord(
  agentId: string,
  workTask: string,
  completedAt: string,
  findings: ReviewFinding[],
): AgentParseRecord {
  return {
    schema: 1,
    agentId,
    agentType: "reviewer",
    workTask,
    completedAt,
    status: "parsed",
    review: { schema: 1, verdict: "FINDINGS", bundleDigest: "sha256:abc", findings },
  };
}

async function fixtures(): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "diff-findings-"));
  const a = verdictRecordsDirectory(scratch, "wt-a");
  await writeAgentParseRecord(
    a,
    reviewRecord("rev-old", "wt-a", "2025-12-01T00:00:00.000Z", [
      finding("OLD1", "src/a.ts", "high", "finding", 3),
    ]),
  );
  await writeAgentParseRecord(
    a,
    reviewRecord("rev-new", "wt-a", REVIEWED_AT, [
      finding("F1", "src/a.ts", "high", "finding", 4),
      finding("C1", "src/a.ts", "low", "candidate", 1),
      finding("F3", "./src/b.ts", "medium", "finding", 2),
      finding("F2", "gone.ts", "high", "finding", 9),
    ]),
  );
  await writeAgentParseRecord(a, {
    schema: 1,
    agentId: "ver-1",
    agentType: "verifier",
    workTask: "wt-a",
    completedAt: "2026-01-02T00:00:00.000Z",
    status: "parsed",
    verdict: {
      schema: 1,
      kind: "claims",
      workTask: "wt-a",
      snapshot: { head: "abc", clean: true },
      claims: [
        { id: "F1", outcome: "CONFIRMED" },
        { id: "C1", outcome: "REFUTED" },
      ],
    },
  });
  await writeFile(join(a, "broken.json"), "{not json", "utf8");
  await writeAgentParseRecord(verdictRecordsDirectory(scratch, "wt-b"), {
    schema: 1,
    agentId: "rev-b",
    agentType: "reviewer",
    workTask: "wt-b",
    completedAt: REVIEWED_AT,
    status: "missing",
    error: "the run ended stopped",
  });
  await writeAgentParseRecord(verdictRecordsDirectory(scratch, "wt-c"), {
    schema: 1,
    agentId: "rev-c",
    agentType: "reviewer",
    workTask: "wt-c",
    completedAt: REVIEWED_AT,
    status: "invalid",
    error: "the choco-pi-review block is not valid JSON",
  });
  return scratch;
}

type CountingReader = { reader: RecordsReader; calls: () => number };

function counting(reader: RecordsReader): CountingReader {
  let calls = 0;
  return {
    reader: async (scratch) => {
      calls += 1;
      return reader(scratch);
    },
    calls: () => calls,
  };
}

const A_HUNK = hunk("h-a", 3, [" keep", "+added", " tail"]);
const B_HUNK = hunk("h-b", 1, [" one", "+two"]);

test("findings render from recorded agents with candidates, claim outcomes, may-be-outdated, and unrecorded runs", async () => {
  const scratch = await fixtures();
  try {
    const h = harness({
      scratchDir: scratch,
      readRecords,
      changeTimes: new Map<string, number | null>([
        ["src/a.ts", REVIEWED_MS + 60_000],
        ["src/b.ts", REVIEWED_MS - 60_000],
      ]),
    });
    await h.fire("session_start", { reason: "startup" });
    await h.run("focus");
    const store = h.store();
    store.bodies.set("src/a.ts", textBody("src/a.ts", [A_HUNK]));
    store.bodies.set("src/b.ts", textBody("src/b.ts", [B_HUNK]));
    store.ready(1, [file("src/a.ts"), file("src/b.ts")]);
    await until(() => h.view().recorded.findings.length > 0, "records read");
    await h.run("refresh");
    await until(() => h.view().changeTimes.size === 2, "change times");

    const header = h.header();
    assert.match(
      header,
      /╰─ wt-a ⚑3 \?1 · wt-b unrecorded · wt-c unrecorded · 1 malformed record /,
    );
    let body = h.body();
    assert.match(body, /src\/a\.ts\s+⚑2/);
    assert.match(body, /src\/b\.ts\s+⚑1/);
    assert.doesNotMatch(body, /OLD1/, "only the newest review of a work task counts");
    assert.match(body, /Not in this diff:\n\s+⚑ high finding F2 gone\.ts L9: F2 invariant/);

    // f jumps to the first finding and expands its file.
    h.tui.input("f");
    await flush();
    body = h.body();
    const lines = body.split("\n");
    const candidate = lines.findIndex((line) => line.includes("candidate C1"));
    const header3 = lines.findIndex((line) => line.includes("@@ -3,2 +3,3 @@"));
    const line4 = lines.findIndex((line) => line.includes("4|added"));
    const f1 = lines.findIndex((line) => line.includes("finding F1"));
    assert.ok(
      candidate >= 0 && candidate < header3,
      "a finding before every hunk sits above the first one",
    );
    // Open by default: the heading row, then the whole record under it.
    assert.match(
      lines[candidate] ?? "",
      /▶ ▾ ⚑ low candidate C1 L1 \[REFUTED\] \(may be outdated\)/,
    );
    assert.match(lines[candidate + 1] ?? "", /^\s+C1 invariant$/);
    assert.equal(f1, line4 + 1, "a finding inside a hunk sits right after its line");
    assert.match(lines[f1] ?? "", /⚑ high finding F1 L4 \[CONFIRMED\] \(may be outdated\)/);
    assert.match(lines[f1 + 1] ?? "", /^\s+F1 invariant$/);
    assert.equal(h.view().selectedItem, "finding:wt-a/C1");

    h.tui.input("f");
    h.tui.input("f");
    await flush();
    assert.equal(h.view().selectedPath, "src/b.ts");
    body = h.body();
    const f3 = body.split("\n").find((line) => line.includes("finding F3")) ?? "";
    assert.match(f3, /▶ ▾ ⚑ medium finding F3 L2$/, "not outdated, focused");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a further edit after the review marks its findings may-be-outdated", async () => {
  const scratch = await fixtures();
  try {
    const times = new Map<string, number | null>([
      ["src/a.ts", REVIEWED_MS - 1],
      ["src/b.ts", REVIEWED_MS - 1],
    ]);
    const h = harness({ scratchDir: scratch, readRecords, changeTimes: times });
    await h.fire("session_start", { reason: "startup" });
    await h.run("focus");
    const store = h.store();
    store.bodies.set("src/a.ts", textBody("src/a.ts", [A_HUNK]));
    store.ready(1, [file("src/a.ts")]);
    await until(() => h.view().recorded.findings.length > 0, "records read");
    await h.run("refresh");
    await until(() => h.view().changeTimes.size === 1, "change times");
    h.tui.input("\r");
    await flush();
    assert.doesNotMatch(h.body(), /may be outdated/);
    times.set("src/a.ts", REVIEWED_MS + 5_000);
    store.ready(2, [file("src/a.ts")]);
    await until(() => /may be outdated/.test(h.body()), "outdated mark after the edit");
    assert.match(h.body(), /finding F1 L4 \[CONFIRMED\] \(may be outdated\)\n\s+F1 invariant/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("review records are not read before the pane is used, then on refresh and subagent events", async () => {
  const scratch = await fixtures();
  try {
    const reader = counting(readRecords);
    const h = harness({ scratchDir: scratch, readRecords: reader.reader });
    await h.fire("session_start", { reason: "startup" });
    await h.fire("tool_execution_end");
    await h.fire("turn_start");
    h.fakePi.events.emit("subagents:completed", { id: "x" });
    await flush();
    assert.equal(reader.calls(), 0, "no record read before first use");
    // The automatic-opening check may read the session source; it builds no view and reads no records.
    assert.equal(h.probe.session()?.view, undefined);
    await h.run("open");
    assert.equal(reader.calls(), 1, "first use reads once");
    h.fakePi.events.emit("subagents:completed", { id: "a" });
    h.fakePi.events.emit("subagents:failed", { id: "b" });
    h.fakePi.events.emit("subagents:stopped", { id: "c" });
    assert.equal(reader.calls(), 4);
    await h.run("refresh");
    assert.equal(reader.calls(), 5);
    // The only timer is the preference-write debounce; running every pending timer reads nothing.
    for (const timer of h.clock.timers.values()) timer.fn();
    h.clock.timers.clear();
    await flush();
    assert.equal(reader.calls(), 5, "no timer polls the records");
    await h.run("close");
    h.fakePi.events.emit("subagents:completed", { id: "d" });
    assert.equal(reader.calls(), 5, "a closed pane does not re-read");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("unreadable review records are reported in the header and never thrown", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "diff-findings-"));
  try {
    await writeFile(join(scratch, "verdicts"), "not a directory", "utf8");
    const h = harness({ scratchDir: scratch, readRecords });
    await h.fire("session_start", { reason: "startup" });
    await h.run("open");
    h.store().ready(1, []);
    await until(() => h.view().recorded.errors.length > 0, "error recorded");
    assert.match(h.header(), /╰─ 1 read error /);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
