import assert from "node:assert/strict";
import test from "node:test";
import { restoreOutline, searchOutlineRanked, type SerializedOutlineNode } from "../src/outline.ts";
import { toSearchUiParams } from "../src/tool-params.ts";

function node(ref: string, overrides: Partial<SerializedOutlineNode>): SerializedOutlineNode {
  return {
    ref,
    wireRef: "wire-" + ref,
    role: "TextField",
    subrole: "",
    identifier: "",
    title: ref,
    description: "",
    value: "",
    actions: [],
    canPress: false,
    canFocus: false,
    canSetValue: false,
    canScroll: false,
    canIncrement: false,
    canDecrement: false,
    isTextInput: false,
    rect: { x: 0, y: 0, w: 10, h: 10 },
    focused: false,
    offscreen: false,
    pictureOnly: false,
    truncated: false,
    text: [],
    children: [],
    ...overrides,
  };
}

const outline = restoreOutline({
  lookId: "look-1",
  root: node("@e1", {
    role: "Window",
    children: [
      node("@e2", { canSetValue: true, isTextInput: true }),
      node("@e3", { role: "Button", canPress: true, actions: ["press"] }),
    ],
  }),
});

function refs(capability: string): string[] {
  return searchOutlineRanked(outline, undefined, undefined, capability).matches.map(
    (match) => match.ref,
  );
}

test("search_ui capability accepts the snake_case outline labels", () => {
  assert.deepEqual(refs("set_value"), ["@e2"]);
  assert.deepEqual(refs("text_input"), ["@e2"]);
  assert.deepEqual(refs("set_text"), ["@e2"]);
  assert.deepEqual(refs("press"), ["@e3"]);
});

test("search_ui capability rejects the former camelCase labels", () => {
  assert.deepEqual(refs("setValue"), []);
  assert.deepEqual(refs("textInput"), []);
  assert.deepEqual(refs("setText"), []);
});

test("search_ui rejects the former capability spellings at the tool boundary", () => {
  assert.throws(() => toSearchUiParams({ capability: "setValue" }), /use "set_value"/);
  assert.throws(() => toSearchUiParams({ capability: "textInput" }), /use "text_input"/);
  assert.throws(() => toSearchUiParams({ capability: "setText" }), /use "set_text"/);
  assert.deepEqual(toSearchUiParams({ capability: "set_value" }), { capability: "set_value" });
  assert.deepEqual(toSearchUiParams({ capability: "press" }), { capability: "press" });
});
