import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { reinterpretHostValue } from "../../../extensions/lib/runtime-values.ts";
import { SteeringStatusWidget } from "../src/ui/steering-status.ts";
import { registerNativeFeatures } from "../src/extension/native-features.ts";

function fixture() {
  const frames: (string[] | undefined)[] = [];
  let owner = "owner";
  const ctx = {
    hasUI: true,
    sessionManager: { getSessionId: () => owner },
    ui: {
      setWidget(_key: string, lines: string[] | undefined) {
        assert.ok(lines === undefined || Array.isArray(lines));
        frames.push(lines);
      },
    },
  };
  return {
    ctx,
    frames,
    replace: () => {
      owner = "replacement";
    },
  };
}

test("same-text submissions have independent receipts and terminal status", async () => {
  const { ctx, frames } = fixture();
  const widget = new SteeringStatusWidget();
  const first = widget.add("same text", ctx);
  first("sent");
  await Promise.resolve();
  assert.match(frames.at(-1)![0]!, /#1 · Mid-turn sent/);
  const second = widget.add("same text", ctx);
  first("accepted");
  await Promise.resolve();
  assert.match(frames.at(-1)![0]!, /#1 · Mid-turn accepted/);
  assert.match(frames.at(-1)![1]!, /#2 · Queued/);
  first("applied");
  first("fallback");
  second("fallback");
  second("accepted");
  await Promise.resolve();
  assert.match(frames.at(-1)![0]!, /#1 · Mid-turn applied/);
  assert.match(frames.at(-1)![1]!, /#2 · Queue fallback/);
});

test("bounded sanitized rows do not publish stale callbacks after clear/replacement", async () => {
  const { ctx, frames, replace } = fixture();
  const widget = new SteeringStatusWidget();
  const old = widget.add("\x1b[31mred\x1b[0m\n\u202eevil" + "x".repeat(100), ctx);
  for (const control of ["\x1b", "\n", "\u202e"])
    assert.equal(frames.at(-1)![0]!.includes(control), false);
  assert.ok(frames.at(-1)![0]!.endsWith("…"));
  for (let i = 0; i < 5; i++) widget.add(`message ${i}`, ctx);
  assert.equal(frames.at(-1)!.length, 4);
  old("accepted");
  const count = frames.length;
  await Promise.resolve();
  assert.equal(frames.length, count);
  const last = widget.add("last", ctx);
  last("sent");
  widget.clear(ctx);
  await Promise.resolve();
  assert.equal(frames.at(-1), undefined);
  const next = widget.add("next", ctx);
  replace();
  next("applied");
  const replaced = frames.length;
  await Promise.resolve();
  assert.equal(frames.length, replaced);
});

test("headless widgets never call host UI", async () => {
  const { ctx, frames } = fixture();
  ctx.hasUI = false;
  const widget = new SteeringStatusWidget();
  widget.add("input", ctx)("sent");
  await Promise.resolve();
  widget.clear(ctx);
  assert.equal(frames.length, 0);
});

test("input hook shows queue-only receipt without consuming or rewriting input", () => {
  const { ctx, frames } = fixture();
  const handlers = new Map<string, (event: InputEvent, ctx: ExtensionContext) => void>();
  const pi = reinterpretHostValue<ExtensionAPI>({
    on: (name: string, handler: (event: InputEvent, ctx: ExtensionContext) => void) =>
      handlers.set(name, handler),
  });
  registerNativeFeatures(pi, () => false);
  const context = reinterpretHostValue<ExtensionContext>({
    ...ctx,
    isIdle: () => false,
    hasPendingMessages: () => false,
  });
  const event: InputEvent = {
    type: "input",
    text: "keep input",
    source: "interactive",
    streamingBehavior: "steer",
  };
  handlers.get("session_start")!(event, context);
  assert.equal(handlers.get("input")!(event, context), undefined);
  assert.equal(event.text, "keep input");
  assert.match(frames.at(-1)![0]!, /Queued \(Pi path\).*keep input/);
  handlers.get("session_shutdown")!(event, context);
  assert.equal(frames.at(-1), undefined);
});
