import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  appendFastModeToEditorMetadata,
  default as modelControls,
  installFastModeEditorWhenReady,
  restoreFastMode,
  wrapFastModeEditorFactory,
} from "../.pi/extensions/model-controls.ts";

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;

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
  const baseFactory = ((_tui: never, _theme: never, _keybindings: never) => ({
    render: () => [" gpt-5.6-sol  OpenAI  high"],
    invalidate: () => {},
    handleInput: () => {},
    getText: () => "",
    setText: () => {},
  })) as unknown as EditorFactory & { [ownerKey]?: symbol };
  baseFactory[ownerKey] = owner;
  const wrapped = wrapFastModeEditorFactory(baseFactory, {
    getModel: () => model("openai-codex"),
    isEnabled: () => enabled,
    style: (text) => text,
  });
  const editor = wrapped(undefined as never, undefined as never, undefined as never);

  assert.equal(stripTerminalSequences(editor.render(80)[0] ?? ""), " gpt-5.6-sol  OpenAI  high");
  enabled = true;
  assert.match(
    stripTerminalSequences(editor.render(80)[0] ?? ""),
    /^ gpt-5\.6-sol  OpenAI  high +fast {2}$/,
  );
  assert.equal((wrapped as typeof baseFactory)[ownerKey], owner);
});

test("editor installation waits until Zentui owns the factory", () => {
  const zentuiKey = Symbol.for("pi-zentui.editor-factory");
  const plainFactory = (() => ({
    render: () => [],
    invalidate: () => {},
    handleInput: () => {},
    getText: () => "",
    setText: () => {},
  })) as unknown as EditorFactory;
  const zentuiFactory = Object.assign(plainFactory.bind(undefined) as unknown as EditorFactory, {
    [zentuiKey]: true,
  });
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
  assert.equal((currentFactory as { [zentuiKey]?: boolean })[zentuiKey], true);
});

test("Fast mode state restores from the latest session entry", () => {
  const entries = [
    { type: "custom", customType: "choco-pi-fast-mode", data: { enabled: true } },
    { type: "custom", customType: "other", data: { enabled: true } },
    { type: "custom", customType: "choco-pi-fast-mode", data: { enabled: false } },
  ];
  assert.equal(restoreFastMode(entries as never), false);
});

test("non-OpenAI-Codex editor metadata is unchanged", () => {
  const lines = [" synthetic-model  Synthetic  high"];
  assert.deepEqual(appendFastModeToEditorMetadata(lines, 80, model("synthetic"), true), lines);
});

test("fast toggles rerender without appending a scrollback status row", async () => {
  let fastHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let entries = 0;
  const pi = {
    on: () => {},
    registerCommand: (
      name: string,
      options: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) => {
      if (name === "fast") fastHandler = options.handler;
    },
    appendEntry: () => {
      entries++;
    },
  } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
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
