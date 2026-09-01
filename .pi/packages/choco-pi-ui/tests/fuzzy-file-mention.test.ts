import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { fuzzyFileMentionsEnabled } from "../../../extensions/prompt-editor.ts";
import {
  applyFileMention,
  extractFileMention,
  FuzzyFileMentionProvider,
  mentionValue,
} from "../extensions/fuzzy-mention/editor.ts";
import { IgnoreAwareFileCache, loadRgFileList } from "../extensions/fuzzy-mention/file-cache.ts";
import { matchFileMention, rankFileMentions } from "../extensions/fuzzy-mention/matcher.ts";

test("subsequence matcher resolves conceptframe to concept.frame.ts", () => {
  assert.equal(matchFileMention("conceptframe", "concept.frame.ts"), "subsequence");
  assert.deepEqual(rankFileMentions("conceptframe", ["other.ts", "concept.frame.ts"]), [
    { path: "concept.frame.ts", kind: "subsequence" },
  ]);
});

test("ranking is exact prefix, contiguous substring, then subsequence", () => {
  assert.deepEqual(
    rankFileMentions("abc", ["src/a-b-c.ts", "src/xabc.ts", "abc/deep/path.ts", "abc.ts"]),
    [
      { path: "abc.ts", kind: "exact-prefix" },
      { path: "abc/deep/path.ts", kind: "exact-prefix" },
      { path: "src/xabc.ts", kind: "contiguous" },
      { path: "src/a-b-c.ts", kind: "subsequence" },
    ],
  );
});

test("ranking ties use path depth, then path length", () => {
  assert.deepEqual(
    rankFileMentions("needle", [
      "src/long-needle-name.ts",
      "a/b/needle.ts",
      "x/needle.ts",
      "needle/with/more/depth.ts",
      "needle-longer.ts",
    ]).map(({ path }) => path),
    [
      "needle-longer.ts",
      "needle/with/more/depth.ts",
      "x/needle.ts",
      "src/long-needle-name.ts",
      "a/b/needle.ts",
    ],
  );
});

test("file cache coalesces loads and refreshes after its TTL", async () => {
  let now = 10;
  let loads = 0;
  const cache = new IgnoreAwareFileCache(
    "/repo",
    5,
    async () => {
      loads++;
      return [`file-${loads}.ts`];
    },
    () => now,
  );

  const [first, peer] = await Promise.all([cache.getFiles(), cache.getFiles()]);
  assert.deepEqual(first, ["file-1.ts"]);
  assert.deepEqual(peer, ["file-1.ts"]);
  assert.equal(loads, 1);

  now = 16;
  assert.deepEqual(await cache.getFiles(), ["file-2.ts"]);
  assert.equal(loads, 2);
});

test("rg file loader honors ignore files", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "fuzzy-mention-files-"));
  try {
    mkdirSync(join(cwd, ".git"));
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, ".gitignore"), "ignored.ts\n");
    writeFileSync(join(cwd, "ignored.ts"), "ignored\n");
    writeFileSync(join(cwd, "src", "visible.ts"), "visible\n");
    assert.deepEqual(await loadRgFileList(cwd), ["src/visible.ts"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

const slashOnlyBase = (): AutocompleteProvider => ({
  triggerCharacters: ["/"],
  async getSuggestions(lines, cursorLine, cursorCol) {
    const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
    if (/@(?:"[^"]*|[^\s@]*)$/u.test(before)) return null;
    return { prefix: "/", items: [{ value: "/help", label: "/help" }] };
  },
  applyCompletion(lines, cursorLine, cursorCol) {
    return { lines, cursorLine, cursorCol };
  },
});

test("provider owns @ mentions and delegates slash completion", async () => {
  let delegated = 0;
  const base = slashOnlyBase();
  const countingBase: AutocompleteProvider = {
    ...base,
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      delegated++;
      return base.getSuggestions(lines, cursorLine, cursorCol, options);
    },
  };
  const cache = new IgnoreAwareFileCache("/repo", 1_000, async () => [
    "concept.frame.ts",
    "notes.md",
  ]);
  const provider = new FuzzyFileMentionProvider(countingBase, cache, () => true);
  const signal = new AbortController().signal;

  const mention = await provider.getSuggestions(["see @conceptframe"], 0, 17, { signal });
  assert.equal(mention?.prefix, "@conceptframe");
  assert.deepEqual(
    mention?.items.map((item) => item.value),
    ["@concept.frame.ts"],
  );

  const slash = await provider.getSuggestions(["/"], 0, 1, { signal });
  assert.equal(slash?.items[0]?.value, "/help");
  assert.ok(delegated >= 1);
});

