// The review view's lifecycle: Finish, leaving and closing.
// The design these tests enumerate is in review-view.ts next to `close`.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import { parseGitDiff } from "../.pi/extensions/lib/changes/patch.ts";
import type {
  ReviewChat,
  ReviewChatContext,
  ReviewChatMessage,
} from "../.pi/extensions/review/core/ask.ts";
import { createReviewStore, targetKey } from "../.pi/extensions/review/core/store.ts";
import { buildCommentAnchor } from "../.pi/extensions/review/core/anchor.ts";
import { hunkWithExpandedContext } from "../.pi/extensions/review/core/expand.ts";
import { planReviewSubmission } from "../.pi/extensions/review/core/github.ts";
import type { DiffAssessment } from "../.pi/extensions/review/core/heuristics.ts";
import type {
  DiffModel,
  ExecRunner,
  ResolvedReviewConfig,
  ReviewComment,
  ReviewRecord,
} from "../.pi/extensions/review/core/types.ts";
import {
  openReviewView,
  type OpenReviewViewOptions,
  type ReviewViewHost,
  type ReviewViewResult,
} from "../.pi/extensions/review/ui/review-view.ts";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import { unavailableZentuiLoader } from "./zentui-build.ts";

initTheme("dark", false);
const NOW = "2026-03-03T02:00:00.000Z";
const STALE =
  "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx.";
const PATH = "src/a.ts";
const BASE_TEXT = `${Array.from({ length: 60 }, (_unused, index) => `line ${index + 1}`).join("\n")}\n`;

/** src/a.ts: an edit at line 5 (one more line after the refresh) and one at line 30. */
function modelOf(extraLineInFirstHunk: boolean, headSha = "head"): DiffModel {
  const first = extraLineInFirstHunk
    ? ["@@ -5,1 +5,2 @@", "-line 5", "+line 5 edited", "+line 5b inserted"]
    : ["@@ -5,1 +5,1 @@", "-line 5", "+line 5 edited"];
  const shift = extraLineInFirstHunk ? 1 : 0;
  const raw = [
    `diff --git a/${PATH} b/${PATH}`,
    `--- a/${PATH}`,
    `+++ b/${PATH}`,
    ...first,
    `@@ -30,1 +${30 + shift},1 @@`,
    "-line 30",
    "+line 30 edited",
    "",
  ].join("\n");
  return parseGitDiff(raw, "base", headSha);
}

const ASSESSMENTS: DiffAssessment = {
  files: [{ path: PATH, riskScore: 0, reasons: [], collapsed: false }],
  hunks: [],
  reviewOrder: [PATH],
};
const CONFIG: ResolvedReviewConfig = {
  editor: { command: ["true"], mode: "gui" },
  highlight: { enabled: false, maxFileBytes: 512_000, maxDiffLines: 20_000 },
  heuristics: { riskPatterns: [], collapsePatterns: [] },
};

