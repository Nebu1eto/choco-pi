import { reinterpretHostValue } from "../.pi/extensions/lib/runtime-values.ts";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { runInChildSessionContext } from "../.pi/packages/choco-pi-subagents/src/child-context.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  appendFastModeToEditorMetadata,
  appendFocusedModelToEditorMetadata,
  default as modelControls,
  installFastModeEditorWhenReady,
  isEffectiveFastModeEnabled,
  restoreFastMode,
  wrapFastModeEditorFactory,
} from "../.pi/extensions/model-controls.ts";

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;

function fastModeSession(id: string, enabled?: boolean) {
  const handlers = new Map<string, (event: RuntimeValue, ctx: RuntimeValue) => RuntimeValue>();
  const commands = new Map<string, (args: string, ctx: RuntimeValue) => Promise<void>>();
  const entries =
    enabled === undefined
      ? []
      : [{ type: "custom", customType: "choco-pi-fast-mode", data: { enabled } }];
  const ctx = {
    mode: "rpc",
    model: model("openai-codex"),
    sessionManager: { getBranch: () => entries, getSessionId: () => id },
    ui: { notify: () => {}, setStatus: () => {} },
  };
  modelControls(
    reinterpretHostValue<import("@earendil-works/pi-coding-agent").ExtensionAPI>({
      on: (name: string, handler: (event: RuntimeValue, context: RuntimeValue) => RuntimeValue) =>
        handlers.set(name, handler),
      registerCommand: (
        name: string,
        options: { handler: (args: string, context: RuntimeValue) => Promise<void> },
      ) => commands.set(name, options.handler),
      appendEntry: () => {},
    }),
  );
  return {
    start: () => handlers.get("session_start")?.({}, ctx),
    stop: () => handlers.get("session_shutdown")?.({}, ctx),
    toggle: (action: string) => commands.get("fast")?.(action, ctx),
    request: (provider: "openai" | "openai-codex" | "synthetic" = "openai-codex") =>
      handlers.get("before_provider_request")?.(
        { payload: { model: "test", service_tier: "auto" } },
        { ...ctx, model: model(provider) },
      ),
  };
}

test("sessions keep independent explicit preferences and emit standard when off", async () => {
  const root = fastModeSession("fast-root", true);
  const child = await runInChildSessionContext(async () => fastModeSession("fast-child", false));
  root.start();
  child.start();
  try {
    const priority = { model: "test", service_tier: "priority" };
    const standard = { model: "test", service_tier: "default" };
    assert.deepEqual(root.request(), priority);
    assert.deepEqual(child.request(), standard);
    assert.deepEqual(child.request("openai"), standard);
    assert.equal(child.request("synthetic"), undefined);
    await root.toggle("off");
    assert.deepEqual(root.request(), standard);
    assert.deepEqual(child.request(), standard);
    await child.toggle("on");
    assert.deepEqual(child.request(), priority);
    assert.deepEqual(root.request(), standard);
  } finally {
    child.stop();
    root.stop();
  }
});

function model(provider: "openai" | "openai-codex" | "synthetic"): Model<Api> {
  return {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    provider,
    api: "openai-responses",
    baseUrl:
      provider === "openai"
        ? "https://api.openai.com/v1"
        : provider === "openai-codex"
          ? "https://chatgpt.com/backend-api/codex"
          : "https://example.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 100_000,
  };
}

test("OpenAI Codex editor metadata shows only fast with a two-column right margin", () => {
  const lines = ["─".repeat(80), "", " gpt-5.6-sol  OpenAI  high", "─".repeat(80)];
  const decorated = appendFastModeToEditorMetadata(lines, 80, model("openai-codex"), true);

  assert.match(
    stripTerminalSequences(decorated[2] ?? ""),
    /^ gpt-5\.6-sol  OpenAI  high +fast {2}$/,
  );
  assert.equal(visibleWidth(decorated[2] ?? ""), 80);
  assert.ok(decorated.every((line) => visibleWidth(line) <= 80));
});

