import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  MarkdownMessageType,
  MarkdownTransformContext,
  MarkdownTransformer,
  MarkdownTransformerOptions,
} from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth, type MarkdownTheme } from "@earendil-works/pi-tui";
import verdictBlockRender, {
  RAW_BLOCK_MAX_MESSAGE_LINES,
  renderVerdictBlocks,
  VERDICT_RENDER_MESSAGE_TYPES,
} from "../.pi/extensions/verdict-block-render.ts";
import { reinterpretHostValue } from "../.pi/extensions/lib/runtime-values.ts";
import { MAX_ANALYZED_CHARS } from "../.pi/extensions/lib/verdict-summary.ts";

const FENCE = "\u0060\u0060\u0060";

const FINDINGS = {
  schema: 1,
  verdict: "FINDINGS",
  bundleDigest: "sha256:u26bundle",
  findings: [
    {
      id: "F1",
      class: "finding",
      severity: "high",
      path: "notes.txt",
      startLine: 1,
      endLine: 2,
      invariant: "notes.txt keeps two lines",
      evidence: "reproduction",
      reproduction: "wc -l notes.txt",
    },
    {
      id: "C1",
      class: "candidate",
      severity: "low",
      path: "notes.txt",
      invariant: "line two stays last",
      evidence: "code_path",
      reproduction: "",
    },
  ],
};

function fenced(info: string, json: string, indent = ""): string {
  return [
    indent + FENCE + info,
    ...json.split("\n").map((line) => indent + line),
    indent + FENCE,
  ].join("\n");
}

function context(overrides: Partial<MarkdownTransformContext> = {}): MarkdownTransformContext {
  return { messageType: "assistant", isStreaming: false, availableWidth: 100, ...overrides };
}

const VALID =
  "## Findings\n\nOne finding, one candidate.\n\n" +
  fenced("choco-pi-review", JSON.stringify(FINDINGS, null, 2));
/** The same block on one line, so the message is short enough to keep the raw fence. */
const SHORT =
  "One finding, one candidate.\n\n" + fenced("choco-pi-review", JSON.stringify(FINDINGS));

test("a message without a block is returned unchanged", () => {
  const plain = "No review here.\n\n" + FENCE + "ts\nconst x = 1;\n" + FENCE;
  assert.equal(renderVerdictBlocks(plain, context()), plain);
  const prose = "The choco-pi-review block is described in the policy.";
  assert.equal(renderVerdictBlocks(prose, context()), prose);
});

test("a parsed block in a short message becomes a summary followed by the original fence", () => {
  const output = renderVerdictBlocks(SHORT, context());
  const summaryAt = output.indexOf(
    "**Review FINDINGS\\: 1 finding (1 high)\\; 1 candidate (1 low)**",
  );
  assert.ok(summaryAt > 0, output);
  assert.ok(summaryAt > output.indexOf("One finding, one candidate."), output);
  assert.ok(
    output.includes("- HIGH finding · notes\\.txt\\:1\\-2 · notes\\.txt keeps two lines"),
    output,
  );
  assert.ok(
    output.includes("- low CANDIDATE (unconfirmed) · notes\\.txt · line two stays last"),
    output,
  );
  assert.ok(output.trimEnd().endsWith(fenced("choco-pi-review", JSON.stringify(FINDINGS))), output);
});

test("a parsed block in a long message is replaced by the summary and a note", () => {
  const prose = Array.from(
    { length: RAW_BLOCK_MAX_MESSAGE_LINES },
    (_, index) => `Line ${index}.`,
  ).join("\n");
  const output = renderVerdictBlocks(
    prose + "\n\n" + fenced("choco-pi-review", JSON.stringify(FINDINGS, null, 2)),
    context(),
  );
  assert.ok(!output.includes(FENCE + "choco-pi-review"), output);
  assert.ok(!output.includes('"verdict"'), output);
  assert.match(
    output,
    /\*Raw choco-pi-review block \(\d+ lines\) hidden here; the stored message keeps it\.\*/,
  );
  assert.ok(output.startsWith("Line 0."), output.slice(0, 40));
});

test("a streaming message and an unterminated fence are left alone", () => {
  assert.equal(renderVerdictBlocks(VALID, context({ isStreaming: true })), VALID);
  const open = "Partial reply.\n\n" + FENCE + 'choco-pi-review\n{ "schema": 1,';
  assert.equal(renderVerdictBlocks(open, context()), open);
});

function assertNotice(markdown: string, reason: RegExp): void {
  const output = renderVerdictBlocks(markdown, context());
  assert.ok(output.endsWith(markdown), "the message is shown as it is");
  const notice = output.slice(0, output.length - markdown.length);
  assert.match(notice, /^\*\*Invalid choco\\-pi\\-review block\\, not summarised\\: /);
  assert.equal(notice.split("\n").filter((line) => line !== "").length, 1, notice);
  assert.match(notice, reason);
  assert.ok(!notice.includes("Review FINDINGS"), notice);
}

test("an invalid block is shown as it is after one line with the parser's reason", () => {
  assertNotice("Done.\n\n" + fenced("choco-pi-review", "{ not json"), /not valid JSON/);
  assertNotice(
    "Done.\n\n" + fenced("choco-pi-review", JSON.stringify({ ...FINDINGS, findings: [] })),
    /FINDINGS requires at least one finding/,
  );
});

