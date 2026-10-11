import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import { runInChildSessionContext } from "../../choco-pi-subagents/src/child-context.ts";
import shellsExtension, {
  type ShellCompletionDetails,
  type ShellNotificationTheme,
  renderShellCompletion,
} from "../src/index.ts";
import type { ShellLifecyclePayload } from "../src/lifecycle-events.ts";
import { ShellManager, type ShellResult } from "../src/shell-manager.ts";
import type { RuntimeValue } from "../src/validation.ts";
import type { ShellCustomOptions, ShellViewerKeybindings } from "../src/ui/shells-overlay.ts";
import type {
  ShellSectionProvider,
  ShellSectionRegistration,
} from "../../choco-pi-subagents/src/ui/shell-section-contract.ts";

const managerKey = Symbol.for("choco-pi-shells:manager");
const subagentsManagerKey = Symbol.for("pi-subagents:manager");
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
  hasUI: boolean;
  mode: "tui" | "print" | "json" | "rpc";
  sessionManager: { getSessionId(): string; getEntries(): RuntimeValue[] };
  ui: TestUI;
}

interface ToolDefinition {
  name: string;
  description: string;
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

interface SessionEventFixture {
  type?: "session_start" | "tool_execution_start" | "agent_start" | "agent_end" | "turn_end";
}
type LifecycleHandler = (
  event: SessionEventFixture | ShutdownEventFixture,
  ctx: TestContext,
) => Promise<void> | void;

interface Notice {
  message: string;
  level: string;
}

interface Activation {
  tools: Map<string, ToolDefinition>;
  events: Array<{ channel: string; payload: ShellLifecyclePayload }>;
  /** When set, events.emit throws it instead of recording, simulating a stale runtime. */
  emitError?: Error;
  emitAttempts: number;
  messages: Array<{
    message: {
      customType: string;
      content: string;
      display: boolean;
      details: ShellCompletionDetails;
    };
    options?: { triggerTurn?: boolean; deliverAs?: string };
  }>;
  renderers: Map<
    string,
    (
      message: { details?: ShellCompletionDetails },
      options: MessageRenderOptionsFixture,
      theme: Theme,
    ) => Component | undefined
  >;
  command?: CommandDefinition;
  sessionStart?: LifecycleHandler;
  toolExecutionStart?: LifecycleHandler;
  agentStart?: LifecycleHandler;
  agentEnd?: LifecycleHandler;
  turnEnd?: LifecycleHandler;
  shutdown?: LifecycleHandler;
}

interface GlobalFixtureRegistry {
  [managerKey]?: ShellManager;
  [subagentsManagerKey]?:
    | { registerShellSection(provider: ShellSectionProvider): ShellSectionRegistration }
    | { isChildSessionId(id: string): boolean };
}

interface MessageRenderOptionsFixture {
  expanded?: boolean;
}

interface ExtensionFixture {
  registerTool(tool: ToolDefinition): void;
  registerCommand(name: string, command: CommandDefinition): void;
  on(event: string, handler: LifecycleHandler): void;
  events: {
    emit(channel: string, payload: ShellLifecyclePayload): void;
    on(channel: string, handler: (payload: RuntimeValue) => void): () => void;
  };
  appendEntry(type: string, data: { keys: string[]; shells: ShellResult[] }): void;
  sendMessage(
    message: {
      customType: string;
      content: string;
      display: boolean;
      details: ShellCompletionDetails;
    },
    options?: { triggerTurn?: boolean; deliverAs?: string },
  ): void;
  registerMessageRenderer(
    type: string,
    renderer: (
      message: { details?: ShellCompletionDetails },
      options: MessageRenderOptionsFixture,
      theme: Theme,
    ) => Component | undefined,
  ): void;
}

interface WidgetCall {
  key: string;
  content: undefined | ((tui: TUI, theme: Theme) => Component);
  placement?: "aboveEditor" | "belowEditor";
}

class TestUI {
  readonly notices: Notice[];
  readonly widgetCalls: WidgetCall[] = [];
  readonly customOptions: (ShellCustomOptions | undefined)[] = [];
  readonly inputHandlers = new Set<
    (data: string) => { consume?: boolean; data?: string } | undefined
  >();
  editorText = "";

  constructor(notices: Notice[] = []) {
    this.notices = notices;
  }

  notify(message: string, level = "info"): void {
    this.notices.push({ message, level });
  }

