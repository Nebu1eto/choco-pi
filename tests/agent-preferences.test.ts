import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AGENT_PREFERENCES_MARKER,
  AGENT_PREFERENCES_MARKER_END,
  buildAgentPreferencesBlock,
  discoverAgentStyles,
  parseAgentStyleDocument,
  readAgentPreferences,
  resolveAgentStyle,
  writeAgentPreference,
  type AgentStyle,
} from "../.pi/extensions/lib/agent-preferences.ts";

function withTempDirs(run: (dirs: { agent: string; presets: string }) => void): () => void {
  return () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-preferences-"));
    try {
      run({ agent: path.join(root, "agent"), presets: path.join(root, "presets") });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function writeStyle(dir: string, file: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), content, "utf8");
}

const styleOf = (name: string, body: string): AgentStyle => ({
  name,
  body,
  filePath: `/virtual/${name}.md`,
  source: "preset",
});

test(
  "store round-trips both keys and preserves unrelated settings",
  withTempDirs(({ agent }) => {
    mkdirSync(agent, { recursive: true });
    writeFileSync(
      path.join(agent, "settings.json"),
      JSON.stringify({ theme: "nord-dark", compaction: { enabled: true } }, null, 2),
    );
    writeAgentPreference("agentLanguage", "Korean", agent);
    writeAgentPreference("agentStyle", "concise", agent);

    const preferences = readAgentPreferences(agent);
    assert.equal(preferences.language, "Korean");
    assert.equal(preferences.style, "concise");

    const settings = JSON.parse(readFileSync(path.join(agent, "settings.json"), "utf8"));
    assert.equal(settings.theme, "nord-dark");
    assert.deepEqual(settings.compaction, { enabled: true });

    writeAgentPreference("agentLanguage", undefined, agent);
    const after = readAgentPreferences(agent);
    assert.equal(after.language, undefined);
    assert.equal(after.style, "concise");
  }),
);

test(
  "store creates the settings file when missing and ignores invalid values",
  withTempDirs(({ agent }) => {
    assert.deepEqual(readAgentPreferences(agent), {});
    writeAgentPreference("agentStyle", "concise", agent);
    assert.equal(readAgentPreferences(agent).style, "concise");

    writeFileSync(
      path.join(agent, "settings.json"),
      JSON.stringify({ agentLanguage: "", agentStyle: 42 }),
    );
    assert.deepEqual(readAgentPreferences(agent), {});
  }),
);

test("frontmatter parsing reads name and description and falls back cleanly", () => {
  const parsed = parseAgentStyleDocument(
    '---\nname: terse\ndescription: "Short answers"\n---\n\nBe brief.\n',
    "fallback",
  );
  assert.equal(parsed.name, "terse");
  assert.equal(parsed.description, "Short answers");
  assert.equal(parsed.body, "Be brief.");

  const bare = parseAgentStyleDocument("No frontmatter here.", "bare-name");
  assert.equal(bare.name, "bare-name");
  assert.equal(bare.description, undefined);
  assert.equal(bare.body, "No frontmatter here.");

  const malformed = parseAgentStyleDocument("---\n: bad line\nother: x\n---\nBody", "malformed");
  assert.equal(malformed.name, "malformed");
  assert.equal(malformed.body, "Body");
});

test(
  "discovery merges presets with user styles, user winning on name collision",
  withTempDirs(({ agent, presets }) => {
    writeStyle(presets, "concise.md", "---\nname: concise\n---\nPreset body");
    writeStyle(presets, "verbose.md", "---\nname: verbose\ndescription: long\n---\nVerbose body");
    writeStyle(
      path.join(agent, "agent-styles"),
      "custom.md",
      "---\nname: concise\n---\nUser override",
    );

    const styles = discoverAgentStyles(agent, presets);
    assert.deepEqual(
      styles.map((style) => style.name),
      ["concise", "verbose"],
    );
    assert.equal(styles[0].body, "User override");
    assert.equal(styles[0].source, "user");
    assert.equal(styles[1].description, "long");

    assert.equal(resolveAgentStyle("missing", agent, presets), undefined);
    assert.equal(resolveAgentStyle("verbose", agent, presets)?.source, "preset");
  }),
);

test(
  "discovery tolerates missing directories",
  withTempDirs(({ agent, presets }) => {
    assert.deepEqual(discoverAgentStyles(agent, presets), []);
  }),
);

test("injection block covers each settings combination and wraps markers", () => {
  const resolver = (name: string) =>
    name === "concise" ? styleOf("concise", "Be brief.") : undefined;

  assert.equal(buildAgentPreferencesBlock({}, resolver), undefined);
  assert.equal(
    buildAgentPreferencesBlock({ style: "missing" }, resolver),
    undefined,
    "a configured but unresolved style must not produce a block",
  );

  const languageOnly = buildAgentPreferencesBlock({ language: "Korean" }, resolver);
  assert.ok(languageOnly !== undefined);
  assert.ok(languageOnly?.includes("Preferred response language: Korean"));
  assert.ok(languageOnly?.includes(AGENT_PREFERENCES_MARKER));
  assert.ok(languageOnly?.endsWith(AGENT_PREFERENCES_MARKER_END));
  assert.ok(!languageOnly.includes("Agent style:"));

  const both = buildAgentPreferencesBlock({ language: "Japanese", style: "concise" }, resolver);
  assert.ok(both?.includes("Preferred response language: Japanese"));
  assert.ok(both?.includes("Agent style: concise\nBe brief."));

  const styleOnly = buildAgentPreferencesBlock({ style: "concise" }, resolver);
  assert.ok(styleOnly?.includes(AGENT_PREFERENCES_MARKER));
  assert.ok(!styleOnly?.includes("Preferred response language"));
});

test("language directive keeps explicit per-message requests ahead of the setting", () => {
  const block = buildAgentPreferencesBlock({ language: "Korean" }, () => undefined);
  assert.ok(block?.includes("an explicit language request in the user's message still wins"));
});
