import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { runInChildSessionContext } from "../../choco-pi-subagents/src/child-context.ts";
import shellsExtension from "../src/index.ts";
import type { ShellManager } from "../src/shell-manager.ts";

const managerKey = Symbol.for("choco-pi-shells:manager");
const packageCwd = resolve(import.meta.dirname, "..");

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: object;
}

interface SchemaField {
  type?: string;
  description?: string;
  minimum?: number;
  maximum?: number;
}

interface ToolParameters {
  type?: string;
  properties?: Record<string, SchemaField>;
  required?: string[];
  additionalProperties?: boolean;
}

interface ShellToolParams {
  command?: string;
  cwd?: string;
  name?: string;
  shell_id?: string;
  stdout_offset?: number;
  stderr_offset?: number;
  max_bytes?: number;
}

interface TestContext {
  cwd: string;
  sessionManager: { getSessionId(): string };
  ui: { notify(message: string, level: string): void };
}

interface ToolDefinition {
  name: string;
  parameters: ToolParameters;
  execute(
    toolCallId: string,
    params: ShellToolParams,
    signal: AbortSignal,
    onUpdate: () => void,
    ctx: TestContext,
  ): Promise<ToolResult>;
}

interface CommandDefinition {
  description: string;
  handler(args: string, ctx: TestContext): Promise<void>;
}

interface ShutdownEventFixture {
  type?: "session_shutdown";
  reason: "quit" | "reload" | "new" | "resume" | "fork";
}

type ShutdownHandler = (event: ShutdownEventFixture, ctx: TestContext) => Promise<void>;

interface Notice {
  message: string;
  level: string;
}

interface Activation {
  tools: Map<string, ToolDefinition>;
  command?: CommandDefinition;
  shutdown?: ShutdownHandler;
}

interface GlobalFixtureRegistry {
  [managerKey]?: ShellManager;
}

function activate(child: boolean): Promise<Activation> {
  const activation: Activation = { tools: new Map() };
  const fixture = {
    registerTool(tool: ToolDefinition) {
      activation.tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: CommandDefinition) {
      assert.equal(name, "shells");
      activation.command = command;
    },
    on(event: string, handler: ShutdownHandler) {
      assert.equal(event, "session_shutdown");
      activation.shutdown = handler;
    },
  };
  // SAFETY: This fixture implements every ExtensionAPI method exercised during shell activation.
  const extensionFixture = fixture as ExtensionAPI;
  const register = async () => shellsExtension(extensionFixture);
  return (child ? runInChildSessionContext(register) : register()).then(() => activation);
}

function context(sessionId: string, notices: Notice[] = [], cwd = packageCwd): TestContext {
  return {
    cwd,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      notify(message: string, level: string) {
        notices.push({ message, level });
      },
    },
  };
}

function tool(activation: Activation, name: string): ToolDefinition {
  const definition = activation.tools.get(name);
  assert.ok(definition, `missing tool ${name}`);
  return definition;
}

async function execute(
  activation: Activation,
  name: string,
  params: ShellToolParams,
  sessionId: string,
  cwd = packageCwd,
): Promise<ToolResult> {
  return tool(activation, name).execute(
    "call-id",
    params,
    new AbortController().signal,
    () => {},
    context(sessionId, [], cwd),
  );
}

function details<Details extends object>(result: ToolResult): Details {
  assert.equal(result.content.length, 1);
  const content = result.content[0];
  assert.ok(content);
  assert.equal(content.type, "text");
  assert.deepEqual(JSON.parse(content.text), result.details);
  // SAFETY: The serialized content and details were compared above; callers provide the expected fixture type.
  return result.details as Details;
}

function registry(): typeof globalThis & GlobalFixtureRegistry {
  // SAFETY: The production extension owns this Symbol.for slot and stores only a ShellManager there.
  return globalThis as typeof globalThis & GlobalFixtureRegistry;
}