test("two blocks, prose after the block, and quoted or nested blocks are invalid by the parser", () => {
  const clean = { schema: 1, verdict: "NO_FINDINGS", bundleDigest: "d", findings: [] };
  assertNotice(
    fenced("choco-pi-review", JSON.stringify(clean)) +
      "\n\n" +
      fenced("choco-pi-review", JSON.stringify(FINDINGS, null, 2)),
    /more than one/,
  );
  assertNotice(VALID + "\n\nThat is all.", /text follows/);
  assertNotice(
    "Example:\n\n" +
      FENCE +
      FENCE +
      "markdown\n" +
      fenced("choco-pi-review", JSON.stringify(FINDINGS, null, 2)) +
      "\n" +
      FENCE +
      FENCE,
    /names choco\\-pi\\-review/,
  );
  assertNotice(
    "Quoted:\n\n" + fenced("choco-pi-review", JSON.stringify(FINDINGS, null, 2), "> "),
    /names choco\\-pi\\-review/,
  );
});

test("an untrusted reason cannot form Markdown structure in the notice", () => {
  const id = "x](https://evil.example) # NO_FINDINGS \u001b]52;c;eA==\u0007";
  const duplicate = { ...FINDINGS.findings[0], id };
  const hostile = { ...FINDINGS, findings: [duplicate, duplicate] };
  const output = renderVerdictBlocks(
    "R.\n\n" + fenced("choco-pi-review", JSON.stringify(hostile)),
    context(),
  );
  const notice = output.split("\n")[0] ?? "";
  const marking: MarkdownTheme = {
    ...PLAIN_THEME,
    link: (text) => `<L>${text}</L>`,
    heading: (text) => `<H>${text}</H>`,
  };
  const rendered = new Markdown(notice, 0, 0, marking).render(400).map((line) => line.trimEnd());
  assert.equal(rendered.length, 1, rendered.join("\n"));
  const line = rendered[0] ?? "";
  assert.ok(
    line.endsWith("duplicate finding id x](https://evil.example) # NO_FINDINGS ␛]52;c;eA==␇"),
    line,
  );
  assert.ok(!line.includes("<L>") && !line.includes("<H>"), line);
});

test("only assistant and custom Markdown is transformed", () => {
  assert.deepEqual([...VERDICT_RENDER_MESSAGE_TYPES], ["assistant", "custom"]);
  assert.notEqual(renderVerdictBlocks(VALID, context({ messageType: "custom" })), VALID);
  const others: MarkdownMessageType[] = ["user", "assistant-thinking", "summary", "changelog"];
  for (const messageType of others) {
    assert.equal(renderVerdictBlocks(VALID, context({ messageType })), VALID, messageType);
  }
  let registered:
    | { transformer: MarkdownTransformer; options?: MarkdownTransformerOptions }
    | undefined;
  const pi = reinterpretHostValue<ExtensionAPI>({
    registerMarkdownTransformer: (
      transformer: MarkdownTransformer,
      options?: MarkdownTransformerOptions,
    ) => {
      registered = { transformer, options };
    },
  });
  verdictBlockRender(pi);
  assert.equal(registered?.transformer, renderVerdictBlocks);
  assert.deepEqual(registered?.options?.messageTypes, ["assistant", "custom"]);
});

test("a message over the analysis bound is returned unchanged", () => {
  const long =
    "x".repeat(MAX_ANALYZED_CHARS) +
    "\n\n" +
    fenced("choco-pi-review", JSON.stringify(FINDINGS, null, 2));
  assert.equal(renderVerdictBlocks(long, context()) === long, true);
});

const PLAIN_THEME: MarkdownTheme = {
  heading: (text) => text,
  link: (text) => text,
  linkUrl: (text) => text,
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: (text) => text,
  quote: (text) => text,
  quoteBorder: (text) => text,
  hr: (text) => text,
  listBullet: (text) => text,
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

test("through Pi's Markdown renderer the summary fits narrow widths and reads plainly", () => {
  for (const width of [24, 60, 170]) {
    const markdown = new Markdown(VALID, 1, 0, PLAIN_THEME, undefined, {
      transform: (text, availableWidth) => renderVerdictBlocks(text, context({ availableWidth })),
    });
    const lines = markdown.render(width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, JSON.stringify(line));
    const joined = lines.map((line) => line.trim()).join(" ");
    assert.ok(joined.includes("HIGH finding"), joined);
    assert.ok(joined.includes("CANDIDATE (unconfirmed)"), joined);
  }
});

async function hostFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

test("Pi applies Markdown transformers only in interactive mode; print, RPC and ACP never call them", async () => {
  const dist = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const callers: string[] = [];
  for (const file of await hostFiles(dist)) {
    if (file.includes(`${path.sep}bundle${path.sep}`)) continue;
    const text = await readFile(file, "utf8");
    if (/getMarkdownTransformers\(|createMarkdownTransform\(/.test(text))
      callers.push(path.relative(dist, file));
  }
  assert.ok(callers.length > 0);
  for (const caller of callers) {
    assert.ok(
      caller.startsWith(path.join("modes", "interactive")) ||
        caller === path.join("core", "extensions", "runner.js"),
      caller,
    );
  }
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  for (const file of await readdir(path.join(root, ".pi/packages/choco-pi-acp/src"), {
    recursive: true,
  })) {
    if (!file.endsWith(".ts")) continue;
    const text = await readFile(path.join(root, ".pi/packages/choco-pi-acp/src", file), "utf8");
    assert.ok(!/MarkdownTransform|markdownTransform/.test(text), file);
  }
});
