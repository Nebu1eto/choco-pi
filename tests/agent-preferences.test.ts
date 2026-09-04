import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_PERSONA,
  AGENT_PREFERENCES_MARKER,
  AGENT_PREFERENCES_MARKER_END,
  PERSONA_DEFINITIONS_BLOCK,
  activeAgentName,
  appendPersonaDefinitions,
  buildAgentPreferencesBlock,
  discoverAgentStyles,
  parseAgentStyleDocument,
  parsePersona,
  personaDirectiveFromPrompt,
  readAgentPreferences,
  renderPersonaAnnouncement,
  resolveAgentPersonaOverride,
  resolveAgentStyle,
  resolvePersona,
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

function withAgentDir(
  run: (dirs: { root: string; cwd: string; agentDir: string }) => void,
): () => void {
  return () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-persona-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      run({ root, cwd, agentDir });
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function writeAgent(dir: string, file: string, content: string): void {
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
    writeAgentPreference("sessionAutoName", false, agent);
    writeAgentPreference("sessionAutoNameModel", "openai-codex/gpt-5.6-luna", agent);

    const preferences = readAgentPreferences(agent);
    assert.equal(preferences.language, "Korean");
    assert.equal(preferences.style, "concise");
    assert.equal(preferences.persona, DEFAULT_PERSONA);
    assert.equal(preferences.sessionAutoName, false);
    assert.equal(preferences.sessionAutoNameModel, "openai-codex/gpt-5.6-luna");

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
    assert.deepEqual(readAgentPreferences(agent), { persona: "critical" });
    writeAgentPreference("agentStyle", "concise", agent);
    assert.equal(readAgentPreferences(agent).style, "concise");

    writeFileSync(
      path.join(agent, "settings.json"),
      JSON.stringify({ agentLanguage: "", agentStyle: 42 }),
    );
    assert.deepEqual(readAgentPreferences(agent), { persona: "critical" });
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

  assert.equal(buildAgentPreferencesBlock({ persona: "critical" }, resolver), undefined);
  assert.equal(
    buildAgentPreferencesBlock({ persona: "critical", style: "missing" }, resolver),
    undefined,
    "a configured but unresolved style must not produce a block",
  );

  const languageOnly = buildAgentPreferencesBlock(
    { persona: "critical", language: "Korean" },
    resolver,
  );
  assert.ok(languageOnly !== undefined);
  assert.ok(languageOnly?.includes("Preferred response language: Korean"));
  assert.ok(languageOnly?.includes(AGENT_PREFERENCES_MARKER));
  assert.ok(languageOnly?.endsWith(AGENT_PREFERENCES_MARKER_END));
  assert.ok(!languageOnly.includes("Agent style:"));

  const both = buildAgentPreferencesBlock(
    { persona: "critical", language: "Japanese", style: "concise" },
    resolver,
  );
  assert.ok(both?.includes("Preferred response language: Japanese"));
  assert.ok(both?.includes("Agent style: concise\nBe brief."));

  const styleOnly = buildAgentPreferencesBlock({ persona: "critical", style: "concise" }, resolver);
  assert.ok(styleOnly?.includes(AGENT_PREFERENCES_MARKER));
  assert.ok(!styleOnly?.includes("Preferred response language"));
});

test("every block yields to explicit requests and to path-scoped project instructions", () => {
  const resolver = (name: string) =>
    name === "concise" ? styleOf("concise", "Be brief.") : undefined;
  const precedence = "an explicit request in the user's message";
  const projectRule = "path-scoped project instruction";

  for (const preferences of [
    { persona: "critical" as const, language: "Korean" },
    { persona: "critical" as const, style: "concise" },
    { persona: "critical" as const, language: "Korean", style: "concise" },
  ]) {
    const block = buildAgentPreferencesBlock(preferences, resolver);
    assert.ok(block?.includes(precedence), `${JSON.stringify(preferences)} must yield to requests`);
    assert.ok(
      block?.includes(projectRule),
      `${JSON.stringify(preferences)} must yield to projects`,
    );
  }
});

test("the language directive leaves commit messages to the repository", () => {
  const block = buildAgentPreferencesBlock(
    { persona: "critical", language: "Korean" },
    () => undefined,
  );
  assert.ok(
    block?.includes(
      "Commit messages follow the language established by the repository's own history and policy, not this setting.",
    ),
  );
});