test("extension registers documented portable tool schemas and the /shells command", async () => {
  assert.equal(registry()[managerKey], undefined);
  const root = await activate(false);
  try {
    assert.deepEqual(
      [...root.tools.keys()],
      ["shell_start", "shell_read", "shell_stop", "shell_list"],
    );
    const expectedSchemas = new Map<string, { properties: string[]; required: string[] }>([
      ["shell_start", { properties: ["command", "cwd", "name"], required: ["command"] }],
      [
        "shell_read",
        {
          properties: ["shell_id", "stdout_offset", "stderr_offset", "max_bytes"],
          required: ["shell_id"],
        },
      ],
      ["shell_stop", { properties: ["shell_id"], required: ["shell_id"] }],
      ["shell_list", { properties: [], required: [] }],
    ]);
    for (const [name, expectedSchema] of expectedSchemas) {
      const schema = tool(root, name).parameters;
      assert.equal(schema.type, "object");
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(Object.keys(schema.properties ?? {}), expectedSchema.properties);
      assert.deepEqual(schema.required ?? [], expectedSchema.required);
    }
    const startTool = tool(root, "shell_start");
    const readTool = tool(root, "shell_read");
    assert.match(startTool.parameters.properties?.command?.description ?? "", /background/);
    assert.match(startTool.parameters.properties?.cwd?.description ?? "", /calling session cwd/);
    assert.match(readTool.parameters.properties?.stdout_offset?.description ?? "", /nextOffset/);
    assert.match(readTool.parameters.properties?.stderr_offset?.description ?? "", /nextOffset/);
    assert.equal(readTool.parameters.properties?.max_bytes?.maximum, 262_144);
    assert.equal(root.command?.description, "List, read, or stop managed shells");

    const notices: Notice[] = [];
    const commandContext = context("root", notices);
    assert.ok(root.command);
    await root.command.handler("read", commandContext);
    await root.command.handler("nonsense", commandContext);
    await root.command.handler("read missing-shell", commandContext);
    assert.deepEqual(notices, [
      { message: "Usage: /shells read <id>", level: "warning" },
      { message: "Usage: /shells [list | read <id> | stop <id>]", level: "warning" },
      { message: "Shell not found: missing-shell", level: "error" },
    ]);
  } finally {
    assert.ok(root.shutdown);
    await root.shutdown({ reason: "quit" }, context("root"));
    assert.equal(registry()[managerKey], undefined);
  }
});

test("child shell_start resolves relative cwd from its tool context", async () => {
  assert.equal(registry()[managerKey], undefined);
  const root = await activate(false);
  const child = await activate(true);
  try {
    const childContextCwd = resolve(packageCwd, "tests");
    assert.notEqual(childContextCwd, process.cwd());
    const started = details<{ cwd: string; state: string }>(
      await execute(
        child,
        "shell_start",
        { command: "while :; do sleep 1; done", cwd: ".." },
        "child-relative-cwd",
        childContextCwd,
      ),
    );
    assert.equal(started.cwd, resolve(childContextCwd, ".."));
    assert.equal(started.state, "running");
  } finally {
    assert.ok(child.shutdown);
    await child.shutdown({ reason: "quit" }, context("child-relative-cwd"));
    assert.ok(root.shutdown);
    await root.shutdown({ reason: "quit" }, context("root"));
  }
});

test("shell_start reports an invalid cwd as an error without retaining a running shell", async () => {
  assert.equal(registry()[managerKey], undefined);
  const root = await activate(false);
  try {
    const result = details<{ error: string }>(
      await execute(
        root,
        "shell_start",
        { command: "while :; do sleep 1; done", cwd: "missing-directory" },
        "root-session",
      ),
    );
    assert.match(result.error, /cwd is not an existing directory/);
    assert.deepEqual(
      details<{ shells: object[] }>(await execute(root, "shell_list", {}, "root-session")).shells,
      [],
    );
  } finally {
    assert.ok(root.shutdown);
    await root.shutdown({ reason: "quit" }, context("root-session"));
  }
});

