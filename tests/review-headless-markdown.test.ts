// /review-assist in an editor that renders Markdown (Zed through the choco-pi ACP adapter).
import assert from "node:assert/strict";
import test from "node:test";
import { parseGitDiff } from "../.pi/extensions/lib/changes/patch.ts";
import { MAX_HEADLESS_MARKDOWN_CHARS } from "../.pi/extensions/review/core/headless-markdown.ts";
import type { DiffModel, ResolvedReviewConfig } from "../.pi/extensions/review/core/types.ts";
import { presentHeadlessReview } from "../.pi/extensions/review/headless.ts";

const MARKER = { CHOCO_PI_ACP_NATIVE_DIFF: "1" };
const SECRET = "SECRET-VALUE-7f3a";
const ESC = "\u001b";
const FENCE3 = "```";
/** ESC colour, OSC 52 clipboard write, BEL, CR, C1 CSI, RLO, backticks, heading and link syntax. */
const NASTY = `n${ESC}[31mred${ESC}]52;c;QUJD\u0007\r\u009b2J\u202e\`x\`# h [a](http://b).md`;
const VISIBLE_NASTY = `n\u241b[31mred\u241b]52;c;QUJD\u2407\u240d\uFFFD2J\uFFFD\`x\`# h [a](http://b).md`;

const config = {
  editor: { command: ["zed"], mode: "gui" },
  highlight: { enabled: false, maxFileBytes: 1, maxDiffLines: 1 },
  heuristics: { riskPatterns: [], collapsePatterns: [] },
} satisfies ResolvedReviewConfig;

function fixture(): DiffModel {
  return parseGitDiff(
    [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,4 +1,4 @@ function f()",
      " \tindented();",
      '-  const q = "straight";',
      "+  const q = 'single' + \"x\";",
      " --- not a rule",
      ` ${FENCE3}fence inside${FENCE3}`,
      `diff --git a/${NASTY} b/${NASTY}`,
      "--- /dev/null",
      `+++ b/${NASTY}`,
      "@@ -0,0 +1,2 @@",
      `+# heading in hunk ${ESC}[0m`,
      `+[link](http://evil) ${FENCE3}\``,
      "diff --git a/.env b/.env",
      "--- a/.env",
      "+++ b/.env",
      "@@ -1 +1 @@",
      "-TOKEN=old",
      `+TOKEN=${SECRET}`,
      "",
    ].join("\n"),
    "base",
    "head",
  );
}

async function present(model: DiffModel, env: Record<string, string>): Promise<string[]> {
  const sent: string[] = [];
  await presentHeadlessReview({
    request: { action: "review", target: { kind: "branch", base: "main" } },
    cwd: "/repo",
    sessionId: "session",
    ui: { notify: (message) => sent.push(message), select: async () => undefined },
    dependencies: {
      store: { load: async () => undefined, save: async () => {}, list: async () => [] },
      runner: async () => ({ stdout: "/repo\n", stderr: "", code: 0 }),
      loadConfig: async () => config,
      checkpointProvider: { listTurns: async () => [] },
      readTargetDiff: async () => model,
      isCurrent: () => true,
      env,
    },
  });
  return sent;
}

type Parsed = {
  outside: string[];
  fences: Array<{ marker: string; info: string; body: string[] }>;
  open: boolean;
};

