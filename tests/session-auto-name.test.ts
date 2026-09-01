import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import {
  firstSuccessfulInteraction,
  registerSessionAutoName,
  sanitizeSessionTitle,
  type SessionTitleGenerator,
} from "../.pi/extensions/session-auto-name.ts";

type Handler = (event: RuntimeValue, ctx: ExtensionContext) => RuntimeValue | Promise<RuntimeValue>;

interface TestMessageEntry {
  type: string;
  message: {
    role: "user" | "assistant";
    content: Array<{ type: string; text: string }>;
    stopReason?: string;
  };
}

function message(role: "user" | "assistant", text: string, stopReason = "stop") {
  const entry: TestMessageEntry = {
    type: "message",
    message: {
      role,
      content: [{ type: "text", text }],
    },
  };
  if (role === "assistant") entry.message.stopReason = stopReason;
  return entry;
}

function createHarness(generateTitle: SessionTitleGenerator) {
  const handlers = new Map<string, Handler[]>();
  let sessionId = "session-one";
  let sessionName: string | undefined;
  let entries: RuntimeValue[] = [
    message("user", "Implement automatic names"),
    message("assistant", "Done"),
  ];
  const pi = reinterpretHostValue<ExtensionAPI>({
    on: (event: string, handler: Handler) => {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    getSessionName: () => sessionName,
    setSessionName: (name: string) => {
      sessionName = name;
    },
  });
  registerSessionAutoName(pi, generateTitle);
  const ctx = reinterpretHostValue<ExtensionContext>({
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => entries,
    },
    modelRegistry: { getAvailable: () => [] },
    scopedModels: [],
  });
  const emit = async (event: string, payload: RuntimeValue = { type: event }) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    emit,
    ctx,
    get name() {
      return sessionName;
    },
    setName: (name: string | undefined) => {
      sessionName = name;
    },
    setEntries: (value: RuntimeValue[]) => {
      entries = value;
    },
    setSessionId: (value: string) => {
      sessionId = value;
    },
  };
}

function withAgentDir(run: (agentDir: string) => Promise<void>) {
  return async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "session-auto-name-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await run(agentDir);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(agentDir, { recursive: true, force: true });
    }
  };
}

test("title sanitization accepts one clean line and removes presentation syntax", () => {
  assert.equal(
    sanitizeSessionTitle('Title: **"Automatic Session Naming."**\nExplanation'),
    "Automatic Session Naming",
  );
  assert.equal(sanitizeSessionTitle("\n"), undefined);
});

test("only one successful assistant interaction is eligible", () => {
  const one = createHarness(async () => "unused");
  assert.deepEqual(firstSuccessfulInteraction(one.ctx), {
    user: "Implement automatic names",
    assistant: "Done",
  });
  one.setEntries([
    message("user", "First"),
    message("assistant", "Calling a tool", "toolUse"),
    message("assistant", "Succeeded"),
  ]);
  assert.deepEqual(firstSuccessfulInteraction(one.ctx), { user: "First", assistant: "Succeeded" });
  one.setEntries([
    message("user", "First"),
    message("assistant", "Failed", "error"),
    message("user", "Retry"),
    message("assistant", "Succeeded"),
  ]);
  assert.deepEqual(firstSuccessfulInteraction(one.ctx), { user: "First", assistant: "Succeeded" });
  one.setEntries([
    message("user", "First"),
    message("assistant", "One"),
    message("user", "Second"),
    message("assistant", "Two"),
  ]);
  assert.equal(firstSuccessfulInteraction(one.ctx), undefined);
});

test(
  "the first settled turn prefers the configured model and runs once",
  withAgentDir(async () => {
    const calls: string[] = [];
    const harness = createHarness(async ({ modelName }) => {
      calls.push(modelName);
      return "Automatic Session Naming";
    });
    await harness.emit("session_start");
    await harness.emit("agent_settled");
    await harness.emit("agent_settled");
    assert.equal(harness.name, "Automatic Session Naming");
    assert.deepEqual(calls, ["synthetic/hf:Qwen/Qwen3.8-27B"]);
  }),
);

test(
  "an unavailable preferred model falls back to Luna",
  withAgentDir(async () => {
    const calls: string[] = [];
    const harness = createHarness(async ({ modelName }) => {
      calls.push(modelName);
      if (calls.length === 1) throw new Error("unavailable");
      return "Luna Generated Name";
    });
    await harness.emit("session_start");
    await harness.emit("agent_settled");
    assert.equal(harness.name, "Luna Generated Name");
    assert.deepEqual(calls, ["synthetic/hf:Qwen/Qwen3.8-27B", "openai-codex/gpt-5.6-luna"]);
  }),
);

test(
  "preferences can disable naming and choose another model",
  withAgentDir(async (agentDir) => {
    writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ sessionAutoName: false, sessionAutoNameModel: "test/custom" }),
    );
    const calls: string[] = [];
    const harness = createHarness(async ({ modelName }) => {
      calls.push(modelName);
      return "Should Not Run";
    });
    await harness.emit("session_start");
    await harness.emit("agent_settled");
    assert.equal(harness.name, undefined);
    assert.deepEqual(calls, []);

    writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ sessionAutoName: true, sessionAutoNameModel: "test/custom" }),
    );
    harness.setSessionId("session-two");
    await harness.emit("session_start");
    await harness.emit("agent_settled");
    assert.equal(harness.name, "Should Not Run");
    assert.deepEqual(calls, ["test/custom"]);
  }),
);

test(
  "an explicit name set during generation always wins",
  withAgentDir(async () => {
    let finish: ((title: string) => void) | undefined;
    const harness = createHarness(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    await harness.emit("session_start");
    const settled = harness.emit("agent_settled");
    await new Promise((resolve) => setImmediate(resolve));
    harness.setName("User Chosen Name");
    await harness.emit("session_info_changed", {
      type: "session_info_changed",
      name: "User Chosen Name",
    });
    assert.ok(finish);
    finish("Generated Name");
    await settled;
    assert.equal(harness.name, "User Chosen Name");
  }),
);

test(
  "a completion from a replaced session cannot rename the new session",
  withAgentDir(async () => {
    let finish: ((title: string) => void) | undefined;
    const harness = createHarness(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    await harness.emit("session_start");
    const settled = harness.emit("agent_settled");
    await new Promise((resolve) => setImmediate(resolve));
    harness.setSessionId("session-two");
    await harness.emit("session_start");
    assert.ok(finish);
    finish("Stale Name");
    await settled;
    assert.equal(harness.name, undefined);
  }),
);
