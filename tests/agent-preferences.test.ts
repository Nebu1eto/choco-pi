import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_ON_USAGE_LIMIT,
  DEFAULT_PERSONA,
  AGENT_PREFERENCES_MARKER,
  AGENT_PREFERENCES_MARKER_END,
  ON_USAGE_LIMIT_VALUES,
  PERSONA_DEFINITIONS_BLOCK,
  activeAgentName,
  appendPersonaDefinitions,
  buildAgentPreferencesBlock,
  discoverAgentStyles,
  flushAgentPreferenceWrites,
  parseAgentStyleDocument,
  parsePersona,
  personaDirectiveFromPrompt,
  readAgentPreferences,
  readAgentPreferencesAsync,
  resolveAgentPersonaOverride,
  resolveAgentStyle,
  resolvePersona,
  onAgentPreferenceChange,
  writeAgentPreference,
  type AgentStyle,
} from "../.pi/extensions/lib/agent-preferences.ts";

function withTempDirs(
  run: (dirs: { agent: string; presets: string }) => void | Promise<void>,
): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-preferences-"));
    try {
      await run({ agent: path.join(root, "agent"), presets: path.join(root, "presets") });
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
  withTempDirs(async ({ agent }) => {
    mkdirSync(agent, { recursive: true });
    writeFileSync(
      path.join(agent, "settings.json"),
      JSON.stringify({ theme: "nord-dark", compaction: { enabled: true } }, null, 2),
    );
    await writeAgentPreference("agentLanguage", "Korean", agent);
    await writeAgentPreference("agentStyle", "concise", agent);
    await writeAgentPreference("sessionAutoName", false, agent);
    await writeAgentPreference("sessionAutoNameModel", "openai-codex/gpt-5.6-luna", agent);

    const preferences = readAgentPreferences(agent);
    assert.equal(preferences.language, "Korean");
    assert.equal(preferences.style, "concise");
    assert.equal(preferences.persona, DEFAULT_PERSONA);
    assert.equal(preferences.sessionAutoName, false);
    assert.equal(preferences.sessionAutoNameModel, "openai-codex/gpt-5.6-luna");

    const settings = JSON.parse(readFileSync(path.join(agent, "settings.json"), "utf8"));
    assert.equal(settings.theme, "nord-dark");
    assert.deepEqual(settings.compaction, { enabled: true });

    await writeAgentPreference("agentLanguage", undefined, agent);
    const after = readAgentPreferences(agent);
    assert.equal(after.language, undefined);
    assert.equal(after.style, "concise");
  }),
);

test(
  "store creates the settings file when missing and ignores invalid values",
  withTempDirs(async ({ agent }) => {
    const defaults = { persona: DEFAULT_PERSONA, onUsageLimit: DEFAULT_ON_USAGE_LIMIT };
    assert.deepEqual(readAgentPreferences(agent), defaults);
    assert.deepEqual(await readAgentPreferencesAsync(agent), defaults);
    await writeAgentPreference("agentStyle", "concise", agent);
    assert.equal(readAgentPreferences(agent).style, "concise");

    writeFileSync(
      path.join(agent, "settings.json"),
      JSON.stringify({ agentLanguage: "", agentStyle: 42 }),
    );
    assert.deepEqual(readAgentPreferences(agent), defaults);
    assert.deepEqual(await readAgentPreferencesAsync(agent), defaults);
  }),
);

test(
  "on-usage-limit defaults to none, round-trips every value, and rejects invalid values",
  withTempDirs(async ({ agent }) => {
    assert.equal(DEFAULT_ON_USAGE_LIMIT, "none");
    assert.equal(readAgentPreferences(agent).onUsageLimit, "none");
    assert.equal((await readAgentPreferencesAsync(agent)).onUsageLimit, "none");

    for (const value of ON_USAGE_LIMIT_VALUES) {
      await writeAgentPreference("agentOnUsageLimit", value, agent);
      const settings = JSON.parse(await readFile(path.join(agent, "settings.json"), "utf8"));
      assert.equal(settings.agentOnUsageLimit, value);
      assert.equal(readAgentPreferences(agent).onUsageLimit, value);
      assert.equal((await readAgentPreferencesAsync(agent)).onUsageLimit, value);
    }

    for (const invalid of ["bogus", "Fallback", 7, null]) {
      await writeFile(
        path.join(agent, "settings.json"),
        JSON.stringify({ agentOnUsageLimit: invalid }),
      );
      assert.equal(readAgentPreferences(agent).onUsageLimit, "none", String(invalid));
      assert.equal((await readAgentPreferencesAsync(agent)).onUsageLimit, "none", String(invalid));
    }
  }),
);