test("wrapped editor updates fast mode and preserves Zentui ownership", () => {
  let enabled = false;
  const owner = Symbol("zentui-owner");
  const ownerKey = Symbol.for("pi-zentui.editor-owner");
  const baseFactory = reinterpretHostValue<EditorFactory & { [ownerKey]?: symbol }>(
    (_tui: never, _theme: never, _keybindings: never) => ({
      render: () => [" gpt-5.6-sol  OpenAI  high"],
      invalidate: () => {},
      handleInput: () => {},
      getText: () => "",
      setText: () => {},
    }),
  );
  baseFactory[ownerKey] = owner;
  const wrapped = wrapFastModeEditorFactory(baseFactory, {
    getModel: () => model("openai-codex"),
    isEnabled: () => enabled,
    style: (text) => text,
  });
  // SAFETY: The fixture supplies every host member exercised by this test.
  const editor = wrapped(undefined as never, undefined as never, undefined as never);

  assert.equal(stripTerminalSequences(editor.render(80)[0] ?? ""), " gpt-5.6-sol  OpenAI  high");
  enabled = true;
  assert.match(
    stripTerminalSequences(editor.render(80)[0] ?? ""),
    /^ gpt-5\.6-sol  OpenAI  high +fast {2}$/,
  );
  // SAFETY: The fixture supplies every host member exercised by this test.
  assert.equal((wrapped as typeof baseFactory)[ownerKey], owner);
});

test("editor installation waits until Zentui owns the factory", () => {
  const zentuiKey = Symbol.for("pi-zentui.editor-factory");
  const plainFactory = reinterpretHostValue<EditorFactory>(() => ({
    render: () => [],
    invalidate: () => {},
    handleInput: () => {},
    getText: () => "",
    setText: () => {},
  }));
  const zentuiFactory = Object.assign(
    reinterpretHostValue<EditorFactory>(plainFactory.bind(undefined)),
    {
      [zentuiKey]: true,
    },
  );
  let currentFactory = plainFactory;
  const scheduled: Array<() => void> = [];
  installFastModeEditorWhenReady(
    {
      getEditorComponent: () => currentFactory,
      setEditorComponent: (factory) => {
        currentFactory = factory;
      },
    },
    {
      getModel: () => model("openai-codex"),
      isEnabled: () => false,
      style: (text) => text,
    },
    () => true,
    {
      schedule: (callback) => scheduled.push(callback),
    },
  );

  scheduled.shift()?.();
  assert.equal(currentFactory, plainFactory);
  currentFactory = zentuiFactory;
  scheduled.shift()?.();
  assert.notEqual(currentFactory, zentuiFactory);
  // SAFETY: The fixture supplies every host member exercised by this test.
  assert.equal((currentFactory as { [zentuiKey]?: boolean })[zentuiKey], true);
});

test("Fast mode state restores from the latest session entry", () => {
  const entries = [
    { type: "custom", customType: "choco-pi-fast-mode", data: { enabled: true } },
    { type: "custom", customType: "other", data: { enabled: true } },
    { type: "custom", customType: "choco-pi-fast-mode", data: { enabled: false } },
  ];
  // SAFETY: The fixture supplies every host member exercised by this test.
  assert.equal(restoreFastMode(entries as never), false);
});

test("effective Fast mode is the session preference, not a process-global override", () => {
  const symbol = Symbol.for("choco-pi.codex-fast-mode");
  const store = reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(globalThis);
  const previous = store[symbol];
  try {
    delete store[symbol];
    assert.equal(isEffectiveFastModeEnabled(false), false);
    assert.equal(isEffectiveFastModeEnabled(true), true);

    store[symbol] = { enabled: true };
    assert.equal(isEffectiveFastModeEnabled(false), false);

    store[symbol] = { enabled: false };
    assert.equal(isEffectiveFastModeEnabled(true), true);

    store[symbol] = { enabled: "invalid" };
    assert.equal(isEffectiveFastModeEnabled(false), false);
  } finally {
    if (previous === undefined) delete store[symbol];
    else store[symbol] = previous;
  }
});

