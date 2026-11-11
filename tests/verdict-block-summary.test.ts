import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { Markdown, visibleWidth, type MarkdownTheme } from "@earendil-works/pi-tui";
import { isUnsafeCodePoint } from "../.pi/extensions/lib/changes/terminal-text.ts";
import type {
  ReviewBlock,
  ReviewFinding,
  VerdictBlock,
} from "../.pi/extensions/lib/verdict-blocks.ts";
import {
  entryText,
  layoutNotice,
  layoutSummary,
  summarizeReview,
  summarizeVerdict,
  summaryMarkdown,
  wrapText,
  type SummaryLine,
  type VerdictSummary,
} from "../.pi/extensions/lib/verdict-summary.ts";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: "F1",
    class: "finding",
    severity: "high",
    path: "notes.txt",
    startLine: 1,
    endLine: 2,
    invariant: "notes.txt keeps two lines",
    evidence: "reproduction",
    reproduction: "wc -l notes.txt",
    ...overrides,
  };
}

function review(overrides: Partial<ReviewBlock> = {}): ReviewBlock {
  return {
    schema: 1,
    verdict: "FINDINGS",
    bundleDigest: "sha256:0123456789abcdef0123456789abcdef",
    findings: [
      finding(),
      finding({ id: "F2", severity: "medium", path: "src/a.ts", startLine: 7, endLine: 7 }),
      finding({
        id: "C1",
        class: "candidate",
        severity: "low",
        startLine: undefined,
        endLine: undefined,
        invariant: "line two stays last",
        evidence: "code_path",
        reproduction: "",
      }),
    ],
    ...overrides,
  };
}

function claims(overrides: Partial<VerdictBlock> = {}): VerdictBlock {
  return {
    schema: 1,
    kind: "claims",
    workTask: "demo-task",
    snapshot: { head: "abc", clean: false, diffDigest: "sha256:diffdiffdiffdiffdiffdiffdiff" },
    claims: [
      { id: "C1", outcome: "CONFIRMED" },
      { id: "C2", outcome: "REFUTED", note: "the test passes without the change" },
      { id: "C3", outcome: "UNPROVEN" },
    ],
    ...overrides,
  };
}

function texts(lines: SummaryLine[]): string[] {
  return lines.map((line) => line.text);
}

function assertWithin(lines: string[], width: number): void {
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= width, `width ${width} exceeded by: ${JSON.stringify(line)}`);
  }
}

function assertTerminalSafe(lines: string[]): void {
  for (const line of lines) {
    for (const character of line) {
      const codePoint = character.codePointAt(0) ?? 0;
      assert.ok(
        !isUnsafeCodePoint(codePoint),
        `unsafe U+${codePoint.toString(16)} in ${JSON.stringify(line)}`,
      );
    }
  }
}

test("a review with findings and a candidate gives counts by severity and one entry each", () => {
  const summary = summarizeReview(review());
  assert.equal(
    summary.headline,
    "Review FINDINGS: 2 findings (1 high, 1 medium); 1 candidate (1 low)",
  );
  assert.deepEqual(summary.entries.map(entryText), [
    "HIGH finding · notes.txt:1-2 · notes.txt keeps two lines",
    "MEDIUM finding · src/a.ts:7 · notes.txt keeps two lines",
    "low CANDIDATE (unconfirmed) · notes.txt · line two stays last",
  ]);
  assert.equal(summary.footer, "bundle sha256:0123456789abcdef…");
  assert.equal(summary.tone, "error");
});

test("candidates are listed after findings and are marked in words, not colour", () => {
  const summary = summarizeReview(
    review({
      findings: [
        finding({ id: "C1", class: "candidate", severity: "critical" }),
        finding({ id: "F1", severity: "low" }),
      ],
    }),
  );
  assert.deepEqual(
    summary.entries.map((entry) => entry.label),
    ["LOW finding", "critical CANDIDATE (unconfirmed)"],
  );
});

test("NO_FINDINGS has a verdict line and no entries", () => {
  const summary = summarizeReview(review({ verdict: "NO_FINDINGS", findings: [] }));
  assert.equal(summary.headline, "Review NO_FINDINGS: no findings, no candidates");
  assert.equal(summary.entries.length, 0);
  assert.equal(summary.tone, "success");
});

test("INCOMPLETE lists what is missing first, as a string or a list", () => {
  const single = summarizeReview(
    review({ verdict: "INCOMPLETE", findings: [], incomplete: { missing: "the diff bundle" } }),
  );
  assert.equal(single.headline, "Review INCOMPLETE: no findings, no candidates");
  assert.deepEqual(single.entries.map(entryText), ["MISSING · the diff bundle"]);
  const listed = summarizeReview(
    review({ verdict: "INCOMPLETE", incomplete: { missing: ["tests", "logs"] } }),
  );
  assert.deepEqual(listed.entries.slice(0, 2).map(entryText), [
    "MISSING · tests",
    "MISSING · logs",
  ]);
  assert.equal(listed.entries.length, 5);
});