test("mention contexts merge base rows such as agent mentions", async () => {
  const base: AutocompleteProvider = {
    async getSuggestions(lines, cursorLine, cursorCol) {
      const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
      const match = before.match(/@(?:"[^"]*|[^\s@]*)$/u);
      if (!match) return null;
      return {
        prefix: match[0],
        items: [{ value: "@reviewer", label: "reviewer agent", description: "agent" }],
      };
    },
    applyCompletion(lines, cursorLine, cursorCol) {
      return { lines, cursorLine, cursorCol };
    },
  };
  const cache = new IgnoreAwareFileCache("/repo", 1_000, async () => [
    "concept.frame.ts",
    "notes.md",
  ]);
  const provider = new FuzzyFileMentionProvider(base, cache, () => true);
  const signal = new AbortController().signal;
  const suggestions = await provider.getSuggestions(["ask @conceptframe"], 0, 18, { signal });
  assert.equal(suggestions?.prefix, "@conceptframe");
  assert.deepEqual(
    suggestions?.items.map((item) => item.value),
    ["@reviewer", "@concept.frame.ts"],
  );
});

test("mention extraction and completion preserve surrounding multiline text", () => {
  const lines = ["before", "open (@srcconc) after", "after"];
  const cursorCol = "open (@srcconc".length;
  assert.deepEqual(extractFileMention(lines, 1, cursorCol), {
    prefix: "@srcconc",
    query: "srcconc",
  });
  assert.deepEqual(applyFileMention(lines, 1, cursorCol, "@src/concept.ts", "@srcconc"), {
    lines: ["before", "open (@src/concept.ts ) after", "after"],
    cursorLine: 1,
    cursorCol: "open (@src/concept.ts ".length,
  });
});

test("feature setting is off by default and requires literal true", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "fuzzy-mention-setting-"));
  try {
    assert.equal(fuzzyFileMentionsEnabled(agentDir), false);
    writeFileSync(join(agentDir, "settings.json"), '{"fuzzyFileMentions":false}\n');
    assert.equal(fuzzyFileMentionsEnabled(agentDir), false);
    writeFileSync(join(agentDir, "settings.json"), '{"fuzzyFileMentions":true}\n');
    assert.equal(fuzzyFileMentionsEnabled(agentDir), true);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("project setting wins over the agent profile when present", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "fuzzy-mention-agent-"));
  const projectDir = mkdtempSync(join(tmpdir(), "fuzzy-mention-project-"));
  try {
    writeFileSync(join(agentDir, "settings.json"), '{"fuzzyFileMentions":true}\n');
    // No project settings file: agent profile decides.
    assert.equal(fuzzyFileMentionsEnabled(agentDir, projectDir), true);
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "settings.json"), '{"fuzzyFileMentions":false}\n');
    // Explicit project default false overrides the agent profile true.
    assert.equal(fuzzyFileMentionsEnabled(agentDir, projectDir), false);
    writeFileSync(join(projectDir, ".pi", "settings.json"), '{"fuzzyFileMentions":true}\n');
    writeFileSync(join(agentDir, "settings.json"), '{"fuzzyFileMentions":false}\n');
    assert.equal(fuzzyFileMentionsEnabled(agentDir, projectDir), true);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("quoted @ mentions extract and complete whitespace paths", () => {
  const lines = ['see @"docs/design n done'];
  const cursorCol = 'see @"docs/design n'.length;
  assert.deepEqual(extractFileMention(lines, 0, cursorCol), {
    prefix: '@"docs/design n',
    query: "docs/design n",
  });
  assert.equal(mentionValue("docs/design notes.md"), '@"docs/design notes.md"');
  const inserted = applyFileMention(
    lines,
    0,
    cursorCol,
    mentionValue("docs/design notes.md"),
    '@"docs/design n',
  );
  assert.equal(inserted.lines[0], 'see @"docs/design notes.md"  done');
});