test("legacy process-global Codex state cannot seed a new session", async () => {
  const symbol = Symbol.for("choco-pi.codex-fast-mode");
  const store = reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(globalThis);
  const previous = store[symbol];
  let fastHandler: ((args: string, ctx: RuntimeValue) => Promise<void>) | undefined;
  const notifications: string[] = [];
  const handlers = new Map<string, (event: RuntimeValue, ctx: RuntimeValue) => RuntimeValue>();
  const pi = reinterpretHostValue<import("@earendil-works/pi-coding-agent").ExtensionAPI>({
    on: (name: string, handler: (event: RuntimeValue, ctx: RuntimeValue) => RuntimeValue) =>
      handlers.set(name, handler),
    registerCommand: (
      name: string,
      options: { handler: (args: string, ctx: RuntimeValue) => Promise<void> },
    ) => {
      if (name === "fast") fastHandler = options.handler;
    },
    appendEntry: () => {},
  });
  const ctx = {
    mode: "rpc",
    model: model("openai-codex"),
    sessionManager: { getBranch: () => [], getSessionId: () => "default-session" },
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
    },
  };

  try {
    store[symbol] = { enabled: true };
    modelControls(pi);
    handlers.get("session_start")?.({}, ctx);
    await fastHandler?.("status", ctx);
    await fastHandler?.("off", ctx);
    await fastHandler?.("status", ctx);
    assert.deepEqual(notifications, ["Fast mode: off", "Fast mode: off"]);
    handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    if (previous === undefined) delete store[symbol];
    else store[symbol] = previous;
  }
});

test("unsupported-provider editor metadata is unchanged", () => {
  const lines = [" synthetic-model  Synthetic  high"];
  assert.deepEqual(appendFastModeToEditorMetadata(lines, 80, model("synthetic"), true), lines);
});

test("focused editor metadata follows the child model and active support state", () => {
  const parent = { ...model("synthetic"), id: "parent", name: "Parent", provider: "anthropic" };
  const lines = [" parent  Anthropic  high"];
  const child = {
    focused: true as const,
    modelId: "gpt-child",
    modelName: "GPT Child",
    provider: "openai-codex",
    supported: true,
    active: true,
  };
  const focused = appendFocusedModelToEditorMetadata(lines, 80, parent, false, child);
  assert.match(
    stripTerminalSequences(focused[0] ?? ""),
    /^ gpt-child  openai-codex  high +fast {2}$/,
  );

  assert.deepEqual(
    appendFocusedModelToEditorMetadata(lines, 80, parent, true, { ...child, active: false }),
    [" gpt-child  openai-codex  high"],
  );
  assert.deepEqual(
    appendFocusedModelToEditorMetadata(lines, 80, parent, true, {
      ...child,
      modelId: "claude-child",
      provider: "anthropic",
      supported: false,
      active: false,
    }),
    [" claude-child  anthropic  high"],
  );
  assert.deepEqual(
    appendFocusedModelToEditorMetadata(lines, 80, parent, true, {
      focused: true,
      supported: false,
      active: false,
    }),
    lines,
    "missing focused state must not fall back to the root badge",
  );
  assert.match(
    stripTerminalSequences(
      appendFocusedModelToEditorMetadata(
        [" parent  OpenAI  high"],
        80,
        { ...model("openai-codex"), id: "parent" },
        true,
        undefined,
      )[0] ?? "",
    ),
    /fast {2}$/,
    "unfocused rendering restores root state",
  );
});

test("fast toggles rerender without appending a scrollback status row", async () => {
  let fastHandler: ((args: string, ctx: RuntimeValue) => Promise<void>) | undefined;
  let entries = 0;
  const handlers = new Map<string, (event: RuntimeValue, ctx: RuntimeValue) => RuntimeValue>();
  const pi = reinterpretHostValue<import("@earendil-works/pi-coding-agent").ExtensionAPI>({
    on: (name: string, handler: (event: RuntimeValue, ctx: RuntimeValue) => RuntimeValue) =>
      handlers.set(name, handler),
    registerCommand: (
      name: string,
      options: { handler: (args: string, ctx: RuntimeValue) => Promise<void> },
    ) => {
      if (name === "fast") fastHandler = options.handler;
    },
    appendEntry: () => {
      entries++;
    },
  });
  modelControls(pi);

  let notifications = 0;
  let renders = 0;
  const ctx = {
    mode: "rpc",
    model: model("openai-codex"),
    sessionManager: { getBranch: () => [], getSessionId: () => "render-session" },
    ui: {
      notify: () => {
        notifications++;
      },
      setStatus: (_key: string, value: string | undefined) => {
        assert.equal(value, undefined);
        renders++;
      },
    },
  };
  handlers.get("session_start")?.({}, ctx);
  await fastHandler?.("on", ctx);

  assert.equal(entries, 1);
  assert.equal(notifications, 0);
  assert.equal(renders, 1);
  handlers.get("session_shutdown")?.({}, ctx);
});