/** CommonMark backtick fences: opened by 3+ backticks, closed by a line of at least as many. */
function parseFences(text: string): Parsed {
  const parsed: Parsed = { outside: [], fences: [], open: false };
  let current: { marker: string; info: string; body: string[] } | undefined;
  for (const line of text.split("\n")) {
    if (current === undefined) {
      const opening = /^ {0,3}(`{3,})([^`]*)$/u.exec(line);
      if (opening) {
        current = { marker: opening[1] ?? "", info: (opening[2] ?? "").trim(), body: [] };
        parsed.fences.push(current);
      } else parsed.outside.push(line);
      continue;
    }
    const closing = /^ {0,3}(`+)\s*$/u.exec(line);
    if (closing && (closing[1] ?? "").length >= current.marker.length) current = undefined;
    else current.body.push(line);
  }
  parsed.open = current !== undefined;
  return parsed;
}

function unsafeOutsideTabAndNewline(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x0a || code === 0x09) continue;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true;
  }
  return false;
}

test("in the editor, each file's unified diff is a fenced diff block and nothing else forms Markdown", async () => {
  const sent = await present(fixture(), MARKER);
  assert.equal(sent.length, 1);
  const output = sent[0] ?? "";
  assert.equal(output.includes(SECRET), false, "a sensitive file's text is never shown");
  assert.equal(output.includes("Diff units"), false);
  assert.doesNotMatch(output, /\((old|new)\)/u, "no whole old and new sides");
  assert.equal(unsafeOutsideTabAndNewline(output), false);

  const parsed = parseFences(output);
  assert.equal(parsed.open, false, "every fence is closed");
  assert.deepEqual(
    parsed.fences.map((fence) => [fence.marker.length, fence.info]),
    [
      [4, "diff"],
      [5, "diff"],
    ],
    "fences are longer than any backtick run inside",
  );
  assert.deepEqual(parsed.fences[0]?.body, [
    "@@ -1,4 +1,4 @@ function f()",
    " \tindented();",
    '-  const q = "straight";',
    "+  const q = 'single' + \"x\";",
    " --- not a rule",
    ` ${FENCE3}fence inside${FENCE3}`,
  ]);
  assert.deepEqual(parsed.fences[1]?.body, [
    "@@ -0,0 +1,2 @@",
    "+# heading in hunk \u241b[0m",
    `+[link](http://evil) ${FENCE3}\``,
  ]);

  for (const line of parsed.outside) {
    assert.doesNotMatch(line, /^(?: {4}|\s{0,3}(?:[#>|<~]|\d+[.)]\s))/u, line);
  }
  // File names are code spans whose delimiter outruns the name's own backticks.
  const span = `\`\` ${VISIBLE_NASTY} \`\``;
  assert.ok(parsed.outside.includes(`- ${span}:1`));
  assert.ok(parsed.outside.includes(span), "the name line above its diff");
  assert.ok(parsed.outside.includes("` src/app.ts `"));
  // Prose with names in it is escaped, and the sensitive file is named, not shown.
  assert.ok(
    parsed.outside.some((line) => line.startsWith("- Sensitive files") && line.includes("\\.env")),
    "the sensitive file is named, escaped",
  );
  const risks = parsed.outside.indexOf("**Risks**");
  const diffs = parsed.outside.indexOf("**Diffs**");
  assert.ok(risks > 0 && diffs > risks, "diffs come last, so a clip cuts only diffs");
});

type AddedFile = { path: string; lines: readonly string[] };
/** The raw diff of some added files, and each file's expected unified diff text. */
type AddedFixture = { raw: string; diffs: Map<string, string> };

function addedFiles(files: readonly AddedFile[]): AddedFixture {
  const diffs = new Map<string, string>();
  const raw = files.map(({ path, lines }) => {
    const body = [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)];
    diffs.set(path, body.join("\n"));
    return [`diff --git a/${path} b/${path}`, "--- /dev/null", `+++ b/${path}`, ...body].join("\n");
  });
  return { raw: `${raw.join("\n")}\n`, diffs };
}

/** The notice, the file list's marks, and the fenced diffs of a clipped review. */
function clipFacts(output: string) {
  const parsed = parseFences(output);
  const notice = parsed.outside.find((line) => line.startsWith("**Not every diff fits")) ?? "";
  const counts = /the diffs of (\d+) of ([\d,]+) files? \(([\d,]+) characters? of diff\)/u.exec(
    notice,
  );
  const marked = parsed.outside
    .filter((line) => line.endsWith(" (diff not shown)"))
    .map((line) => /^- ` (.*) `:\d+ \(diff not shown\)$/u.exec(line)?.[1] ?? line);
  const shownNames = parsed.outside
    .filter((line) => /^` .* `$/u.test(line))
    .map((line) => line.slice(2, -2));
  return { parsed, notice, counts, marked, shownNames };
}

const number = (value: string | undefined): number => Number((value ?? "").replaceAll(",", ""));

test("a review larger than the message keeps the head whole, shows whole diffs, and counts the rest", async () => {
  const files = Array.from({ length: 40 }, (_, index) => ({
    path: `f${String(index).padStart(2, "0")}.ts`,
    lines: Array.from({ length: 12 }, (_, line) => `line ${line} of file ${index} ${FENCE3}`),
  }));
  const { raw, diffs } = addedFiles(files);
  const output = (await present(parseGitDiff(raw, "base", "head"), MARKER))[0] ?? "";
  assert.ok(output.length <= MAX_HEADLESS_MARKDOWN_CHARS, String(output.length));
  const { parsed, notice, counts, marked, shownNames } = clipFacts(output);
  assert.equal(parsed.open, false);
  // The notice comes before everything that can be left out, right after the summary.
  const diffsAt = parsed.outside.indexOf("**Diffs**");
  assert.ok(
    parsed.outside.indexOf(notice) >= 0 &&
      (diffsAt < 0 || parsed.outside.indexOf(notice) < diffsAt),
    "the notice comes before anything that can be left out",
  );
  assert.match(notice, /run `\/review-assist` in a terminal thread/u);
  assert.match(notice, /`\/review-assist session turn <n>`/u);
  // Every file is in the list; shown and not-shown partition it, in order.
  const listed = parsed.outside.filter((line) => /^- ` f\d\d\.ts `:1/u.test(line));
  assert.equal(listed.length, 40);
  assert.deepEqual(
    [...shownNames, ...marked].sort(),
    files.map((file) => file.path),
  );
  assert.ok(shownNames.length > 0 && marked.length > 0);
  assert.deepEqual(
    shownNames,
    files.slice(0, shownNames.length).map((file) => file.path),
  );
  // Whole blocks only: each shown fence holds that file's entire diff.
  assert.deepEqual(
    parsed.fences.map((fence) => fence.body.join("\n")),
    shownNames.map((name) => diffs.get(name)),
  );
  // Exact counts of what was left out.
  assert.equal(number(counts?.[1]), marked.length);
  assert.equal(number(counts?.[2]), 40);
  const leftOut = marked.reduce((sum, name) => sum + (diffs.get(name)?.length ?? 0), 0);
  assert.equal(number(counts?.[3]), leftOut);
  assert.ok(parsed.outside.includes("**Risks**"));
  assert.equal(
    parsed.outside.some((line) => line.includes("does not fit in one editor message")),
    false,
  );
});

test("one file larger than the message is named and counted, never shown in part", async () => {
  const big = {
    path: "big.ts",
    lines: Array.from({ length: 2_000 }, (_, line) => `const value${line} = ${line};`),
  };
  const small = { path: "small.ts", lines: ["export const small = 1;"] };
  const { raw, diffs } = addedFiles([big, small]);
  const output = (await present(parseGitDiff(raw, "base", "head"), MARKER))[0] ?? "";
  assert.ok(output.length <= MAX_HEADLESS_MARKDOWN_CHARS);
  const { parsed, counts, marked, shownNames } = clipFacts(output);
  assert.deepEqual(marked, ["big.ts"]);
  assert.deepEqual(shownNames, ["small.ts"]);
  assert.deepEqual(
    parsed.fences.map((fence) => fence.body.join("\n")),
    [diffs.get("small.ts")],
  );
  // Beyond the 32 KiB per-file bound, the count is still the whole diff's length.
  const bigChars = diffs.get("big.ts")?.length ?? 0;
  assert.ok(bigChars > 32 * 1024);
  assert.deepEqual(
    [number(counts?.[1]), number(counts?.[2]), number(counts?.[3])],
    [1, 2, bigChars],
  );
  assert.equal(output.includes("const value1999"), false);
});

test("hidden sensitive files are named only and never count as left-out content", async () => {
  const secretLines = Array.from({ length: 2_000 }, () => `TOKEN=${SECRET}`);
  const big = {
    path: "big.ts",
    lines: Array.from({ length: 1_000 }, (_, line) => `let v${line} = ${line};`),
  };
  const { raw, diffs } = addedFiles([
    { path: ".env", lines: secretLines },
    big,
    { path: "secrets/key.txt", lines: secretLines },
  ]);
  const output = (await present(parseGitDiff(raw, "base", "head"), MARKER))[0] ?? "";
  assert.equal(output.includes(SECRET), false);
  const { counts, marked } = clipFacts(output);
  assert.deepEqual(marked, ["big.ts"]);
  assert.deepEqual(
    [number(counts?.[1]), number(counts?.[2]), number(counts?.[3])],
    [1, 1, diffs.get("big.ts")?.length ?? 0],
  );
  assert.match(output, /their contents were not shown\\: \\\.env\\, secrets\\\/key\\\.txt\\\./u);
});

const HOSTILE = `fatal: bad ${ESC}[31m# heading\n[link](http://evil) ${FENCE3}x\u202e`;

async function presentFailure(env: Record<string, string>, pick: boolean): Promise<string[]> {
  const sent: string[] = [];
  await presentHeadlessReview({
    request: pick
      ? { action: "pick" }
      : { action: "review", target: { kind: "branch", base: "main" } },
    cwd: "/repo",
    sessionId: "session",
    ui: { notify: (message) => sent.push(message), select: async () => undefined },
    dependencies: {
      store: { load: async () => undefined, save: async () => {}, list: async () => [] },
      runner: async (command, args) => {
        if (command === "gh") return { stdout: "", stderr: HOSTILE, code: 1 };
        if (args.includes("for-each-ref")) return { stdout: "main\n", stderr: "", code: 0 };
        return { stdout: "/repo\n", stderr: "", code: 0 };
      },
      loadConfig: async () => config,
      checkpointProvider: { listTurns: async () => [] },
      readTargetDiff: async () => {
        throw new Error(HOSTILE);
      },
      isCurrent: () => true,
      env,
    },
  });
  return sent;
}

test("in the editor, untrusted detail in a failure is a code block; elsewhere it is unchanged", async () => {
  const [failure] = await presentFailure(MARKER, false);
  const parsed = parseFences(failure ?? "");
  assert.deepEqual(parsed.outside, ["Review failed:", ""]);
  assert.deepEqual(
    parsed.fences.map((fence) => [fence.marker, fence.info]),
    [["````", "text"]],
  );
  assert.deepEqual(parsed.fences[0]?.body, [
    "fatal: bad \u241b[31m# heading",
    `[link](http://evil) ${FENCE3}x\uFFFD`,
  ]);
  const [warning] = await presentFailure(MARKER, true);
  const parsedWarning = parseFences(warning ?? "");
  assert.equal(parsedWarning.outside[0], "Pull request targets are unavailable:");
  assert.equal(parsedWarning.open, false);
  assert.ok(parsedWarning.fences[0]?.body.some((line) => line.includes("# heading")));

  const [plain] = await presentFailure({}, false);
  assert.equal(
    plain,
    `Review failed: fatal: bad \u241b[31m# heading\n[link](http://evil) ${FENCE3}x\uFFFD`,
  );
});

test("a rename whose source is sensitive is hidden in the review, in either output", async () => {
  const raw = [
    "diff --git a/.env b/public.txt",
    "similarity index 50%",
    "rename from .env",
    "rename to public.txt",
    "--- a/.env",
    "+++ b/public.txt",
    "@@ -1 +1 @@",
    `-TOKEN=${SECRET}`,
    "+TOKEN=redacted",
    "",
  ].join("\n");
  const model = parseGitDiff(raw, "base", "head");
  assert.equal(model.files[0]?.oldPath, ".env");
  // Both sides are named, so the reader sees why the file is hidden.
  const expected = new Map<Record<string, string>, string>([
    [
      MARKER,
      "- Sensitive files listed by name only\\; their contents were not shown\\: \\.env → public\\.txt\\.",
    ],
    [{}, "Sensitive files listed by name only; their contents were not shown: .env → public.txt."],
  ]);
  for (const [env, line] of expected) {
    const output = (await present(model, env))[0] ?? "";
    assert.equal(output.includes(SECRET), false);
    assert.ok(output.split("\n").includes(line), output);
  }
  // A hostile source name is sanitised and escaped like any other name.
  const hostile = raw.replaceAll(".env", "[x](e)\u001b[31m/.env");
  const output = (await present(parseGitDiff(hostile, "base", "head"), MARKER))[0] ?? "";
  assert.equal(output.includes(SECRET), false);
  assert.ok(output.includes("\\[x\\]\\(e\\)\u241b\\[31m\\/\\.env → public\\.txt"), output);
});

test("without the editor marker the same review stays plain text", async () => {
  const output = (await present(fixture(), {}))[0] ?? "";
  assert.match(output, /^Diff units:$/mu);
  assert.match(output, /^--- src\/app\.ts \(old\)$/mu);
  assert.equal(output.includes(SECRET), false);
  assert.equal(output.includes("```diff"), false);
});