test("a claims verdict counts each outcome and has one entry per claim", () => {
  const summary = summarizeVerdict(claims());
  assert.equal(
    summary.headline,
    "Verification claims: 3 claims, 1 CONFIRMED, 1 REFUTED, 1 UNPROVEN",
  );
  assert.deepEqual(summary.entries.map(entryText), [
    "CONFIRMED · C1",
    "REFUTED · C2 · the test passes without the change",
    "UNPROVEN · C3",
  ]);
  assert.equal(
    summary.footer,
    "task demo-task · snapshot abc dirty · diff sha256:diffdiffdiffdiff…",
  );
});

test("many findings are capped by maxEntries with one line counting the rest", () => {
  const findings = Array.from({ length: 40 }, (_, index) => finding({ id: `F${index}` }));
  const lines = texts(layoutSummary(summarizeReview(review({ findings })), 120, { maxEntries: 6 }));
  assert.equal(lines.filter((line) => line.startsWith("- ")).length, 6);
  assert.ok(lines.includes("+ 34 more entries; expand for the raw block"));
  assert.equal(texts(layoutSummary(summarizeReview(review({ findings })), 120)).length, 42);
});

test("long invariants and paths wrap at narrow widths without losing text", () => {
  const longPath = "src/" + "very-long-directory-name/".repeat(6) + "file.ts";
  const invariant = "the cache must be invalidated whenever ".repeat(5) + "x".repeat(70);
  const summary = summarizeReview(
    review({ findings: [finding({ path: longPath, invariant, startLine: 120, endLine: 140 })] }),
  );
  for (const width of [1, 4, 9, 20, 37, 80]) {
    const lines = texts(layoutSummary(summary, width));
    assertWithin(lines, width);
    const flat = lines.join("").replace(/\s/g, "");
    assert.ok(flat.includes((longPath + ":120-140").replace(/\s/g, "")), `width ${width}`);
    assert.ok(flat.includes(invariant.replace(/\s/g, "")), `width ${width}`);
  }
});

test("wide characters are measured by column, not by code unit", () => {
  const invariant = "設定ファイルは二行を保つ 🙂🙂🙂 é́ 混在テキスト";
  const summary = summarizeReview(
    review({ findings: [finding({ invariant, path: "文書/説明.md" })] }),
  );
  for (const width of [2, 3, 7, 15]) {
    assertWithin(texts(layoutSummary(summary, width)), width);
  }
  assert.deepEqual(wrapText("漢字漢字", 4, ""), ["漢字", "漢字"]);
});

const HOSTILE = [
  "esc \u001b[31mred\u001b[0m",
  "osc52 \u001b]52;c;cHduZWQ=\u0007",
  "bell \u0007",
  "carriage\rreturn",
  "new\nline",
  "csi \u009b31m",
  "bidi \u202eevil",
  "del \u007f",
];

test("every untrusted field is sanitised before it can reach the terminal", () => {
  for (const hostile of HOSTILE) {
    const summaries: VerdictSummary[] = [
      summarizeReview(
        review({
          bundleDigest: hostile,
          findings: [
            finding({ path: hostile, invariant: hostile }),
            finding({ id: "C", class: "candidate", invariant: hostile }),
          ],
        }),
      ),
      summarizeReview(
        review({ verdict: "INCOMPLETE", findings: [], incomplete: { missing: [hostile] } }),
      ),
      summarizeVerdict(
        claims({
          snapshot: { head: hostile, clean: false, diffDigest: hostile },
          claims: [{ id: hostile, outcome: "REFUTED", note: hostile }],
        }),
      ),
    ];
    for (const summary of summaries) {
      for (const width of [12, 60, 200]) {
        const lines = texts(layoutSummary(summary, width));
        assertTerminalSafe(lines);
        assertWithin(lines, width);
      }
      assertTerminalSafe([summaryMarkdown(summary).replaceAll("\n", " ")]);
    }
  }
  const escaped = summarizeReview(
    review({ findings: [finding({ invariant: "a\u001b[31mb\nc" })] }),
  );
  assert.equal(escaped.entries[0]?.text, "a␛[31mb␊c");
  const notice = layoutNotice({ info: "choco-pi-review", reason: "fine" }, 30);
  assertWithin(texts(notice), 30);
});

