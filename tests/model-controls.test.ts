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
    request: (provider = "openai-codex") =>
      handlers.get("before_provider_request")?.(
        { payload: { model: "test", service_tier: "auto" } },
        { ...ctx, model: { ...ctx.model, provider } },
      ),
  };
}

test("child OpenAI requests inherit main fast mode without overriding child history", async () => {
  const root = fastModeSession("fast-root");
  root.start();
  const children: ReturnType<typeof fastModeSession>[] = [];
  const child = async (id: string, enabled?: boolean) => {
    const session = await runInChildSessionContext(async () => fastModeSession(id, enabled));
    children.push(session);
    session.start();
    return session;
  };
  try {
    assert.equal((await child("before-on")).request(), undefined);
    await root.toggle("on");
    const inherited = await child("inherited");
    const priority = { model: "test", service_tier: "priority" };
    assert.deepEqual(inherited.request(), priority);
    assert.deepEqual(inherited.request("openai"), priority);
    assert.equal(inherited.request("synthetic"), undefined);
    assert.equal((await child("explicit-off", false)).request(), undefined);
    assert.deepEqual(root.request(), priority);
    await inherited.toggle("off");
    assert.deepEqual((await child("sibling")).request(), priority);
    await root.toggle("off");
    assert.equal((await child("after-off")).request(), undefined);
    assert.deepEqual((await child("explicit-on", true)).request(), priority);
  } finally {
    for (const session of children) session.stop();
    root.stop();
  }
  const orphan = await child("after-shutdown");
  try {
    assert.equal(orphan.request(), undefined);
  } finally {
    orphan.stop();
  }
});

function model(provider: "openai-codex" | "synthetic"): Model<Api> {
  return {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    provider,
    api: "openai-responses",
    baseUrl: "https://example.com",
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

test("effective Fast mode combines the session flag with the Codex registry", () => {
  const symbol = Symbol.for("choco-pi.codex-fast-mode");
  const store = reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(globalThis);
  const previous = store[symbol];
  try {
    delete store[symbol];
    assert.equal(isEffectiveFastModeEnabled(false), false);
    assert.equal(isEffectiveFastModeEnabled(true), true);

    store[symbol] = { enabled: true };
    assert.equal(isEffectiveFastModeEnabled(false), true);

    store[symbol] = { enabled: false };
    assert.equal(isEffectiveFastModeEnabled(true), true);

    store[symbol] = { enabled: "invalid" };
    assert.equal(isEffectiveFastModeEnabled(false), false);
  } finally {
    if (previous === undefined) delete store[symbol];
    else store[symbol] = previous;
  }
});

test("fast status and off stay truthful when Codex preferences enable Fast mode", async () => {
  const symbol = Symbol.for("choco-pi.codex-fast-mode");
  const store = reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(globalThis);
  const previous = store[symbol];
  let fastHandler: ((args: string, ctx: RuntimeValue) => Promise<void>) | undefined;
  const notifications: string[] = [];
  const pi = reinterpretHostValue<import("@earendil-works/pi-coding-agent").ExtensionAPI>({
    on: () => {},
    registerCommand: (
      name: string,
      options: { handler: (args: string, ctx: RuntimeValue) => Promise<void> },
    ) => {
      if (name === "fast") fastHandler = options.handler;
    },
    appendEntry: () => {},
  });
  const ctx = {
    model: model("openai-codex"),
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
    },
  };

  try {
    store[symbol] = { enabled: true };
    modelControls(pi);
    await fastHandler?.("status", ctx);
    await fastHandler?.("off", ctx);
    assert.deepEqual(notifications, [
      "Fast mode: on",
      "Fast mode remains on through Codex preferences.",
    ]);
  } finally {
    if (previous === undefined) delete store[symbol];
    else store[symbol] = previous;
  }
});

test("non-OpenAI-Codex editor metadata is unchanged", () => {
  const lines = [" synthetic-model  Synthetic  high"];
  assert.deepEqual(appendFastModeToEditorMetadata(lines, 80, model("synthetic"), true), lines);
});

test("fast toggles rerender without appending a scrollback status row", async () => {
  let fastHandler: ((args: string, ctx: RuntimeValue) => Promise<void>) | undefined;
  let entries = 0;
  const pi = reinterpretHostValue<import("@earendil-works/pi-coding-agent").ExtensionAPI>({
    on: () => {},
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
  await fastHandler?.("on", {
    model: model("openai-codex"),
    ui: {
      notify: () => {
        notifications++;
      },
      setStatus: (_key: string, value: string | undefined) => {
        assert.equal(value, undefined);
        renders++;
      },
    },
  });

  assert.equal(entries, 1);
  assert.equal(notifications, 0);
  assert.equal(renders, 1);
});