function recordOf(model: DiffModel, comments: ReviewComment[] = []): ReviewRecord {
  return {
    version: 1,
    repoKey: "repo-key",
    target: { kind: "branch", base: "main" },
    baseSha: model.baseSha,
    headSha: model.headSha,
    cursor: { reviewedHunkIds: [], lastHeadSha: model.headSha },
    comments,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** A comment on RIGHT `line` of expanded context above the hunk at 30 (base lines 10..29 shown). */
function contextComment(model: DiffModel, line: number): ReviewComment {
  const hunk = model.files[0]!.hunks[1]!;
  const above = Array.from({ length: 20 }, (_unused, index) => ({
    kind: "context" as const,
    oldLine: 10 + index,
    newLine: 10 + index + (hunk.newStart - hunk.oldStart),
    text: `line ${10 + index}`,
  }));
  return {
    id: "ctx",
    path: PATH,
    side: "RIGHT",
    line,
    body: "About an unchanged line.",
    anchor: buildCommentAnchor(hunkWithExpandedContext(hunk, { above, below: [] }), "RIGHT", line),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** Promises the test settles itself, in the order it chooses. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

type Mounted = {
  key(data: string): void;
  screen(): string;
  render(): void;
  completions: ReviewViewResult[];
  editorTexts: string[];
  notices: string[];
  saves: Array<ReturnType<typeof deferred<void>> & { record: ReviewRecord }>;
  /** Every record given to the store, held or not. */
  savedRecords: ReviewRecord[];
  shutdown(): void;
  /** The next frame throws, as a broken theme would. */
  breakDrawing(): void;
  ended: Promise<RuntimeValue>;
};

/**
 * A real view on a host that records completions and editor writes. Saves wait
 * until the test settles them unless `autoSave` is set; `shutdown` ends the
 * custom UI from outside, as a session replacement does, and makes the host stale.
 */
async function mount(
  options: Partial<OpenReviewViewOptions> & {
    autoSave?: boolean;
    prompts?: Pick<ReviewViewHost, "select" | "input">;
  } = {},
): Promise<Mounted> {
  const completions: ReviewViewResult[] = [];
  const editorTexts: string[] = [];
  const notices: string[] = [];
  const saves: Mounted["saves"] = [];
  const savedRecords: ReviewRecord[] = [];
  const draw = { broken: false };
  const theme = reinterpretHostValue<Theme>({
    fg: (_color: string, text: string) => {
      if (draw.broken) throw new Error("draw broke");
      return text;
    },
    bold: (text: string) => text,
  });
  let stale = false;
  let component: Component | undefined;
  let end: ((value: RuntimeValue) => void) | undefined;
  let ready!: () => void;
  const mounted = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const host: ReviewViewHost = {
    custom: async (factory) => {
      const result = new Promise<RuntimeValue>((resolve) => {
        end = resolve;
      });
      const tui = reinterpretHostValue<Parameters<typeof factory>[0]>({
        terminal: { rows: 40 },
        requestRender: () => {},
        stop: () => {},
        start: () => {},
      });
      component = await factory(
        tui,
        theme,
        reinterpretHostValue<Parameters<typeof factory>[2]>({}),
        (value) => {
          if (stale) throw new Error(STALE);
          completions.push(reinterpretHostValue<ReviewViewResult>(value));
          end?.(value);
        },
      );
      ready();
      return reinterpretHostValue(await result);
    },
    input: (...args) => options.prompts?.input(...args) ?? Promise.resolve(undefined),
    notify: (message) => {
      if (stale) throw new Error(STALE);
      notices.push(message);
    },
    select: (...args) => options.prompts?.select(...args) ?? Promise.resolve(undefined),
    setEditorText: (text) => {
      if (stale) throw new Error(STALE);
      editorTexts.push(text);
    },
  };
  const autoSave = options.autoSave ?? false;
  const ended = openReviewView({
    host,
    store: {
      load: async () => undefined,
      list: async () => [],
      save: (record) => {
        savedRecords.push(structuredClone(record));
        if (autoSave) return Promise.resolve();
        const held = { ...deferred<void>(), record: structuredClone(record) };
        saves.push(held);
        return held.promise;
      },
    },
    styler: { fg: (_color, text) => text, inverse: (text) => text },
    model: modelOf(false),
    assessments: ASSESSMENTS,
    record: recordOf(modelOf(false)),
    config: CONFIG,
    reviewRoot: "/repo",
    now: () => NOW,
    zentuiLoader: unavailableZentuiLoader,
    ...options,
  });
  await mounted;
  const view = component;
  assert.ok(view);
  return {
    key: (data) => view.handleInput?.(data),
    screen: () => view.render(140).map(stripTerminalSequences).join("\n"),
    render: () => {
      view.render(140);
    },
    completions,
    editorTexts,
    notices,
    saves,
    savedRecords,
    shutdown: () => {
      stale = true;
      end?.(undefined);
    },
    breakDrawing: () => {
      draw.broken = true;
      view.render(140);
    },
    ended,
  };
}

/* ------------------------------------- leaving and finishing, every ordering */

type LifeEvent = "q1" | "q2" | "A" | "B" | "D";
type Outcomes = {
  /** Finish's save. */
  a: "resolve" | "reject";
  /** The save the first q starts. */
  b: "resolve" | "reject" | "timeout";
  /** A disruption: the next frame throws, or the session ends. */
  d: "render" | "shutdown";
};
const LEAVE_MS = 25;

/** A run's broken guarantee (if any) and how many events had been applied when the view closed. */
type RunResult = { problem: string | undefined; closedAfter: number | undefined };

/**
 * Every distinct ordering of `items` (`allowed` says which event may come
 * next). An ordering branches only while the view is open: once it has closed,
 * every remaining event lands on the closed guards (a save that no longer owns
 * the view, a key after close, a frame after close), so the remaining events
 * in one order stand for all their orders. Returns the problems and the runs.
 */
async function exploreOrderings<E extends string>(
  items: readonly E[],
  allowed: (next: E, prefix: readonly E[]) => boolean,
  run: (order: readonly E[]) => Promise<RunResult>,
): Promise<{ problems: string[]; runs: number }> {
  const problems: string[] = [];
  let runs = 0;
  const rest = (prefix: readonly E[]) => {
    const left = [...items];
    for (const event of prefix) left.splice(left.indexOf(event), 1);
    return left;
  };
  const complete = (prefix: readonly E[]): E[] => {
    const order = [...prefix];
    let left = rest(order);
    while (left.length > 0) {
      const next = left.find((event) => allowed(event, order)) ?? left[0]!;
      order.push(next);
      left = rest(order);
    }
    return order;
  };
  const visit = async (prefix: readonly E[], known?: RunResult): Promise<void> => {
    const order = complete(prefix);
    let result = known;
    if (!result) {
      runs += 1;
      result = await run(order);
      if (result.problem) problems.push(`${order.join(",")}: ${result.problem}`);
    }
    if (prefix.length === items.length) return;
    if (result.closedAfter !== undefined && result.closedAfter <= prefix.length) return;
    for (const next of rest(prefix)) {
      if (!allowed(next, prefix)) continue;
      const child = [...prefix, next];
      // The child whose completion is this very order needs no second run.
      const same = complete(child).join(",") === order.join(",");
      await visit(child, same ? result : undefined);
    }
  };
  await visit([]);
  return { problems, runs };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One run; a description of the broken guarantee, or undefined. */
async function runLifecycle(
  start: "open" | "finishing",
  order: readonly LifeEvent[],
  outcomes: Outcomes,
): Promise<RunResult> {
  const result = (problem: string | undefined): RunResult => ({ problem, closedAfter });
  let closedAfter: number | undefined;
  const view = await mount({ limits: { leaveSaveMs: LEAVE_MS } });
  let finishSave: Mounted["saves"][number] | undefined;
  let leaveSave: Mounted["saves"][number] | undefined;
  let leftOrDisrupted = false;
  let finishShouldComplete = false;
  let endedFromOutside = false;
  if (start === "finishing") {
    view.key("S");
    await flush();
    finishSave = view.saves[0];
    if (!finishSave) return result("Finish did not start its save");
  }
  for (const [index, event] of order.entries()) {
    if (event === "q1" || event === "q2") {
      const before = view.saves.length;
      view.key("q");
      if (event === "q1" && view.saves.length > before) leaveSave = view.saves[before];
      leftOrDisrupted = true;
    } else if (event === "A" && finishSave) {
      if (outcomes.a === "resolve") {
        if (!leftOrDisrupted) finishShouldComplete = true;
        finishSave.resolve();
      } else finishSave.reject(new Error("disk A"));
    } else if (event === "B" && leaveSave) {
      if (outcomes.b === "resolve") leaveSave.resolve();
      else if (outcomes.b === "reject") leaveSave.reject(new Error("disk B"));
      else await sleep(LEAVE_MS * 2);
    } else if (event === "D") {
      leftOrDisrupted = true;
      if (outcomes.d === "render") view.breakDrawing();
      else {
        if (view.completions.length === 0) endedFromOutside = true;
        view.shutdown();
      }
    }
    await flush();
    if (closedAfter === undefined && (view.completions.length > 0 || endedFromOutside)) {
      closedAfter = index + 1;
    }
  }
  // Whatever is still pending finishes now, late.
  for (const save of view.saves) save.resolve();
  await flush();
  const closes = view.completions.length + (endedFromOutside ? 1 : 0);
  if (closes !== 1) return result(`closed ${closes} times`);
  if (endedFromOutside && view.completions.length > 0) {
    return result("completed after the session ended");
  }
  const finished = view.completions[0]?.action === "finish";
  if (finished !== finishShouldComplete) {
    return result(`finish completed: ${finished}, expected ${finishShouldComplete}`);
  }
  if (view.editorTexts.length !== (finishShouldComplete ? 1 : 0)) {
    return result(`editor written ${view.editorTexts.length} times`);
  }
  return result(undefined);
}

for (const start of ["open", "finishing"] as const) {
  for (const disruption of ["none", "render", "shutdown"] as const) {
    test(`from ${start}, with disruption ${disruption}, every ordering of q, q again and the saves closes the review once and writes the editor only for an uncancelled Finish`, async (t) => {
      const rejections: string[] = [];
      const listener = (reason: RuntimeValue) => {
        rejections.push(reason instanceof Error ? reason.message : String(reason));
      };
      process.on("unhandledRejection", listener);
      t.after(() => {
        process.off("unhandledRejection", listener);
      });
      const items: LifeEvent[] = ["q1", "q2", "B"];
      if (start === "finishing") items.push("A");
      if (disruption !== "none") items.push("D");
      const failures: string[] = [];
      let runs = 0;
      for (const a of start === "finishing"
        ? (["resolve", "reject"] as const)
        : (["resolve"] as const)) {
        for (const b of ["resolve", "reject", "timeout"] as const) {
          const explored = await exploreOrderings(
            items,
            (next, prefix) => next !== "q2" || prefix.includes("q1"),
            (order) =>
              runLifecycle(start, order, {
                a,
                b,
                d: disruption === "shutdown" ? "shutdown" : "render",
              }),
          );
          runs += explored.runs;
          failures.push(...explored.problems.map((problem) => `A=${a} B=${b} ${problem}`));
        }
      }
      await flush();
      t.diagnostic(`${runs} runs`);
      assert.deepEqual(
        failures.slice(0, 5),
        [],
        `${failures.length} of ${runs} runs broke a guarantee`,
      );
      assert.deepEqual(rejections.slice(0, 3), []);
    });
  }
}

/* ---------------------------- Finish against pending reads, every ordering */

type Step = "refresh" | "context" | "reveal";
type StepOutcome = "completes" | "fails" | "timeout";
type WaitEvent = "start" | "settle" | "S" | "q";
const FINISH_MS = 30;

/** A hidden .env whose comment the record places at line 1; revealed, its text is at line 2. */
function hiddenScenario() {
  const revealed = parseGitDiff(
    [
      "diff --git a/.env b/.env",
      "--- a/.env",
      "+++ b/.env",
      "@@ -1,2 +1,3 @@",
      " A=1",
      "+TOKEN=new",
      " B=2",
      "",
    ].join("\n"),
    "base",
    "head",
  ).files[0]!;
  const model: DiffModel = {
    baseSha: "base",
    headSha: "head",
    files: [{ ...revealed, hunks: [] }],
    hidden: [".env"],
  };
  const comment: ReviewComment = {
    id: "env",
    path: ".env",
    side: "RIGHT",
    line: 1,
    body: "Rotate it.",
    anchor: buildCommentAnchor(revealed.hunks[0]!, "RIGHT", 2),
    createdAt: NOW,
    updatedAt: NOW,
  };
  return { model, comment, revealed };
}

/**
 * What the exported comment must be: "new" (its line after the step, not
 * marked), "old" (its line before, or marked), "marked" (outdated or
 * unconfirmed, whatever the number).
 */
type Expected = "new" | "old" | "marked";

function expectedExport(step: Step, order: readonly WaitEvent[], outcome: StepOutcome): Expected {
  let started = false;
  let landed: "completes" | "fails" | undefined;
  let waiting = false;
  const now = (): Expected => {
    if (!started) return "old";
    if (!landed) return "marked";
    if (landed === "completes") return "new";
    // A failure stays uncertain until a later read of the same kind succeeds:
    // the old model's number is never exported as current.
    return "marked";
  };
  for (const event of order) {
    if (event === "start") started = true;
    else if (event === "settle") {
      if (outcome !== "timeout") landed = outcome;
      // A Finish waiting for it exports now: what landed, a failure marked, a timeout marked.
      if (waiting) return outcome === "completes" ? "new" : "marked";
    } else if (event === "S") {
      if (started && !landed) waiting = true;
      else return now();
    } else if (event === "q") {
      return now();
    }
  }
  // A Finish still waiting gives up at its limit.
  return "marked";
}

async function runStep(
  step: Step,
  order: readonly WaitEvent[],
  outcome: StepOutcome,
): Promise<RunResult> {
  let closedAfter: number | undefined;
  const problem = await stepProblem(step, order, outcome, (applied) => {
    closedAfter ??= applied;
  });
  return { problem, closedAfter };
}

async function stepProblem(
  step: Step,
  order: readonly WaitEvent[],
  outcome: StepOutcome,
  closedAt: (applied: number) => void,
): Promise<string | undefined> {
  const first = modelOf(false);
  const moved = modelOf(true);
  const gate = deferred<void>();
  // Rejected in "fails" runs even when nothing read through it (the view closed first).
  gate.promise.catch(() => {});
  let lines = { old: 30, new: 31 };
  let options: Partial<OpenReviewViewOptions>;
  const readGates: Array<ReturnType<typeof deferred<void>>> = [];
  const reads = {
    hold: false,
    fail: false,
    pending: readGates,
  };
  const runner: ExecRunner = async () => {
    if (reads.fail) throw new Error("git show failed");
    if (reads.hold) {
      const wait = deferred<void>();
      reads.pending.push(wait);
      await wait.promise;
      if (reads.fail) throw new Error("git show failed");
    }
    return { stdout: BASE_TEXT, stderr: "", code: 0 };
  };
  if (step === "refresh") {
    const anchor = buildCommentAnchor(first.files[0]!.hunks[1]!, "RIGHT", 30);
    options = {
      model: first,
      record: recordOf(first, [
        {
          id: "c",
          path: PATH,
          side: "RIGHT",
          line: 30,
          body: "b",
          anchor,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]),
      reload: () => gate.promise.then(() => moved),
    };
  } else if (step === "context") {
    lines = { old: 20, new: 21 };
    options = {
      model: first,
      record: recordOf(first, [{ ...contextComment(first, 20), id: "c" }]),
      execRunner: runner,
      reload: async () => moved,
    };
  } else {
    const hidden = hiddenScenario();
    lines = { old: 1, new: 2 };
    options = {
      model: hidden.model,
      record: recordOf(hidden.model, [{ ...hidden.comment, id: "c" }]),
      revealFile: () => gate.promise.then(() => ({ file: hidden.revealed })),
    };
  }
  const view = await mount({ ...options, autoSave: true, limits: { finishWaitMs: FINISH_MS } });
  view.render();
  await flush();
  reads.hold = true;
  for (const [index, event] of order.entries()) {
    if (event === "start") view.key(step === "reveal" ? "v" : "r");
    else if (event === "S") view.key("S");
    else if (event === "q") view.key("q");
    else if (outcome === "timeout") await sleep(FINISH_MS * 2);
    else if (outcome === "completes") {
      reads.hold = false;
      gate.resolve();
      for (const wait of reads.pending) wait.resolve();
    } else {
      reads.fail = true;
      gate.reject(new Error("read failed"));
      for (const wait of reads.pending) wait.resolve();
    }
    await flush();
    if (view.completions.length > 0) closedAt(index + 1);
    view.render();
  }
  await sleep(FINISH_MS * 2);
  await flush();
  // Late: everything still pending lands now and must change nothing.
  reads.hold = false;
  gate.resolve();
  for (const wait of reads.pending) wait.resolve();
  await flush();
  if (view.completions.length !== 1) return `${view.completions.length} completions`;
  const result = view.completions[0]!;
  const exported = result.record.comments.find((entry) => entry.id === "c");
  if (!exported) return "the comment is missing";
  const expected = expectedExport(step, order, outcome);
  const marked = exported.stale !== undefined;
  const ok =
    expected === "new"
      ? !marked && exported.line === lines.new
      : expected === "marked"
        ? marked
        : marked || exported.line === lines.old;
  if (!ok)
    return `expected ${expected}, exported line ${exported.line} stale ${exported.stale ?? "none"}`;
  if (result.action === "finish") {
    const markdown = result.markdown ?? "";
    if (marked && !/outdated|not confirmed/u.test(markdown))
      return "Markdown presents a marked comment as current";
    if (view.editorTexts.length !== 1) return `editor written ${view.editorTexts.length} times`;
  } else if (view.editorTexts.length !== 0) return "the editor was written without a Finish";
  return undefined;
}

for (const step of ["refresh", "context", "reveal"] as const) {
  test(`every ordering of a ${step} with Finish and q exports each line as current or marked, never stale`, async (t) => {
    const failures: string[] = [];
    let runs = 0;
    // Without q every ordering closes at S or at the step's settling, so the
    // orderings with q last already cover them.
    const items: readonly WaitEvent[] = ["start", "settle", "S", "q"];
    for (const outcome of ["completes", "fails", "timeout"] as const) {
      const explored = await exploreOrderings(
        items,
        (next, prefix) => next !== "settle" || prefix.includes("start"),
        (order) => runStep(step, order, outcome),
      );
      runs += explored.runs;
      failures.push(...explored.problems.map((problem) => `${outcome} ${problem}`));
    }
    t.diagnostic(`${runs} runs`);
    assert.deepEqual(failures.slice(0, 6), [], `${failures.length} of ${runs} runs`);
  });
}

/* -------------------------------- where a comment is, one answer for all */

/** src/a.ts with two hunks on BASE_TEXT, and src/b.ts with a hunk too short to tell positions apart. */
function tableDiff(variant = false): DiffModel {
  const raw = [
    `diff --git a/${PATH} b/${PATH}`,
    `--- a/${PATH}`,
    `+++ b/${PATH}`,
    "@@ -5,5 +5,6 @@",
    " line 5",
    " line 6",
    "-line 7",
    "+line 7 edited",
    "+line 7b",
    " line 8",
    " line 9",
    "@@ -30,3 +31,3 @@",
    " line 30",
    "-line 31",
    variant ? "+line 31 changed differently" : "+line 31 edited",
    " line 32",
    "diff --git a/src/b.ts b/src/b.ts",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -1,2 +1,3 @@",
    " a",
    "+B",
    " c",
    "",
  ].join("\n");
  return parseGitDiff(raw, "base", "head");
}

type Row = {
  name: string;
  comment: ReviewComment;
  expected: { status: "placed"; line: number; startLine?: number } | { status: "outdated" };
};

function tableRows(): Row[] {
  const diff = tableDiff();
  const first = diff.files[0]!.hunks[0]!;
  const second = diff.files[0]!.hunks[1]!;
  const short = diff.files[1]!.hunks[0]!;
  const other = tableDiff(true).files[0]!.hunks[1]!;
  const above = Array.from({ length: 20 }, (_unused, index) => ({
    kind: "context" as const,
    oldLine: 10 + index,
    newLine: 11 + index,
    text: `line ${10 + index}`,
  }));
  const at = (
    id: string,
    path: string,
    side: "LEFT" | "RIGHT",
    storedLine: number,
    anchor: ReviewComment["anchor"],
    storedStart?: number,
  ): ReviewComment => {
    const entry: ReviewComment = {
      id,
      path,
      side,
      line: storedLine,
      body: `about ${id}`,
      anchor,
      createdAt: NOW,
      updatedAt: NOW,
    };
    if (storedStart !== undefined) entry.startLine = storedStart;
    return entry;
  };
  const withoutPosition = (anchor: ReviewComment["anchor"]) => {
    const { position: _position, ...old } = anchor;
    return old;
  };
  // Stored numbers are wrong on purpose (except where only the text decides): nothing may trust them.
  return [
    {
      name: "new, with position",
      comment: at("new", PATH, "RIGHT", 70, buildCommentAnchor(first, "RIGHT", 7)),
      expected: { status: "placed", line: 7 },
    },
    {
      name: "old, unique snippet",
      comment: at(
        "unique",
        PATH,
        "RIGHT",
        80,
        withoutPosition(buildCommentAnchor(first, "RIGHT", 8)),
      ),
      expected: { status: "placed", line: 8 },
    },
    {
      name: "old, ambiguous snippet",
      comment: at(
        "ambiguous",
        "src/b.ts",
        "RIGHT",
        2,
        withoutPosition(buildCommentAnchor(short, "RIGHT", 2)),
      ),
      expected: { status: "outdated" },
    },
    {
      name: "text changed",
      comment: at("changed", PATH, "RIGHT", 32, buildCommentAnchor(other, "RIGHT", 32)),
      expected: { status: "outdated" },
    },
    {
      name: "file gone",
      comment: at("gone", "src/gone.ts", "RIGHT", 3, buildCommentAnchor(first, "RIGHT", 7)),
      expected: { status: "outdated" },
    },
    {
      name: "expanded context",
      comment: at(
        "context",
        PATH,
        "RIGHT",
        2,
        buildCommentAnchor(hunkWithExpandedContext(second, { above, below: [] }), "RIGHT", 20),
      ),
      expected: { status: "placed", line: 20 },
    },
    {
      name: "range",
      comment: at("range", PATH, "RIGHT", 3, buildCommentAnchor(first, "RIGHT", 10, 8), 1),
      expected: { status: "placed", line: 10, startLine: 8 },
    },
    {
      name: "LEFT, a deleted line",
      comment: at("left", PATH, "LEFT", 99, buildCommentAnchor(second, "LEFT", 31)),
      expected: { status: "placed", line: 31 },
    },
  ];
}

type Answer = { status: "placed"; line: number; startLine?: number } | { status: "outdated" };

function fromRecord(comment: ReviewComment | undefined): Answer | undefined {
  if (!comment) return undefined;
  if (comment.stale) return { status: "outdated" };
  return comment.startLine === undefined
    ? { status: "placed", line: comment.line }
    : { status: "placed", line: comment.line, startLine: comment.startLine };
}

function fromMarkdown(markdown: string, comment: ReviewComment): Answer {
  const header = markdown
    .split("\n")
    .find(
      (line, index, all) => line.startsWith("#### ") && all[index + 2] === `about ${comment.id}`,
    );
  if (!header || / — (outdated|not confirmed)/u.test(header)) return { status: "outdated" };
  const match = /:(\d+)(?: \(lines (\d+)-(\d+)\))? \(/u.exec(header);
  if (!match) return { status: "outdated" };
  return match[2] === undefined
    ? { status: "placed", line: Number(match[1]) }
    : { status: "placed", line: Number(match[3]), startLine: Number(match[2]) };
}

function fromPlan(plan: ReturnType<typeof planReviewSubmission>, id: string): Answer | undefined {
  const inline = plan.placedComments.find((entry) => entry.commentId === id);
  if (inline) {
    return inline.startLine === undefined
      ? { status: "placed", line: inline.line }
      : { status: "placed", line: inline.line, startLine: inline.startLine };
  }
  const body = plan.demotedComments.find((entry) => entry.commentId === id);
  if (!body) return undefined;
  if (body.reason !== "outside-diff") return { status: "outdated" };
  return body.startLine === undefined
    ? { status: "placed", line: body.line }
    : { status: "placed", line: body.line, startLine: body.startLine };
}

test("the view, the record after a refresh, Finish's Markdown and the pull-request plan (head kept or moved) agree on where each kind of comment is", async () => {
  const diff = tableDiff();
  const rows = tableRows();
  const record: ReviewRecord = {
    ...recordOf(
      diff,
      rows.map((row) => row.comment),
    ),
    body: "Summary.",
  };
  const runner: ExecRunner = async () => ({ stdout: BASE_TEXT, stderr: "", code: 0 });

  // The view, through Finish: its record, its Markdown, and what it drew.
  const view = await mount({
    autoSave: true,
    model: diff,
    record,
    execRunner: runner,
    reload: async () => tableDiff(),
  });
  view.render();
  await flush();
  const outdatedShown = /\((\d+) outdated\)/u.exec(view.screen())?.[1];
  view.key("r");
  await flush();
  view.render();
  await flush();
  const afterRefresh = structuredClone(view.savedRecords.at(-1));
  view.key("S");
  await flush();
  const finish = view.completions[0];
  assert.equal(finish?.action, "finish");
  const expandedContext = finish?.expandedContext;

  assert.ok(expandedContext, "Finish returns the context it revealed");
  const plan = (headSha: string) =>
    planReviewSubmission({
      record,
      pullRequest: { owner: "o", repo: "r", number: 1 },
      event: "COMMENT",
      currentHeadSha: headSha,
      currentDiff: diff,
      expandedContext,
    });
  const kept = plan(record.headSha);
  const moved = plan("moved-head");

  const mismatches: string[] = [];
  for (const row of rows) {
    const answers = {
      view: fromRecord(finish?.record.comments.find((entry) => entry.id === row.comment.id)),
      markdown: fromMarkdown(finish?.markdown ?? "", row.comment),
      "plan, head kept": fromPlan(kept, row.comment.id),
      "plan, head moved": fromPlan(moved, row.comment.id),
    };
    for (const [consumer, answer] of Object.entries(answers)) {
      if (JSON.stringify(answer) !== JSON.stringify(row.expected)) {
        mismatches.push(`${row.name} / ${consumer}: ${JSON.stringify(answer)}`);
      }
    }
  }
  assert.deepEqual(mismatches, []);
  assert.equal(
    Number(outdatedShown),
    rows.filter((row) => row.expected.status === "outdated").length,
  );
  assert.equal(afterRefresh, undefined, "a refresh saves nothing by itself");
});

test("a leave-save that hangs gives up after its limit; the review stays open and says so, and q then leaves", async () => {
  const view = await mount({ limits: { leaveSaveMs: LEAVE_MS } });
  view.key("q");
  await flush();
  assert.match(view.screen(), /q again leaves without saving/u);
  await sleep(LEAVE_MS * 3);
  await flush();
  assert.equal(view.completions.length, 0);
  assert.match(view.screen(), /took longer than .* Leave again to close without saving/u);
  view.key("q");
  await flush();
  assert.equal(view.completions.length, 1);
  view.saves[0]?.resolve();
  await flush();
  assert.equal(view.completions.length, 1, "the late save resurrects nothing");
});

/* --------------------------------------- state that must not go stale */

const PR_RECORD = (model: DiffModel, comments: ReviewComment[] = []): ReviewRecord => ({
  ...recordOf(model, comments),
  target: { kind: "pr", number: 7 },
});

/**
 * A failed leave-save, then {an edit (a reviewed mark), nothing}, then {q, S},
 * with the store {working, still failing}. Nothing marked after the failure
 * may be lost: it is saved, or the user was told the save failed and closed
 * knowingly with a second q on that very record.
 */
for (const failure of ["rejects", "times out"] as const) {
  test(`after a leave-save that ${failure}, work done later is saved or the user is told before closing`, async (t) => {
    const failures: string[] = [];
    let runs = 0;
    for (const edit of [true, false]) {
      for (const next of ["q", "S"] as const) {
        for (const store of ["working", "failing"] as const) {
          runs += 1;
          const view = await mount({ limits: { leaveSaveMs: LEAVE_MS } });
          const closes = () => view.completions.length;
          view.key("q");
          await flush();
          if (failure === "rejects") view.saves[0]?.reject(new Error("disk full"));
          else await sleep(LEAVE_MS * 2);
          await flush();
          const label = `edit=${edit} next=${next} store=${store}`;
          if (closes() !== 0) {
            failures.push(`${label}: closed after the failed save`);
            continue;
          }
          if (edit) view.key("m");
          await flush();
          const attemptsBefore = view.saves.length;
          view.key(next);
          await flush();
          const attempted = view.saves.length > attemptsBefore;
          if (!edit && next === "q") {
            // Nothing happened since the failure: the promised close without saving.
            if (attempted || closes() !== 1) failures.push(`${label}: did not close at once`);
            continue;
          }
          if (!attempted) {
            failures.push(`${label}: closed or stayed without trying to save`);
            continue;
          }
          const attempt = view.saves.at(-1)!;
          if (edit && attempt.record.cursor.reviewedHunkIds.length === 0) {
            failures.push(`${label}: the save does not hold the mark`);
          }
          if (store === "working") attempt.resolve();
          else attempt.reject(new Error("disk still full"));
          await flush();
          if (store === "working") {
            const done = view.completions[0];
            if (closes() !== 1) failures.push(`${label}: ${closes()} completions`);
            else if (done?.action !== (next === "S" ? "finish" : "save"))
              failures.push(`${label}: ${done?.action}`);
            continue;
          }
          // Still failing: open, told; q tries (the record changed or a Finish ran) or closes knowingly.
          if (closes() !== 0) failures.push(`${label}: closed on a failed save`);
          if (!/disk still full/u.test(view.screen())) failures.push(`${label}: not told`);
          view.key("q");
          await flush();
          if (closes() === 0) {
            view.saves.at(-1)?.reject(new Error("disk still full"));
            await flush();
            view.key("q");
            await flush();
          }
          if (closes() !== 1) failures.push(`${label}: cannot leave (${closes()})`);
          if (view.editorTexts.length !== 0) failures.push(`${label}: editor written`);
        }
      }
    }
    t.diagnostic(`${runs} runs`);
    assert.deepEqual(failures, []);
  });
}

/**
 * A pull-request Finish cancelled by q at each of its awaits (the outcome
 * prompt, the summary prompt, the wait for a refresh, its own save), with the
 * leave-save {working, failing}. The verdict and body enter the record only
 * once the Finish commits to its save; before that a cancel leaves them unset.
 */
test("a Finish cancelled at each await never stores a verdict the user did not commit", async (t) => {
  const failures: string[] = [];
  let runs = 0;
  for (const at of ["outcome", "summary", "wait", "save"] as const) {
    for (const leaveStore of ["working", "failing"] as const) {
      runs += 1;
      const select = deferred<string | undefined>();
      const input = deferred<string | undefined>();
      const refresh = deferred<DiffModel>();
      refresh.promise.catch(() => {});
      const model = modelOf(false);
      const view = await mount({
        model,
        record: PR_RECORD(model),
        prompts: { select: () => select.promise, input: () => input.promise },
        reload: () => refresh.promise,
        limits: { finishWaitMs: 5_000, leaveSaveMs: LEAVE_MS },
      });
      if (at === "wait") view.key("r");
      await flush();
      view.key("S");
      await flush();
      if (at !== "outcome") {
        select.resolve("Approve");
        await flush();
      }
      if (at === "wait" || at === "save") {
        input.resolve("Ship it.");
        await flush();
      }
      const label = `${at} leave=${leaveStore}`;
      if (at === "save" && view.saves.length !== 1)
        failures.push(`${label}: Finish's save not started`);
      view.key("q");
      await flush();
      // The cancelled Finish's awaits now settle, late.
      select.resolve("Approve");
      input.resolve("Ship it.");
      refresh.resolve(model);
      await flush();
      const leaveSave = view.saves.at(-1);
      const expected = at === "save" ? "approve" : undefined;
      if (leaveSave?.record.verdict !== expected) {
        failures.push(`${label}: leave-save verdict ${leaveSave?.record.verdict ?? "none"}`);
      }
      if (at !== "save" && leaveSave?.record.body !== undefined)
        failures.push(`${label}: body stored`);
      if (leaveStore === "working") leaveSave?.resolve();
      else leaveSave?.reject(new Error("disk"));
      for (const save of view.saves.slice(0, -1)) save.resolve();
      await flush();
      if (leaveStore === "failing") {
        view.key("q");
        await flush();
      }
      if (view.completions.length !== 1)
        failures.push(`${label}: ${view.completions.length} completions`);
      if (view.completions[0]?.action !== "save")
        failures.push(`${label}: ${view.completions[0]?.action}`);
      if (view.editorTexts.length !== 0) failures.push(`${label}: editor written`);
    }
  }
  t.diagnostic(`${runs} runs`);
  assert.deepEqual(failures, []);
});

/**
 * Finish's wait times out on a refresh, so the comment is saved "unconfirmed";
 * Finish's save {fails, succeeds}; the refresh then {completes, fails}; then
 * {q, S}. The mark lasts only until the next follow: no later save keeps it.
 */
test("an unconfirmed mark from a timed-out wait is re-established by the next save", async (t) => {
  const failures: string[] = [];
  let runs = 0;
  for (const finishSave of ["fails", "succeeds"] as const) {
    for (const work of ["completes", "fails"] as const) {
      for (const next of ["q", "S"] as const) {
        // A successful Finish save closes before work or next matter: one run covers it.
        if (finishSave === "succeeds" && (work !== "completes" || next !== "q")) continue;
        runs += 1;
        const first = modelOf(false);
        const moved = modelOf(true);
        const gate = deferred<DiffModel>();
        gate.promise.catch(() => {});
        const anchor = buildCommentAnchor(first.files[0]!.hunks[1]!, "RIGHT", 30);
        const view = await mount({
          model: first,
          record: recordOf(first, [
            {
              id: "c",
              path: PATH,
              side: "RIGHT",
              line: 30,
              body: "b",
              anchor,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ]),
          reload: () => gate.promise,
          limits: { finishWaitMs: 20, leaveSaveMs: LEAVE_MS },
        });
        view.key("r");
        await flush();
        view.key("S");
        await sleep(60);
        await flush();
        const label = `finishSave=${finishSave} work=${work} next=${next}`;
        const finishing = view.saves[0];
        if (finishing?.record.comments[0]?.stale !== "unconfirmed") {
          failures.push(`${label}: Finish did not mark it unconfirmed`);
        }
        if (finishSave === "succeeds") {
          finishing?.resolve();
          await flush();
          gate.resolve(moved);
          await flush();
          if (
            view.completions.length !== 1 ||
            view.completions[0]?.record.comments[0]?.stale !== "unconfirmed"
          ) {
            failures.push(`${label}: the finished record is not the one saved`);
          }
          continue;
        }
        finishing?.reject(new Error("disk"));
        await flush();
        if (work === "completes") gate.resolve(moved);
        else gate.reject(new Error("git gone"));
        await flush();
        await flush();
        view.key(next);
        await flush();
        const later = view.saves.at(-1);
        const comment = later?.record.comments[0];
        if (later === finishing) failures.push(`${label}: no later save`);
        else if (work === "completes") {
          // A successful read re-establishes it.
          if (comment?.stale !== undefined)
            failures.push(`${label}: still marked ${comment?.stale}`);
          else if (comment?.line !== 31) failures.push(`${label}: line ${comment?.line}`);
        } else if (comment?.stale !== "unconfirmed") {
          // The read failed: still uncertain, never the old number as current.
          failures.push(`${label}: exported ${comment?.line} as current after a failed read`);
        }
        later?.resolve();
        await flush();
        if (view.completions.length !== 1)
          failures.push(`${label}: ${view.completions.length} completions`);
      }
    }
  }
  t.diagnostic(`${runs} runs`);
  assert.deepEqual(failures, []);
});

test("while closing, keys other than leaving change nothing", async () => {
  const view = await mount();
  view.key("q");
  await flush();
  view.key("m");
  await flush();
  // Refused, not applied to a record that is no longer the one being saved.
  assert.match(view.screen(), /0 reviewed/u);
  assert.match(view.screen(), /q again leaves without saving/u);
  view.saves[0]?.resolve();
  await flush();
  assert.equal(view.completions.length, 1);
  assert.deepEqual(
    view.completions[0]?.record.cursor.reviewedHunkIds,
    [],
    "the reported record is the one saved",
  );
  assert.deepEqual(view.saves[0]?.record.cursor.reviewedHunkIds, []);
});

test("a leave-save that stalls past its limit and lands after a newer save does not overwrite the newer record on disk", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "choco-pi-z1-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const gates: Array<() => void> = [];
  let holdNext = true;
  const real = createReviewStore(directory, undefined, {
    cleanup: false,
    beforeWrite: () => {
      if (!holdNext) return Promise.resolve();
      holdNext = false;
      return new Promise<void>((release) => gates.push(release));
    },
  });
  const view = await mount({ store: real, limits: { leaveSaveMs: LEAVE_MS } });
  view.key("q");
  await sleep(LEAVE_MS * 3);
  await flush();
  assert.equal(view.completions.length, 0, "the stalled save reopened the view");
  view.key("c");
  view.key("Persist me.");
  view.key("\r");
  await flush();
  view.key("q");
  for (let round = 0; round < 50 && view.completions.length === 0; round += 1) await sleep(2);
  assert.equal(view.completions.length, 1);
  gates[0]?.();
  await sleep(20);
  const saved = await real.load("repo-key", targetKey({ kind: "branch", base: "main" }));
  assert.deepEqual(
    saved?.comments.map((entry) => entry.body),
    ["Persist me."],
  );
});

/** A side chat that answers nothing and records what it was asked. */
class QuietChat implements ReviewChat {
  readonly messages: ReviewChatMessage[] = [];
  readonly pending = false;
  readonly status = {};
  readonly asked: string[] = [];
  async ask(question: string, _context: ReviewChatContext): Promise<void> {
    this.asked.push(question);
  }
  onUpdate(_listener: () => void): () => void {
    return () => {};
  }
  async setModel(query: string): Promise<string> {
    return query;
  }
  async setThinkingLevel(level: string): Promise<string> {
    return level;
  }
  async reload(): Promise<void> {}
  async prepare(): Promise<void> {}
  commands() {
    return [];
  }
  toolDefinition(): RuntimeValue {
    return undefined;
  }
  async runCommand(): Promise<void> {}
  dispose(): void {}
}

test("with the chat focused, q after /quit closes the review at once and types nothing into the chat", async () => {
  const chat = new QuietChat();
  const view = await mount({ createReviewChat: () => chat });
  view.key("a");
  await flush();
  view.key("/quit");
  view.key("\r");
  await flush();
  assert.equal(view.saves.length, 1, "/quit started the save");
  view.key("q");
  await flush();
  assert.equal(view.completions.length, 1, "q closed the review at once");
  view.saves[0]?.resolve();
  await flush();
  assert.equal(view.completions.length, 1);
  assert.deepEqual(chat.asked, []);
});