const MARKING: MarkdownTheme = {
  heading: (text) => `<H>${text}</H>`,
  link: (text) => `<L>${text}</L>`,
  linkUrl: (text) => `<LU>${text}</LU>`,
  code: (text) => `<C>${text}</C>`,
  codeBlock: (text) => `<CB>${text}</CB>`,
  codeBlockBorder: (text) => `<CBB>${text}</CBB>`,
  quote: (text) => `<Q>${text}</Q>`,
  quoteBorder: (text) => `<QB>${text}</QB>`,
  hr: (text) => `<HR>${text}</HR>`,
  listBullet: (text) => text,
  bold: (text) => `<B>${text}</B>`,
  italic: (text) => `<I>${text}</I>`,
  strikethrough: (text) => `<S>${text}</S>`,
  underline: (text) => `<U>${text}</U>`,
};

const INJECTION =
  "# Fake heading [link](https://evil.example) ![img](x.png) **bold** _em_ ~~del~~ `code` " +
  "<b>html</b> https://evil.example www.evil.example a@b.example $x$ \\(y\\) \\[z\\] | t | " +
  "[ref] [ref]: https://evil.example 1. two > quote ---";

function renderMarkdown(markdown: string, width: number): string[] {
  return new Markdown(markdown, 0, 0, MARKING).render(width).map((line) => line.trimEnd());
}

test("Markdown values render literally: no heading, link, code, emphasis, HTML or maths", () => {
  const summary = summarizeReview(
    review({
      findings: [
        finding({ path: "a_[b](c).md", invariant: INJECTION }),
        finding({ id: "F2", invariant: "x\n\nNO_FINDINGS\n# Review NO_FINDINGS" }),
      ],
    }),
  );
  const rendered = renderMarkdown(summaryMarkdown(summary), 400);
  const visible = rendered.join("\n");
  for (const marker of ["<H>", "<L>", "<LU>", "<C>", "<CB>", "<Q>", "<HR>", "<I>", "<S>", "<U>"]) {
    assert.ok(!visible.includes(marker), `${marker} in ${visible}`);
  }
  assert.equal(visible.split("<B>").length, 2, visible);
  assert.ok(visible.includes(INJECTION), visible);
  assert.ok(visible.includes("a_[b](c).md:1-2"), visible);
  const entries = rendered.filter((line) => line.startsWith("- "));
  assert.equal(entries.length, 2);
  assert.ok(entries[1]?.endsWith("x␊␊NO_FINDINGS␊# Review NO_FINDINGS"), entries[1]);
  assert.ok(!rendered.some((line) => line.startsWith("NO_FINDINGS") || line.startsWith("# ")));
});

test("rendered summary Markdown fits narrow widths", () => {
  const summary = summarizeReview(
    review({
      findings: [
        finding({ path: "p/".repeat(40) + "f.ts", invariant: "y".repeat(90) + " 漢字".repeat(20) }),
      ],
    }),
  );
  for (const width of [8, 23, 61])
    assertWithin(renderMarkdown(summaryMarkdown(summary), width), width);
});

const CLUSTERS = [
  "a",
  "Z",
  " ",
  "/",
  "漢",
  "ファ",
  "\u{1F600}",
  "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}",
  "\u{1F1EF}\u{1F1F5}",
  "e\u0301",
  " \u0301",
  "\u2764\uFE0F",
  "a\u0300\u0301\u0302",
];
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

test("generated mixed-script fields: lines fit, keep clusters whole, never start with a mark", () => {
  const text = fc
    .array(fc.constantFrom(...CLUSTERS), { minLength: 1, maxLength: 60 })
    .map((parts) => parts.join(""));
  fc.assert(
    fc.property(
      text,
      text,
      text,
      fc.integer({ min: 8, max: 60 }),
      (invariant, path, head, width) => {
        const summaries = [
          summarizeReview(review({ bundleDigest: head, findings: [finding({ path, invariant })] })),
          summarizeVerdict(
            claims({
              snapshot: { head, clean: false, diffDigest: head },
              claims: [{ id: path, outcome: "REFUTED", note: invariant }],
            }),
          ),
        ];
        for (const summary of summaries) {
          for (const line of texts(layoutSummary(summary, width))) {
            assert.ok(
              visibleWidth(line) <= width,
              `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`,
            );
            assert.equal(LONE_SURROGATE.test(line), false, JSON.stringify(line));
            // No grapheme cluster of the line, the first included, starts with a mark: nothing was cut off its base.
            for (const { segment } of GRAPHEMES.segment(line)) {
              assert.equal(/^\p{M}/u.test(segment), false, JSON.stringify(line));
            }
          }
          for (const part of [summary.footer, ...summary.entries.map(entryText)]) {
            assert.equal(LONE_SURROGATE.test(part), false, JSON.stringify(part));
          }
        }
      },
    ),
    { numRuns: 300, seed: 26 },
  );
});

test("a shortened field keeps whole clusters", () => {
  const flags = "\u{1F1EF}\u{1F1F5}".repeat(10);
  const summary = summarizeVerdict(claims({ snapshot: { head: flags, clean: true } }));
  assert.match(summary.footer, /snapshot (\u{1F1EF}\u{1F1F5})+… clean/u);
});