test("tool and command handlers preserve ownership and defensively handle direct child shutdown", async () => {
  assert.equal(registry()[managerKey], undefined);
  const root = await activate(false);
  let child: Activation | undefined;
  try {
    child = await activate(true);
    const rootStarted = details<{ shellId: string; ownerId: string; state: string }>(
      await execute(
        root,
        "shell_start",
        { command: "while :; do sleep 1; done", name: "root-shell" },
        "root-session",
      ),
    );
    const childStarted = details<{ shellId: string; ownerId: string; state: string }>(
      await execute(
        child,
        "shell_start",
        { command: "while :; do sleep 1; done", name: "child-shell" },
        "child-session",
      ),
    );
    assert.equal(rootStarted.ownerId, "root-session");
    assert.equal(childStarted.ownerId, "child-session");

    const childList = details<{ shells: Array<{ shellId: string }> }>(
      await execute(child, "shell_list", {}, "child-session"),
    );
    assert.deepEqual(
      childList.shells.map((shell) => shell.shellId),
      [childStarted.shellId],
    );

    const denied = details<{ error: string }>(
      await execute(child, "shell_read", { shell_id: rootStarted.shellId }, "child-session"),
    );
    assert.match(denied.error, /Access denied/);
    const missing = details<{ error: string }>(
      await execute(child, "shell_stop", { shell_id: "missing" }, "child-session"),
    );
    assert.equal(missing.error, "Shell not found: missing");

    const rootRead = details<{ shell: { shellId: string; ownerId: string } }>(
      await execute(root, "shell_read", { shell_id: childStarted.shellId }, "root-session"),
    );
    assert.equal(rootRead.shell.ownerId, "child-session");

    const commandNotices: Notice[] = [];
    const commandContext = context("root-session", commandNotices);
    assert.ok(root.command);
    await root.command.handler("list", commandContext);
    await root.command.handler(`read ${childStarted.shellId}`, commandContext);
    assert.equal(commandNotices.length, 2);
    assert.deepEqual(
      commandNotices.map((notice) => notice.level),
      ["info", "info"],
    );
    assert.match(commandNotices[0]?.message ?? "", new RegExp(rootStarted.shellId));
    assert.match(commandNotices[1]?.message ?? "", new RegExp(childStarted.shellId));

    // Direct child session_shutdown coverage is defensive; the subagents cleanup bridge is the
    // production path that disposes child-owned shells.
    assert.ok(child.shutdown);
    await child.shutdown({ reason: "quit" }, context("child-session"));
    const afterChildShutdown = details<{ shells: Array<{ shellId: string; state: string }> }>(
      await execute(root, "shell_list", {}, "root-session"),
    );
    assert.equal(
      afterChildShutdown.shells.find((shell) => shell.shellId === childStarted.shellId)?.state,
      "stopped",
    );
    assert.equal(
      afterChildShutdown.shells.find((shell) => shell.shellId === rootStarted.shellId)?.state,
      "running",
    );

    await root.command.handler(`stop ${rootStarted.shellId}`, commandContext);
    assert.equal(commandNotices[2]?.level, "info");
    assert.match(commandNotices[2]?.message ?? "", /"state": "stopped"/);
  } finally {
    if (child?.shutdown) await child.shutdown({ reason: "quit" }, context("child-session"));
    assert.ok(root.shutdown);
    await root.shutdown({ reason: "quit" }, context("root-session"));
    assert.equal(registry()[managerKey], undefined);
  }
});

test("root session replacement preserves the process manager and quit removes an adopted manager", async () => {
  assert.equal(registry()[managerKey], undefined);
  let current = await activate(false);
  const originalManager = registry()[managerKey];
  assert.ok(originalManager);
  const started = details<{ shellId: string; state: string }>(
    await execute(current, "shell_start", { command: "while :; do sleep 1; done" }, "root-session"),
  );

  try {
    for (const reason of ["reload", "new", "resume", "fork"] as const) {
      assert.ok(current.shutdown);
      await current.shutdown({ reason }, context("root-session"));
      assert.strictEqual(registry()[managerKey], originalManager);

      const successor = await activate(false);
      const listed = details<{ shells: Array<{ shellId: string; state: string }> }>(
        await execute(successor, "shell_list", {}, "successor-session"),
      );
      assert.equal(
        listed.shells.find((shell) => shell.shellId === started.shellId)?.state,
        "running",
      );
      current = successor;
    }

    assert.ok(current.shutdown);
    await current.shutdown({ reason: "quit" }, context("successor-session"));
    assert.equal(registry()[managerKey], undefined);
  } finally {
    if (registry()[managerKey]) {
      assert.ok(current.shutdown);
      await current.shutdown({ reason: "quit" }, context("successor-session"));
    }
  }
});
