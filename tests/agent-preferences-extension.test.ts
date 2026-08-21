import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import runtimeAgentPreferences from "../.pi/extensions/runtime-agent-preferences.ts";

type Handler = (event: RuntimeValue, ctx: RuntimeValue) => RuntimeValue;

interface ApiFixture {
  handlers: Map<string, Handler>;
  api: RuntimeValue;
}

/** Minimal stand-in for the host extension API, capturing registered handlers. */
function createApi(): ApiFixture {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    api: { on: (event: string, handler: Handler) => handlers.set(event, handler) },
  };
}

function withAgentDir(run: (agentDir: string) => void): () => void {
  return () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-preferences-ext-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    try {
      run(root);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function writeSettings(agentDir: string, settings: Record<string, string>): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
}

function writeUserStyle(agentDir: string, name: string, body: string): void {
  const dir = path.join(agentDir, "agent-styles");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\n---\n\n${body}\n`);
}

test(
  "the extension appends language and user style to the live system prompt",
  withAgentDir((agentDir) => {
    writeSettings(agentDir, { agentLanguage: "Korean", agentStyle: "house-style" });
    writeUserStyle(agentDir, "house-style", "Always answer with a numbered checklist.");

    const { handlers, api } = createApi();
    // SAFETY: the stub implements the single `on` member this extension uses.
    runtimeAgentPreferences(api as never);

    const handler = handlers.get("before_agent_start");
    assert.ok(handler);
    const result = handler({ systemPrompt: "BASE PROMPT" }, {});
    // SAFETY: the handler returns the documented `{ systemPrompt }` patch for a configured profile.
    const patched = (result as { systemPrompt: string }).systemPrompt;
    assert.ok(patched.startsWith("BASE PROMPT"));
    assert.ok(patched.includes("<choco_pi_agent_preferences>"));
    assert.ok(patched.includes("Preferred response language: Korean"));
    assert.ok(patched.includes("Agent style: house-style"));
    assert.ok(patched.includes("Always answer with a numbered checklist."));

    assert.equal(
      handler({ systemPrompt: patched }, {}),
      undefined,
      "an already-injected prompt must not be appended to twice",
    );
  }),
);

test(
  "the extension injects a shipped preset style by name",
  withAgentDir((agentDir) => {
    writeSettings(agentDir, { agentStyle: "concise" });
    const { handlers, api } = createApi();
    // SAFETY: the stub implements the single `on` member this extension uses.
    runtimeAgentPreferences(api as never);

    const handler = handlers.get("before_agent_start");
    assert.ok(handler);
    // SAFETY: the handler returns the documented `{ systemPrompt }` patch for a configured profile.
    const patched = (handler({ systemPrompt: "BASE" }, {}) as { systemPrompt: string })
      .systemPrompt;
    assert.ok(patched.includes("Agent style: concise"));
    assert.ok(!patched.includes("Preferred response language"));
  }),
);

test(
  "an unset profile injects nothing and a missing style warns once at session start",
  withAgentDir((agentDir) => {
    writeSettings(agentDir, {});
    const { handlers, api } = createApi();
    // SAFETY: the stub implements the single `on` member this extension uses.
    runtimeAgentPreferences(api as never);

    const before = handlers.get("before_agent_start");
    assert.ok(before);
    assert.equal(before({ systemPrompt: "BASE" }, {}), undefined);

    writeSettings(agentDir, { agentStyle: "does-not-exist" });
    assert.equal(before({ systemPrompt: "BASE" }, {}), undefined);

    const notices: string[] = [];
    const sessionStart = handlers.get("session_start");
    assert.ok(sessionStart);
    sessionStart({}, { hasUI: true, ui: { notify: (message: string) => notices.push(message) } });
    assert.equal(notices.length, 1);
    assert.match(notices[0], /does-not-exist/);
  }),
);

test(
  "an unreadable settings file degrades to no injection",
  withAgentDir((agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path.join(agentDir, "settings.json"), "{ not json");
    const { handlers, api } = createApi();
    // SAFETY: the stub implements the single `on` member this extension uses.
    runtimeAgentPreferences(api as never);

    const handler = handlers.get("before_agent_start");
    assert.ok(handler);
    assert.equal(handler({ systemPrompt: "BASE" }, {}), undefined);
  }),
);
