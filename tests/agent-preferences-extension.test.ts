import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { appendPersonaDefinitions } from "../.pi/extensions/lib/agent-preferences.ts";
import { runtimeTypeOf, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import runtimeAgentPreferences from "../.pi/extensions/runtime-agent-preferences.ts";

type Handler = (event: RuntimeValue, ctx: RuntimeValue) => RuntimeValue;

interface ApiFixture {
  handlers: Map<string, Handler>;
  api: RuntimeValue;
}

interface BeforeAgentStartResult {
  systemPrompt?: string;
  message?: { customType: string; content: string; display: boolean };
}

const SYSTEM_PROMPT_WITH_PERSONAS = "BASE PROMPT\n\n## Agent persona\n\nExisting definitions.";

function asBeforeAgentStartResult(value: RuntimeValue): BeforeAgentStartResult | undefined {
  if (value === undefined) return undefined;
  assert.equal(runtimeTypeOf(value), "object");
  // SAFETY: the captured handler's documented patch shape is checked before its fields are read.
  return value as BeforeAgentStartResult;
}

function registerExtension(api: RuntimeValue): void {
  // SAFETY: `createApi` supplies the single `on` member this extension uses.
  runtimeAgentPreferences(api as never);
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
    registerExtension(api);

    const handler = handlers.get("before_agent_start");
    assert.ok(handler);
    const result = handler(
      { prompt: "Root request", systemPrompt: SYSTEM_PROMPT_WITH_PERSONAS },
      { cwd: agentDir },
    );
    const patched = asBeforeAgentStartResult(result)?.systemPrompt;
    assert.ok(patched);
    assert.ok(patched.startsWith(SYSTEM_PROMPT_WITH_PERSONAS));
    assert.ok(patched.includes("<choco_pi_agent_preferences>"));
    assert.ok(patched.includes("Preferred response language: Korean"));
    assert.ok(patched.includes("Agent style: house-style"));
    assert.ok(patched.includes("Always answer with a numbered checklist."));

    const repeated = handler({ prompt: "Next request", systemPrompt: patched }, { cwd: agentDir });
    assert.equal(
      asBeforeAgentStartResult(repeated)?.systemPrompt,
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
    registerExtension(api);

    const handler = handlers.get("before_agent_start");
    assert.ok(handler);
    const patched = asBeforeAgentStartResult(
      handler(
        { prompt: "Root request", systemPrompt: SYSTEM_PROMPT_WITH_PERSONAS },
        { cwd: agentDir },
      ),
    )?.systemPrompt;
    assert.ok(patched);
    assert.ok(patched.includes("Agent style: concise"));
    assert.ok(!patched.includes("Preferred response language"));
  }),
);

test(
  "an unset persona and profile inject nothing and a missing style warns once at session start",
  withAgentDir((agentDir) => {
    writeSettings(agentDir, { agentPersona: "unset" });
    const { handlers, api } = createApi();
    registerExtension(api);

    const before = handlers.get("before_agent_start");
    assert.ok(before);
    assert.equal(
      before(
        { prompt: "Root request", systemPrompt: SYSTEM_PROMPT_WITH_PERSONAS },
        { cwd: agentDir },
      ),
      undefined,
    );

    writeSettings(agentDir, { agentPersona: "unset", agentStyle: "does-not-exist" });
    assert.equal(
      before(
        { prompt: "Root request", systemPrompt: SYSTEM_PROMPT_WITH_PERSONAS },
        { cwd: agentDir },
      ),
      undefined,
    );

    const notices: string[] = [];
    const sessionStart = handlers.get("session_start");
    assert.ok(sessionStart);
    sessionStart({}, { hasUI: true, ui: { notify: (message: string) => notices.push(message) } });
    assert.equal(notices.length, 1);
    assert.match(notices[0], /does-not-exist/);
  }),
);