  setWidget(
    key: string,
    content: undefined | ((tui: TUI, theme: Theme) => Component),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void {
    this.widgetCalls.push({ key, content, placement: options?.placement });
  }

  onTerminalInput(
    handler: (data: string) => { consume?: boolean; data?: string } | undefined,
  ): () => void {
    this.inputHandlers.add(handler);
    return () => this.inputHandlers.delete(handler);
  }

  getEditorText(): string {
    return this.editorText;
  }

  send(data: string): { consume?: boolean; data?: string } | undefined {
    assert.equal(this.inputHandlers.size, 1);
    const [handler] = this.inputHandlers;
    return handler?.(data);
  }

  async custom<T>(
    _factory: (
      tui: TUI,
      theme: Theme,
      keybindings: ShellViewerKeybindings | undefined,
      done: (result: T) => void,
    ) => Component,
    options?: ShellCustomOptions,
  ): Promise<T> {
    this.customOptions.push(options);
    // SAFETY: The overlay treats undefined as cancellation for every custom result used here.
    return undefined as T;
  }
}

function asExtensionAPI(fixture: ExtensionFixture): ExtensionAPI {
  // @ts-expect-error -- SAFETY: The fixture implements every API method exercised by this extension.
  return fixture as ExtensionAPI;
}

function activate(child: boolean): Promise<Activation> {
  const activation: Activation = {
    tools: new Map(),
    events: [],
    emitAttempts: 0,
    messages: [],
    renderers: new Map(),
  };
  const fixture: ExtensionFixture = {
    registerTool(tool: ToolDefinition) {
      activation.tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: CommandDefinition) {
      assert.equal(name, "shells");
      activation.command = command;
    },
    on(event: string, handler: LifecycleHandler) {
      if (event === "session_start") activation.sessionStart = handler;
      else if (event === "tool_execution_start") {
        activation.toolExecutionStart = handler;
      } else if (event === "agent_start") {
        activation.agentStart = handler;
      } else if (event === "agent_end") {
        activation.agentEnd = handler;
      } else if (event === "turn_end") {
        activation.turnEnd = handler;
      } else if (event === "session_shutdown") activation.shutdown = handler;
      else assert.fail(`unexpected event ${event}`);
    },
    events: {
      emit(channel, payload) {
        activation.emitAttempts += 1;
        if (activation.emitError) throw activation.emitError;
        activation.events.push({ channel, payload });
      },
      on() {
        return () => {};
      },
    },
    appendEntry() {},
    sendMessage(message, options) {
      activation.messages.push({ message, options });
    },
    registerMessageRenderer(type, renderer) {
      activation.renderers.set(type, renderer);
    },
  };
  const extensionFixture = asExtensionAPI(fixture);
  const register = async () => shellsExtension(extensionFixture);
  return (child ? runInChildSessionContext(register) : register()).then(() => activation);
}

function context(
  sessionId: string,
  notices: Notice[] = [],
  cwd = packageCwd,
  ui = new TestUI(notices),
  mode: TestContext["mode"] = "tui",
  hasUI = true,
): TestContext {
  return {
    cwd,
    hasUI,
    mode,
    sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
    ui,
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
    assert.equal(
      startTool.description,
      "Start a managed long-running background process. Exit is delivered as a shell-completion notification; do not poll.",
    );
    assert.match(startTool.parameters.properties?.command?.description ?? "", /long-running/i);
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

test("root UI registers one shell section per session with admin controls", async () => {
  assert.equal(registry()[managerKey], undefined);
  const previousHost = registry()[subagentsManagerKey];
  const registrations: Array<{
    provider: ShellSectionProvider;
    unregistered: boolean;
  }> = [];
  registry()[subagentsManagerKey] = {
    registerShellSection(provider) {
      const registration = { provider, unregistered: false };
      registrations.push(registration);
      return { unregister: () => (registration.unregistered = true) };
    },
  };
  const root = await activate(false);
  const child = await activate(true);
  const rootUI = new TestUI();
  try {
    assert.ok(root.sessionStart);
    assert.ok(root.toolExecutionStart);
    assert.ok(child.sessionStart);
    assert.equal(child.toolExecutionStart, undefined);

    const childUI = new TestUI();
    assert.ok(child.command);
    await child.command.handler("list", context("nested-session", [], packageCwd, childUI));
    assert.equal(childUI.customOptions.length, 0);
    assert.equal(childUI.notices.length, 1);
    assert.equal(childUI.inputHandlers.size, 0);

    const manager = registry()[managerKey];
    assert.ok(manager);
    const stopInputs: Array<{ requesterId: string; isAdmin: boolean; shellId: string }> = [];
    const originalStop = manager.stop.bind(manager);
    manager.stop = (input) => {
      stopInputs.push(input);
      return originalStop(input);
    };

    await root.sessionStart({}, context("root-session", [], packageCwd, rootUI));
    assert.equal(rootUI.widgetCalls.length, 0);
    assert.equal(rootUI.inputHandlers.size, 0);
    assert.equal(registrations.length, 1);
    const started = details<{ shellId: string; ownerId: string }>(
      await execute(
        child,
        "shell_start",
        { command: "while :; do sleep 1; done", name: "nested shell" },
        "nested-session",
      ),
    );

    assert.equal(started.ownerId, "nested-session");
    const row = registrations[0]?.provider.rows(Date.now())[0];
    assert.equal(row?.label, "nested shell");
    assert.equal(row?.ownerTag, "[owner:nested-session]");
    await registrations[0]?.provider.stop(started.shellId);
    assert.deepEqual(stopInputs, [
      { requesterId: "root-session", isAdmin: true, shellId: started.shellId },
    ]);

    const refreshedUI = new TestUI();
    await root.toolExecutionStart({}, context("root-session", [], packageCwd, refreshedUI));
    assert.equal(registrations.length, 1);

    await root.toolExecutionStart({}, context("successor-session", [], packageCwd, refreshedUI));
    assert.equal(registrations.length, 2);
    assert.equal(registrations[0]?.unregistered, true);
    assert.equal(registrations[1]?.unregistered, false);
  } finally {
    assert.ok(child.shutdown);
    await child.shutdown({ reason: "quit" }, context("nested-session"));
    assert.ok(root.shutdown);
    await root.shutdown({ reason: "quit" }, context("successor-session", [], packageCwd, rootUI));
    assert.equal(registrations.at(-1)?.unregistered, true);
    if (previousHost) registry()[subagentsManagerKey] = previousHost;
    else delete registry()[subagentsManagerKey];
  }
});

test("root UI degrades to the shells overlay when no section host exists", async () => {
  assert.equal(registry()[managerKey], undefined);
  const previousHost = registry()[subagentsManagerKey];
  delete registry()[subagentsManagerKey];
  const root = await activate(false);
  const ui = new TestUI();
  try {
    assert.ok(root.sessionStart);
    await root.sessionStart({}, context("root-session", [], packageCwd, ui));
    assert.equal(ui.widgetCalls.length, 0);
    assert.equal(ui.inputHandlers.size, 0);

    assert.ok(root.command);
    await root.command.handler("list", context("root-session", [], packageCwd, ui));
    assert.equal(ui.customOptions.length, 1);
    assert.equal(ui.customOptions[0]?.overlay, true);
    assert.equal(ui.widgetCalls.length, 0);
    assert.equal(ui.inputHandlers.size, 0);
  } finally {
    assert.ok(root.shutdown);
    await root.shutdown({ reason: "quit" }, context("root-session", [], packageCwd, ui));
    if (previousHost) registry()[subagentsManagerKey] = previousHost;
  }
});

test("root UI retries section registration after a late host appears", async () => {
  assert.equal(registry()[managerKey], undefined);
  const previousHost = registry()[subagentsManagerKey];
  delete registry()[subagentsManagerKey];
  const root = await activate(false);
  const registrations: ShellSectionProvider[] = [];
  try {
    assert.ok(root.sessionStart);
    assert.ok(root.toolExecutionStart);
    await root.sessionStart({}, context("root-session"));

    registry()[subagentsManagerKey] = {
      registerShellSection(provider) {
        registrations.push(provider);
        return { unregister() {} };
      },
    };
    await root.toolExecutionStart({}, context("root-session"));
    await root.toolExecutionStart({}, context("root-session"));
    assert.equal(registrations.length, 1);
  } finally {
    assert.ok(root.shutdown);
    await root.shutdown({ reason: "quit" }, context("root-session"));
    if (previousHost) registry()[subagentsManagerKey] = previousHost;
    else delete registry()[subagentsManagerKey];
  }
});

test("terminal shells steer a compact grouped completion callback to their owner", async () => {
  assert.equal(registry()[managerKey], undefined);
  const root = await activate(false);
  try {
    assert.ok(root.sessionStart);
    await root.sessionStart(
      {},
      context("root-session", [], packageCwd, new TestUI(), "print", false),
    );
    await Promise.all([
      execute(
        root,
        "shell_start",
        { command: "printf 'stdout-tail'; printf 'stderr-tail' >&2" },
        "root-session",
      ),
      execute(root, "shell_start", { command: "exit 7" }, "root-session"),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 500));

    assert.equal(root.messages.length, 1);
    const completion = root.messages[0];
    assert.deepEqual(completion?.options, { deliverAs: "steer", triggerTurn: true });
    assert.equal(completion?.message.customType, "shell-completion-notification");
    assert.equal(completion?.message.display, true);
    assert.ok(completion);
    const notification = completion.message.details;
    assert.equal(notification.shells.length, 2);
    assert.ok(notification.shells.some((shell) => shell.exitCode === 7));
    assert.ok(
      notification.shells.reduce(
        (length, shell) => length + Array.from(shell.stdout.tail + shell.stderr.tail).length,
        0,
      ) < 500,
    );
    const tailed = notification.shells.find((shell) => shell.stdout.tail.length > 0);
    assert.match(tailed?.stdout.tail ?? "", /stdout-tail/);
    assert.match(tailed?.stderr.tail ?? "", /stderr-tail/);
    assert.equal(tailed?.stdout.nextOffset, tailed?.stdout.endOffset);
    assert.equal(tailed?.stderr.nextOffset, tailed?.stderr.endOffset);
    assert.match(completion?.message.content ?? "", /Use shell_read/);

    const notificationTheme: ShellNotificationTheme = {
      fg: (_color, text) => text,
      bold: (text) => text,
      getBgAnsi: () => "",
    };
    const rendered = renderShellCompletion(notification, notificationTheme);
    assert.match(rendered, /Shell: Completed/);
    assert.match(rendered, /stdout-tail/);
  } finally {
    assert.ok(root.shutdown);
    await root.shutdown({ reason: "quit" }, context("root-session"));
  }
});

test("five streaming completions produce one grouped steer at turn_end", async () => {
  assert.equal(registry()[managerKey], undefined);
  const root = await activate(false);
  try {
    assert.ok(root.sessionStart);
    assert.ok(root.agentStart);
    assert.ok(root.agentEnd);
    assert.ok(root.turnEnd);
    const rootContext = context("root-session", [], packageCwd, new TestUI(), "print", false);
    await root.sessionStart({}, rootContext);
    await root.agentStart({}, rootContext);
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        execute(root, "shell_start", { command: `exit ${index}` }, "root-session"),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(root.messages.length, 0);

    await root.agentEnd({}, rootContext);
    await root.turnEnd({}, rootContext);
    assert.equal(root.messages.length, 1);
    assert.equal(root.messages[0]?.message.details.shells.length, 5);
    assert.deepEqual(root.messages[0]?.options, { deliverAs: "steer", triggerTurn: true });
  } finally {
    assert.ok(root.shutdown);
    await root.shutdown({ reason: "quit" }, context("root-session"));
  }
});

test("tool execution without UI does not create a shell section provider", async () => {
  assert.equal(registry()[managerKey], undefined);
  const previousHost = registry()[subagentsManagerKey];
  let registrations = 0;
  registry()[subagentsManagerKey] = {
    registerShellSection() {
      registrations += 1;
      return { unregister() {} };
    },
  };
  const root = await activate(false);
  const noUI = new TestUI();
  try {
    assert.ok(root.toolExecutionStart);
    await root.toolExecutionStart(
      {},
      context("root-session", [], packageCwd, noUI, "print", false),
    );
    await execute(
      root,
      "shell_start",
      { command: "while :; do sleep 1; done", name: "headless shell" },
      "root-session",
    );
    assert.equal(noUI.widgetCalls.length, 0);
    assert.equal(registrations, 0);
  } finally {
    assert.ok(root.shutdown);
    await root.shutdown({ reason: "quit" }, context("root-session"));
    if (previousHost) registry()[subagentsManagerKey] = previousHost;
    else delete registry()[subagentsManagerKey];
  }
});

test("root /shells opens an overlay only in TUI mode and notifies in print and rpc modes", async () => {
  assert.equal(registry()[managerKey], undefined);
  const root = await activate(false);
  try {
    assert.ok(root.command);

    const tuiUI = new TestUI();
    await root.command.handler("", context("root", [], packageCwd, tuiUI, "tui"));
    assert.equal(tuiUI.customOptions.length, 1);
    assert.equal(tuiUI.notices.length, 0);

    for (const mode of ["print", "rpc"] as const) {
      const ui = new TestUI();
      await root.command.handler("list", context("root", [], packageCwd, ui, mode));
      assert.equal(ui.customOptions.length, 0);
      assert.equal(ui.notices.length, 1);
      assert.deepEqual(JSON.parse(ui.notices[0]?.message ?? ""), { shells: [] });
      assert.equal(ui.notices[0]?.level, "info");
    }
  } finally {
    assert.ok(root.shutdown);
    await root.shutdown({ reason: "quit" }, context("root"));
  }
});

test("/shells stop notifies only while its activation remains current", async () => {
  assert.equal(registry()[managerKey], undefined);
  const root = await activate(false);
  const manager = registry()[managerKey];
  assert.ok(manager);
  assert.ok(root.command);

  let rejectStop: ((error: Error) => void) | undefined;
  manager.stop = () =>
    new Promise<never>((_resolve, rejectStopPromise) => {
      rejectStop = rejectStopPromise;
    });

  const currentNotices: Notice[] = [];
  const currentStop = root.command.handler("stop deferred-shell", context("root", currentNotices));
  assert.ok(rejectStop);
  rejectStop(new Error("manager stop failed"));
  await currentStop;
  assert.deepEqual(currentNotices, [{ message: "manager stop failed", level: "error" }]);

  let contextIsCurrent = true;
  const staleContext = new Proxy(context("root"), {
    get(target, property, _receiver) {
      if (!contextIsCurrent) {
        throw new Error("Context is no longer valid after session shutdown");
      }
      // SAFETY: TestContext is a plain fixture object, and proxy reads use only its declared keys.
      return target[property as keyof TestContext];
    },
  });
  const staleStop = root.command.handler("stop deferred-shell", staleContext);
  assert.ok(rejectStop);

  assert.ok(root.shutdown);
  await root.shutdown({ reason: "quit" }, context("root"));
  contextIsCurrent = false;
  rejectStop(new Error("manager stop failed after shutdown"));
  await assert.doesNotReject(staleStop);
  assert.equal(registry()[managerKey], undefined);
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
    const commandUI = new TestUI(commandNotices);
    const commandContext = context("root-session", commandNotices, packageCwd, commandUI);
    assert.ok(root.command);
    await root.command.handler("", commandContext);
    await root.command.handler("list", commandContext);
    await root.command.handler(`read ${childStarted.shellId}`, commandContext);
    assert.equal(commandUI.customOptions.length, 2);
    assert.ok(commandUI.customOptions.every((options) => options?.overlay === true));
    assert.equal(commandNotices.length, 1);
    assert.equal(commandNotices[0]?.level, "info");
    assert.match(commandNotices[0]?.message ?? "", new RegExp(childStarted.shellId));

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
    assert.equal(commandNotices[1]?.level, "info");
    assert.match(commandNotices[1]?.message ?? "", /"state": "stopped"/);
  } finally {
    if (child?.shutdown) await child.shutdown({ reason: "quit" }, context("child-session"));
    assert.ok(root.shutdown);
    await root.shutdown({ reason: "quit" }, context("root-session"));
    assert.equal(registry()[managerKey], undefined);
  }
});

test("root session replacement preserves the process manager and quit removes an adopted manager", async () => {
  assert.equal(registry()[managerKey], undefined);
  const previousHost = registry()[subagentsManagerKey];
  const registrations: Array<{
    provider: ShellSectionProvider;
    unregistered: boolean;
  }> = [];
  registry()[subagentsManagerKey] = {
    registerShellSection(provider) {
      const registration = { provider, unregistered: false };
      registrations.push(registration);
      return { unregister: () => (registration.unregistered = true) };
    },
  };
  let current = await activate(false);
  let currentUI = new TestUI();
  assert.ok(current.sessionStart);
  await current.sessionStart({}, context("root-session", [], packageCwd, currentUI));
  const originalManager = registry()[managerKey];
  assert.ok(originalManager);
  const started = details<{ shellId: string; state: string }>(
    await execute(
      current,
      "shell_start",
      { command: "while :; do sleep 1; done", name: "surviving shell" },
      "root-session",
    ),
  );
  assert.equal(registrations[0]?.provider.rows(Date.now())[0]?.label, "surviving shell");

  try {
    for (const reason of ["reload", "new", "resume", "fork"] as const) {
      assert.ok(current.shutdown);
      await current.shutdown({ reason }, context("root-session"));
      assert.strictEqual(registry()[managerKey], originalManager);
      assert.equal(registrations.at(-1)?.unregistered, true);

      const successor = await activate(false);
      const successorUI = new TestUI();
      assert.ok(successor.sessionStart);
      await successor.sessionStart({}, context("successor-session", [], packageCwd, successorUI));
      assert.equal(registrations.at(-1)?.provider.rows(Date.now())[0]?.label, "surviving shell");
      const listed = details<{ shells: Array<{ shellId: string; state: string }> }>(
        await execute(successor, "shell_list", {}, "successor-session"),
      );
      assert.equal(
        listed.shells.find((shell) => shell.shellId === started.shellId)?.state,
        "running",
      );
      current = successor;
      currentUI = successorUI;
    }

    assert.ok(current.shutdown);
    await current.shutdown({ reason: "quit" }, context("successor-session"));
    assert.equal(registrations.at(-1)?.unregistered, true);
    assert.equal(registry()[managerKey], undefined);
  } finally {
    if (registry()[managerKey]) {
      assert.ok(current.shutdown);
      await current.shutdown({ reason: "quit" }, context("successor-session"));
    }
    if (previousHost) registry()[subagentsManagerKey] = previousHost;
    else delete registry()[subagentsManagerKey];
  }
});

const payloadKeys = [
  "id",
  "name",
  "command",
  "cwd",
  "pid",
  "exitCode",
  "startedAt",
  "finishedAt",
  "toolCallId",
  "tailPath",
];

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function eventsFor(activation: Activation, id: string): string[] {
  return activation.events.filter((event) => event.payload.id === id).map((event) => event.channel);
}

async function startShell(
  activation: Activation,
  toolCallId: string,
  params: ShellToolParams,
  sessionId: string,
): Promise<{ shellId: string; startedAt: number; pid?: number }> {
  return details<{ shellId: string; startedAt: number; pid?: number }>(
    await tool(activation, "shell_start").execute(
      toolCallId,
      params,
      new AbortController().signal,
      () => {},
      context(sessionId),
    ),
  );
}

test("lifecycle events publish flat started/exited payloads with the tool call id", async () => {
  assert.equal(registry()[managerKey], undefined);
  const root = await activate(false);
  try {
    assert.ok(root.sessionStart);
    await root.sessionStart(
      {},
      context("root-session", [], packageCwd, new TestUI(), "print", false),
    );
    const started = await startShell(
      root,
      "tool-call-7",
      { command: "exit 7", name: "seven" },
      "root-session",
    );
    // started is emitted synchronously inside shell_start.
    assert.deepEqual(eventsFor(root, started.shellId), ["shells:started"]);
    await waitFor(() => eventsFor(root, started.shellId).length === 2, "exit event");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(eventsFor(root, started.shellId), ["shells:started", "shells:exited"]);

    const [start, exit] = root.events.filter((event) => event.payload.id === started.shellId);
    assert.ok(start && exit);
    assert.deepEqual(Object.keys(start.payload), payloadKeys);
    assert.deepEqual(Object.keys(exit.payload), payloadKeys);
    assert.deepEqual(start.payload, {
      id: started.shellId,
      name: "seven",
      command: "exit 7",
      cwd: packageCwd,
      pid: started.pid ?? null,
      exitCode: null,
      startedAt: started.startedAt,
      finishedAt: null,
      toolCallId: "tool-call-7",
      tailPath: null,
    });
    assert.equal(exit.payload.exitCode, 7);
    assert.equal(exit.payload.toolCallId, "tool-call-7");
    assert.equal(exit.payload.tailPath, null);
    assert.ok((exit.payload.finishedAt ?? 0) >= started.startedAt);
    assert.equal(registry()[managerKey]?.toolCallIdOf(started.shellId), "tool-call-7");

    const unnamed = await startShell(root, "tool-call-0", { command: "exit 0" }, "root-session");
    await waitFor(() => eventsFor(root, unnamed.shellId).length === 2, "unnamed exit");
    const unnamedExit = root.events.find(
      (event) => event.payload.id === unnamed.shellId && event.channel === "shells:exited",
    );
    assert.equal(unnamedExit?.payload.name, null);
    assert.equal(unnamedExit?.payload.exitCode, 0);
  } finally {
    assert.ok(root.shutdown);
    await root.shutdown({ reason: "quit" }, context("root-session"));
  }
});

test("a stopped shell emits stopped exactly once and never a duplicate exited", async () => {
  assert.equal(registry()[managerKey], undefined);
  const root = await activate(false);
  try {
    assert.ok(root.sessionStart);
    await root.sessionStart(
      {},
      context("root-session", [], packageCwd, new TestUI(), "print", false),
    );
    const started = await startShell(
      root,
      "tool-call-stop",
      { command: "while :; do sleep 1; done" },
      "root-session",
    );
    await execute(root, "shell_stop", { shell_id: started.shellId }, "root-session");
    await waitFor(() => eventsFor(root, started.shellId).length >= 2, "stop event");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(eventsFor(root, started.shellId), ["shells:started", "shells:stopped"]);
    const stopped = root.events.at(-1);
    assert.equal(stopped?.payload.toolCallId, "tool-call-stop");
    assert.ok((stopped?.payload.finishedAt ?? 0) >= started.startedAt);
  } finally {
    assert.ok(root.shutdown);
    await root.shutdown({ reason: "quit" }, context("root-session"));
  }
});

test("a spawn failure emits started then one exited with a null exit code", async () => {
  assert.equal(registry()[managerKey], undefined);
  const manager = new ShellManager({ shell: resolve(packageCwd, "missing-shell-executable") });
  registry()[managerKey] = manager;
  const root = await activate(false);
  try {
    assert.ok(root.sessionStart);
    await root.sessionStart(
      {},
      context("root-session", [], packageCwd, new TestUI(), "print", false),
    );
    const started = await startShell(root, "tool-call-fail", { command: "true" }, "root-session");
    await waitFor(() => eventsFor(root, started.shellId).length >= 2, "failure event");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(eventsFor(root, started.shellId), ["shells:started", "shells:exited"]);
    const failed = root.events.at(-1);
    assert.equal(failed?.payload.exitCode, null);
    assert.equal(failed?.payload.toolCallId, "tool-call-fail");
    const listed = manager.list({ requesterId: "root-session", isAdmin: true }).shells;
    assert.equal(listed.find((shell) => shell.shellId === started.shellId)?.state, "failed");
  } finally {
    assert.ok(root.shutdown);
    await root.shutdown({ reason: "quit" }, context("root-session"));
    assert.equal(registry()[managerKey], undefined);
  }
});

test("session replacement emits lost for running shells and reload emits nothing", async () => {
  assert.equal(registry()[managerKey], undefined);
  try {
    const reloaded = await activate(false);
    assert.ok(reloaded.sessionStart && reloaded.shutdown);
    await reloaded.sessionStart(
      {},
      context("root-session", [], packageCwd, new TestUI(), "print", false),
    );
    const kept = await startShell(
      reloaded,
      "tool-call-kept",
      { command: "while :; do sleep 1; done" },
      "root-session",
    );
    await reloaded.shutdown({ reason: "reload" }, context("root-session"));
    assert.deepEqual(eventsFor(reloaded, kept.shellId), ["shells:started"]);

    const root = await activate(false);
    assert.ok(root.sessionStart && root.shutdown);
    await root.sessionStart(
      {},
      context("root-session", [], packageCwd, new TestUI(), "print", false),
    );
    const finished = await startShell(
      root,
      "tool-call-done",
      { command: "exit 0" },
      "root-session",
    );
    await waitFor(() => eventsFor(root, finished.shellId).length === 2, "finished exit");
    await root.shutdown({ reason: "new" }, context("root-session"));

    const lost = root.events.filter((event) => event.channel === "shells:lost");
    assert.deepEqual(
      lost.map((event) => event.payload.id),
      [kept.shellId],
    );
    assert.deepEqual(Object.keys(lost[0]?.payload ?? {}), payloadKeys);
    assert.equal(lost[0]?.payload.finishedAt, null);
    assert.equal(lost[0]?.payload.exitCode, null);
    assert.equal(lost[0]?.payload.toolCallId, "tool-call-kept");

    const manager = registry()[managerKey];
    assert.ok(manager);
    const before = root.events.length;
    await manager.stop({ requesterId: "root-session", isAdmin: true, shellId: kept.shellId });
    assert.equal(root.events.length, before, "detached activations stay silent");
    assert.deepEqual(eventsFor(reloaded, kept.shellId), ["shells:started"]);
  } finally {
    // Read the slot directly so a failure before the stop above still kills the loop.
    await registry()[managerKey]?.dispose();
    delete registry()[managerKey];
  }
});

test("lifecycle events are scoped to the activation's own session", async () => {
  assert.equal(registry()[managerKey], undefined);
  const root = await activate(false);
  const child = await activate(true);
  try {
    assert.ok(root.sessionStart && child.sessionStart);
    await root.sessionStart(
      {},
      context("root-session", [], packageCwd, new TestUI(), "print", false),
    );
    await child.sessionStart({}, context("child-session"));
    const childShell = await startShell(
      child,
      "tool-call-child",
      { command: "while :; do sleep 1; done" },
      "child-session",
    );
    assert.deepEqual(eventsFor(child, childShell.shellId), ["shells:started"]);
    assert.deepEqual(eventsFor(root, childShell.shellId), []);

    assert.ok(child.shutdown);
    await child.shutdown({ reason: "quit" }, context("child-session"));
    assert.deepEqual(eventsFor(child, childShell.shellId), ["shells:started", "shells:stopped"]);
    assert.deepEqual(eventsFor(root, childShell.shellId), []);
  } finally {
    assert.ok(root.shutdown);
    await root.shutdown({ reason: "quit" }, context("root-session"));
  }
});

test("a stale event bus detaches lifecycle emission without reporting errors", async () => {
  assert.equal(registry()[managerKey], undefined);
  const root = await activate(false);
  const originalError = console.error;
  const diagnostics: RuntimeValue[][] = [];
  console.error = (...args: RuntimeValue[]) => {
    diagnostics.push(args);
  };
  try {
    assert.ok(root.sessionStart);
    await root.sessionStart(
      {},
      context("root-session", [], packageCwd, new TestUI(), "print", false),
    );
    root.emitError = new Error("This extension ctx is stale after session replacement or reload.");
    const first = await startShell(root, "tool-call-stale", { command: "exit 0" }, "root-session");
    assert.equal(root.emitAttempts, 1);
    await waitFor(
      () =>
        registry()
          [managerKey]?.list({ requesterId: "root-session", isAdmin: true })
          .shells.find((shell) => shell.shellId === first.shellId)?.state === "exited",
      "stale shell exit",
    );
    await startShell(root, "tool-call-after", { command: "exit 0" }, "root-session");
    assert.equal(root.emitAttempts, 1, "no emission after the bus went stale");
    assert.deepEqual(diagnostics, []);
  } finally {
    console.error = originalError;
    assert.ok(root.shutdown);
    await root.shutdown({ reason: "quit" }, context("root-session"));
  }
});

test("an unrelated event bus failure escapes the manager listener boundary", async () => {
  assert.equal(registry()[managerKey], undefined);
  const root = await activate(false);
  const originalQueue = globalThis.queueMicrotask;
  const deferred: Array<() => void> = [];
  globalThis.queueMicrotask = (callback: () => void) => {
    deferred.push(callback);
  };
  const failure = new Error("bus exploded");
  try {
    assert.ok(root.sessionStart);
    await root.sessionStart(
      {},
      context("root-session", [], packageCwd, new TestUI(), "print", false),
    );
    root.emitError = failure;
    const started = await startShell(
      root,
      "tool-call-boom",
      { command: "while :; do sleep 1; done" },
      "root-session",
    );
    globalThis.queueMicrotask = originalQueue;
    assert.equal(deferred.length, 1);
    assert.throws(
      () => deferred[0]?.(),
      (error) => error === failure,
    );
    // The shell itself is unaffected and the activation keeps emitting.
    root.emitError = undefined;
    await execute(root, "shell_stop", { shell_id: started.shellId }, "root-session");
    await waitFor(() => eventsFor(root, started.shellId).includes("shells:stopped"), "stop event");
  } finally {
    globalThis.queueMicrotask = originalQueue;
    assert.ok(root.shutdown);
    await root.shutdown({ reason: "quit" }, context("root-session"));
  }
});

test("a child identified only by the subagents registry never disposes the root manager", async () => {
  assert.equal(registry()[managerKey], undefined);
  const previousHost = registry()[subagentsManagerKey];
  const liveChildIds = new Set(["registry-child"]);
  registry()[subagentsManagerKey] = {
    isChildSessionId: (id: string) => liveChildIds.has(id),
  };
  const root = await activate(false);
  try {
    assert.ok(root.sessionStart && root.shutdown);
    await root.sessionStart({}, context("root-session"));
    const manager = registry()[managerKey];
    assert.ok(manager);
    const rootShell = await startShell(
      root,
      "tool-call-root",
      { command: "while :; do sleep 1; done" },
      "root-session",
    );

    // No async child-context marker: the activation loads like a root extension.
    const child = await activate(false);
    assert.ok(child.sessionStart && child.shutdown);
    assert.ok(child.toolExecutionStart, "marker-less child still registers root-only hooks");
    await child.sessionStart({}, context("registry-child"));
    await child.toolExecutionStart({}, context("registry-child"));
    const childShell = await startShell(
      child,
      "tool-call-child",
      { command: "while :; do sleep 1; done" },
      "registry-child",
    );
    const childVisible = details<{ shells: Array<{ shellId: string }> }>(
      await execute(child, "shell_list", {}, "registry-child"),
    ).shells.map((shell) => shell.shellId);
    assert.deepEqual(childVisible, [childShell.shellId], "child is not admin");

    // Subagents unregisters the id before emitting the child's quit shutdown.
    liveChildIds.delete("registry-child");
    await child.shutdown({ reason: "quit" }, context("registry-child"));

    assert.equal(registry()[managerKey], manager, "root keeps the shared manager");
    assert.deepEqual(eventsFor(child, childShell.shellId), ["shells:started", "shells:stopped"]);
    assert.deepEqual(eventsFor(root, childShell.shellId), []);
    const listed = manager.list({ requesterId: "root-session", isAdmin: true }).shells;
    assert.equal(listed.find((shell) => shell.shellId === childShell.shellId)?.state, "stopped");
    assert.equal(listed.find((shell) => shell.shellId === rootShell.shellId)?.state, "running");

    const after = await startShell(
      root,
      "tool-call-after",
      { command: "printf ok" },
      "root-session",
    );
    await waitFor(() => eventsFor(root, after.shellId).includes("shells:exited"), "root exit");
    const read = details<{ stdout: { data: string } }>(
      await execute(root, "shell_read", { shell_id: after.shellId }, "root-session"),
    );
    assert.equal(read.stdout.data, "ok");
  } finally {
    await root.shutdown?.({ reason: "quit" }, context("root-session"));
    assert.equal(registry()[managerKey], undefined, "root quit still disposes");
    if (previousHost) registry()[subagentsManagerKey] = previousHost;
    else delete registry()[subagentsManagerKey];
  }
});

test("a root quit whose manager no longer owns the process slot leaves the slot alone", async () => {
  assert.equal(registry()[managerKey], undefined);
  const stale = await activate(false);
  const replacement = new ShellManager();
  try {
    assert.ok(stale.sessionStart && stale.shutdown);
    await stale.sessionStart({}, context("root-session"));
    const staleManager = registry()[managerKey];
    assert.ok(staleManager);
    registry()[managerKey] = replacement;
    await stale.shutdown({ reason: "quit" }, context("root-session"));
    assert.equal(registry()[managerKey], replacement);
    const started = replacement.start({
      ownerId: "root-session",
      command: "exit 0",
      cwd: packageCwd,
    });
    assert.equal(started.state, "running");
    await staleManager.dispose();
  } finally {
    await replacement.dispose();
    delete registry()[managerKey];
  }
});