test(
  "the async reader surfaces the same parse errors as the sync reader",
  withTempDirs(async ({ agent }) => {
    await mkdir(agent, { recursive: true });
    await writeFile(path.join(agent, "settings.json"), "{ not json");
    assert.throws(() => readAgentPreferences(agent), /Could not parse/);
    await assert.rejects(readAgentPreferencesAsync(agent), /Could not parse/);

    await writeFile(path.join(agent, "settings.json"), "[]");
    assert.throws(() => readAgentPreferences(agent), /Expected a JSON object/);
    await assert.rejects(readAgentPreferencesAsync(agent), /Expected a JSON object/);
  }),
);

test(
  "the async writer keeps the file format, leaves no temporary file, and serializes writes",
  withTempDirs(async ({ agent }) => {
    await mkdir(agent, { recursive: true });
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ theme: "nord-dark" }));
    await writeAgentPreference("agentOnUsageLimit", "fallback", agent);
    assert.equal(
      await readFile(path.join(agent, "settings.json"), "utf8"),
      `${JSON.stringify({ theme: "nord-dark", agentOnUsageLimit: "fallback" }, null, 2)}\n`,
    );
    assert.deepEqual(await readdir(agent), ["settings.json"]);

    const concurrent = [
      writeAgentPreference("agentLanguage", "Korean", agent),
      writeAgentPreference("agentStyle", "concise", agent),
      writeAgentPreference("agentOnUsageLimit", "auto-resume", agent),
      writeAgentPreference("sessionAutoName", false, agent),
    ];
    await Promise.all(concurrent);
    await flushAgentPreferenceWrites();
    const settings = JSON.parse(await readFile(path.join(agent, "settings.json"), "utf8"));
    assert.deepEqual(settings, {
      theme: "nord-dark",
      agentOnUsageLimit: "auto-resume",
      agentLanguage: "Korean",
      agentStyle: "concise",
      sessionAutoName: false,
    });
    assert.deepEqual(await readdir(agent), ["settings.json"]);
  }),
);

test(
  "a failed write rejects its caller without blocking later writes",
  withTempDirs(async ({ agent }) => {
    await mkdir(agent, { recursive: true });
    await writeFile(path.join(agent, "settings.json"), "{ not json");
    await assert.rejects(
      writeAgentPreference("agentOnUsageLimit", "fallback", agent),
      /Could not parse/,
    );
    await writeFile(path.join(agent, "settings.json"), "{}");
    await writeAgentPreference("agentOnUsageLimit", "fallback", agent);
    assert.equal(readAgentPreferences(agent).onUsageLimit, "fallback");
  }),
);

test(
  "preference-change listeners observe persisted writes, can unsubscribe, and cannot break writes",
  withTempDirs(async ({ agent }) => {
    const changes: { key: string; value: unknown }[] = [];
    const unsubscribe = onAgentPreferenceChange((change) => changes.push(change));
    const unsubscribeThrowing = onAgentPreferenceChange(() => {
      throw new Error("listener failure");
    });

    await writeAgentPreference("agentLanguage", "Korean", agent);
    assert.deepEqual(changes, [{ key: "agentLanguage", value: "Korean" }]);

    unsubscribe();
    unsubscribeThrowing();
    await writeAgentPreference("agentStyle", "concise", agent);
    assert.deepEqual(changes, [{ key: "agentLanguage", value: "Korean" }]);
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
  assert.ok(languageOnly?.includes("Korean"));
  assert.ok(languageOnly?.includes(AGENT_PREFERENCES_MARKER));
  assert.ok(languageOnly?.endsWith(AGENT_PREFERENCES_MARKER_END));
  assert.ok(!languageOnly.includes("Be brief."));

  const both = buildAgentPreferencesBlock(
    { persona: "critical", language: "Japanese", style: "concise" },
    resolver,
  );
  assert.ok(both?.includes("Japanese"));
  assert.ok(both?.includes("Be brief."));

  const styleOnly = buildAgentPreferencesBlock({ persona: "critical", style: "concise" }, resolver);
  assert.ok(styleOnly?.includes(AGENT_PREFERENCES_MARKER));
  assert.ok(styleOnly?.includes("Be brief."));
  assert.ok(!styleOnly?.includes("Korean") && !styleOnly?.includes("Japanese"));
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
  "persona settings default to pessimistic and preserve explicit values",
  withTempDirs(async ({ agent }) => {
    assert.equal(readAgentPreferences(agent).persona, "pessimistic");

    mkdirSync(agent, { recursive: true });
    writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ agentPersona: "wrong" }));
    assert.equal(readAgentPreferences(agent).persona, "pessimistic");

    await writeAgentPreference("agentPersona", "critical", agent);
    assert.equal(readAgentPreferences(agent).persona, "critical");

    await writeAgentPreference("agentPersona", "unset", agent);
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