test(
  "an unreadable settings file degrades to the default persona",
  withAgentDir((agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path.join(agentDir, "settings.json"), "{ not json");
    const { handlers, api } = createApi();
    registerExtension(api);

    const handler = handlers.get("before_agent_start");
    assert.ok(handler);
    const result = asBeforeAgentStartResult(
      handler(
        { prompt: "Root request", systemPrompt: SYSTEM_PROMPT_WITH_PERSONAS },
        { cwd: agentDir },
      ),
    );
    assert.ok(result?.message);
    assert.deepEqual(result.message, {
      customType: "choco-pi-agent-persona",
      content: "Agent persona: critical",
      display: false,
    });
  }),
);

test(
  "the root announces the configured or default persona as a hidden message",
  withAgentDir((agentDir) => {
    const { handlers, api } = createApi();
    registerExtension(api);
    const handler = handlers.get("before_agent_start");
    assert.ok(handler);

    const defaultResult = asBeforeAgentStartResult(
      handler(
        { prompt: "Root request", systemPrompt: SYSTEM_PROMPT_WITH_PERSONAS },
        { cwd: agentDir },
      ),
    );
    assert.ok(defaultResult?.message);
    assert.deepEqual(defaultResult.message, {
      customType: "choco-pi-agent-persona",
      content: "Agent persona: critical",
      display: false,
    });

    writeSettings(agentDir, { agentPersona: "unset" });
    const unsetResult = handler(
      { prompt: "Root request", systemPrompt: SYSTEM_PROMPT_WITH_PERSONAS },
      { cwd: agentDir },
    );
    assert.equal(unsetResult, undefined);
  }),
);

test(
  "an inherited preferences block does not suppress the persona message",
  withAgentDir((agentDir) => {
    const { handlers, api } = createApi();
    registerExtension(api);
    const handler = handlers.get("before_agent_start");
    assert.ok(handler);
    const systemPrompt = `${SYSTEM_PROMPT_WITH_PERSONAS}\n\n<choco_pi_agent_preferences>\nInherited\n</choco_pi_agent_preferences>`;

    const result = asBeforeAgentStartResult(
      handler({ prompt: "Root request", systemPrompt }, { cwd: agentDir }),
    );
    assert.ok(result?.message);
    assert.equal(result.systemPrompt, undefined);
    assert.equal(result.message.content, "Agent persona: critical");
  }),
);

test(
  "leaf persona directives override agent frontmatter",
  withAgentDir((agentDir) => {
    const projectDir = path.join(agentDir, "project");
    const agentFile = path.join(projectDir, ".pi", "agents", "reviewer.md");
    mkdirSync(path.dirname(agentFile), { recursive: true });
    writeFileSync(agentFile, "---\npersona: pessimistic\n---\n\nReview the change.\n");

    const { handlers, api } = createApi();
    registerExtension(api);
    const handler = handlers.get("before_agent_start");
    assert.ok(handler);
    const invoke = (directive = "") =>
      asBeforeAgentStartResult(
        handler(
          {
            prompt: directive || "Review the change.",
            systemPrompt: `${SYSTEM_PROMPT_WITH_PERSONAS}\n\n<active_agent name="reviewer"/>`,
          },
          { cwd: projectDir },
        ),
      );

    assert.equal(invoke()?.message?.content, "Agent persona: pessimistic");
    assert.equal(invoke("Persona: unset"), undefined);
    assert.equal(invoke("Persona: critical")?.message?.content, "Agent persona: critical");
  }),
);

test(
  "replace-mode prompts receive persona definitions exactly once",
  withAgentDir((agentDir) => {
    writeSettings(agentDir, { agentPersona: "unset" });
    const { handlers, api } = createApi();
    registerExtension(api);
    const handler = handlers.get("before_agent_start");
    assert.ok(handler);
    const replaceSystemPrompt = 'REPLACE BASE\n\n<active_agent name="reviewer"/>';

    const first = asBeforeAgentStartResult(
      handler(
        { prompt: "Review the change.", systemPrompt: replaceSystemPrompt },
        { cwd: agentDir },
      ),
    );
    assert.ok(first?.systemPrompt);
    assert.equal(first.systemPrompt, appendPersonaDefinitions(replaceSystemPrompt));
    assert.ok(first.systemPrompt.includes("## Agent persona"));

    assert.equal(
      handler(
        { prompt: "Review the change.", systemPrompt: first.systemPrompt },
        { cwd: agentDir },
      ),
      undefined,
    );
  }),
);