test("persona parsing trims and normalizes only known string values", () => {
  const cases = [
    { label: "unset", value: "unset", expected: "unset" },
    { label: "mixed case", value: "CrItIcAl", expected: "critical" },
    { label: "whitespace", value: "  pessimistic\n", expected: "pessimistic" },
    { label: "invalid string", value: "optimistic", expected: undefined },
    { label: "number", value: 42, expected: undefined },
    { label: "undefined", value: undefined, expected: undefined },
  ] as const;

  for (const { label, value, expected } of cases) {
    assert.equal(parsePersona(value), expected, label);
  }
});

test(
  "persona settings default to critical and preserve explicit unset",
  withTempDirs(({ agent }) => {
    assert.equal(readAgentPreferences(agent).persona, "critical");

    mkdirSync(agent, { recursive: true });
    writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ agentPersona: "wrong" }));
    assert.equal(readAgentPreferences(agent).persona, "critical");

    writeAgentPreference("agentPersona", "unset", agent);
    assert.equal(readAgentPreferences(agent).persona, "unset");
  }),
);

test(
  "leaf persona precedence is directive then frontmatter then configured",
  withAgentDir(({ cwd, agentDir }) => {
    writeAgent(
      path.join(agentDir, "agents"),
      "implementer.md",
      String.raw`---
persona: pessimistic
---
Agent body.`,
    );
    writeAgent(
      path.join(agentDir, "agents"),
      "fallback.md",
      String.raw`---
persona: invalid
---
Agent body.`,
    );

    const leafPrompt = '<active_agent name="implementer"/>';
    assert.equal(
      resolvePersona({
        configured: "critical",
        systemPrompt: leafPrompt,
        prompt: "Persona: unset",
        cwd,
      }),
      "unset",
    );
    assert.equal(
      resolvePersona({ configured: "critical", systemPrompt: leafPrompt, prompt: "work", cwd }),
      "pessimistic",
    );
    assert.equal(
      resolvePersona({
        configured: "critical",
        systemPrompt: '<active_agent name="fallback"/>',
        prompt: "work",
        cwd,
      }),
      "critical",
    );
  }),
);

test("root persona ignores prompt directives", () => {
  assert.equal(
    resolvePersona({
      configured: "pessimistic",
      systemPrompt: "root prompt",
      prompt: "Persona: unset",
      cwd: "/unused",
    }),
    "pessimistic",
  );
});

test(
  "persona override resolves declared and filename agent names",
  withAgentDir(({ cwd, agentDir }) => {
    const globalAgents = path.join(agentDir, "agents");
    writeAgent(
      globalAgents,
      "different-file.md",
      String.raw`---
name: specialist
persona: pessimistic
---
Agent body.`,
    );
    writeAgent(
      globalAgents,
      "implementer.md",
      String.raw`---
persona: unset
---
Agent body.`,
    );

    assert.equal(resolveAgentPersonaOverride("specialist", cwd), "pessimistic");
    assert.equal(resolveAgentPersonaOverride("implementer", cwd), "unset");
  }),
);

test(
  "project persona override wins over the global agent directory",
  withAgentDir(({ cwd, agentDir }) => {
    writeAgent(
      path.join(agentDir, "agents"),
      "reviewer.md",
      String.raw`---
persona: pessimistic
---
Global body.`,
    );
    writeAgent(
      path.join(cwd, ".pi", "agents"),
      "reviewer.md",
      String.raw`---
persona: unset
---
Project body.`,
    );

    assert.equal(resolveAgentPersonaOverride("reviewer", cwd), "unset");
  }),
);

test("persona prompt parsing finds the first active agent and an exact directive line", () => {
  assert.equal(
    activeAgentName('<active_agent name="reviewer"/>\n<active_agent name="planner"/>'),
    "reviewer",
  );
  assert.equal(personaDirectiveFromPrompt("Do this\nPeRsOnA: CrItIcAl  \nnow"), "critical");
  assert.equal(personaDirectiveFromPrompt("Persona: optimistic"), undefined);
});

test("persona definitions append once and remain synchronized with the system prompt", () => {
  const appended = appendPersonaDefinitions("Base prompt");
  assert.equal(appended, `Base prompt\n\n${PERSONA_DEFINITIONS_BLOCK}`);
  assert.equal(appendPersonaDefinitions(appended), undefined);

  const systemPrompt = readFileSync(new URL("../.pi/SYSTEM.md", import.meta.url), "utf8");
  assert.ok(systemPrompt.includes(PERSONA_DEFINITIONS_BLOCK));
});

test("persona announcement uses the stable message text", () => {
  assert.equal(renderPersonaAnnouncement("critical"), "Agent persona: critical");
});
