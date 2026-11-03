import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { compile } from "@earendil-works/pi-schema";
import type { UiAction } from "../src/contract.ts";
import { isJsonObject, isString, type JsonObject, type JsonValue } from "../src/json.ts";

/** The object at `key` of a JSON object, or undefined. */
function objectAt(value: JsonValue | undefined, key: string): JsonObject | undefined {
  if (!isJsonObject(value)) return undefined;
  const field = value[key];
  return isJsonObject(field) ? field : undefined;
}

/** A property description of one act_ui action variant in the serialized schema. */
function actionDescription(schema: JsonValue, action: string, property: string): string {
  const variants = objectAt(objectAt(schema, "properties"), "actions")?.items;
  const anyOf = isJsonObject(variants) ? variants.anyOf : undefined;
  const variant = (Array.isArray(anyOf) ? anyOf : []).find(
    (candidate) => objectAt(objectAt(candidate, "properties"), "action")?.const === action,
  );
  const description = objectAt(objectAt(variant, "properties"), property)?.description;
  assert.ok(isString(description), `${action}.${property} has a description`);
  return description;
}

const examples: UiAction[] = [
  { action: "press", ref: "@e1" },
  { action: "click", ref: "@e1", button: "left", clickCount: 2 },
  { action: "click", x: 10, y: 20 },
  { action: "setText", ref: "@e1", text: "value" },
  { action: "typeText", ref: "@e1", text: "value" },
  { action: "typeText", text: "value" },
  { action: "keypress", ref: "@e1", keys: ["ENTER"] },
  { action: "keypress", keys: ["ENTER"] },
  { action: "scroll", ref: "@e1", scrollY: 100 },
  { action: "scroll", x: 10, y: 20, scrollX: -100 },
  {
    action: "drag",
    path: [
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ],
  },
  { action: "moveMouse", x: 10, y: 20 },
];

test("registered act_ui schema accepts every action shape", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "computer-use-schema-"));
  try {
    const extensionPath = new URL("../extensions/computer-use.ts", import.meta.url).pathname;
    const loaded = await discoverAndLoadExtensions([extensionPath], cwd, cwd);
    assert.deepEqual(loaded.errors, []);
    const act = loaded.extensions
      .flatMap((extension) => [...extension.tools.values()])
      .find((tool) => tool.definition.name === "act_ui");
    assert.ok(act);
    const schema = act.definition.parameters;
    const { check } = compile(schema);
    for (const action of examples) {
      assert.equal(check({ actions: [action] }), true, JSON.stringify(action));
    }
    assert.equal(
      check({
        actions: [
          {
            action: "drag",
            path: [
              [10, 20],
              [30, 40],
            ],
          },
        ],
      }),
      false,
      "drag only accepts object points",
    );
    assert.equal(
      check({
        actions: [{ action: "click", ref: "@e1", clickCount: 1.5 }],
      }),
      false,
      "clickCount must be an integer",
    );

    // Objects stay open (TypeBox default): unknown keys are accepted.
    assert.equal(
      check({ actions: [{ action: "press", ref: "@e1", extra: 1 }], extra: true }),
      true,
    );
    // Optional stateId/expect may be omitted; required actions may not.
    assert.equal(check({ stateId: "s1", actions: [{ action: "moveMouse", x: 1, y: 2 }] }), true);
    assert.equal(check({ stateId: "s1" }), false, "actions required");
    assert.equal(check({ actions: [] }), false, "actions minItems");
    assert.equal(check({ actions: [{ action: "click", ref: "@e1", clickCount: 4 }] }), false);
    assert.equal(check({ actions: [{ action: "click", button: "back" }] }), false, "button enum");
    assert.equal(check({ actions: [{ action: "nope" }] }), false, "unknown action");
    assert.equal(check({ actions: [{ action: "moveMouse", x: "1", y: 2 }] }), false);
    assert.equal(check({ actions: [{ action: "press" }] }), false, "press needs ref");
    assert.equal(
      check({ expect: { timeoutMs: 50 }, actions: [{ action: "press", ref: "@e1" }] }),
      false,
    );
    assert.equal(
      check({
        expect: { until: "absent", timeoutMs: 100 },
        actions: [{ action: "press", ref: "@e1" }],
      }),
      true,
    );

    const invalidTargets: UiAction[] = [
      { action: "click" },
      { action: "click", ref: "@e1", x: 10, y: 20 },
      { action: "click", x: 10 },
      { action: "click", y: 20 },
    ];
    for (const action of invalidTargets) {
      assert.equal(check({ actions: [action] }), true);
    }

    // Keyboard input without ref goes to the app's focused element; the
    // descriptions must say so instead of requiring a ref.
    const described = JSON.stringify(schema);
    assert.doesNotMatch(described, /Required unless an earlier action/);
    assert.match(described, /omit to send keys to the target app's focused element/);
    assert.match(described, /omit to type into the target app's focused element/);
    // Keyboard wording matches the browser path: the headless ref rule and
    // chord strings apply to desktop delivery only.
    const serialized: JsonValue = JSON.parse(described);
    assert.equal(
      actionDescription(serialized, "typeText", "ref"),
      "Input to focus first; omit to type into the target app's focused element (headless desktop mode requires ref)",
    );
    assert.equal(
      actionDescription(serialized, "keypress", "ref"),
      "Control to focus first; omit to send keys to the target app's focused element (headless desktop mode requires ref)",
    );
    assert.equal(
      actionDescription(serialized, "keypress", "keys"),
      'Modifiers then one key form one chord, e.g. ["cmd","shift","z"]; otherwise keys are pressed in order. Chord strings like "cmd+a" are desktop-only; browser pages reject them and take DOM key values (one character or a name such as "Enter" or "ArrowRight") with modifiers as separate keys. On macOS, Cmd editing shortcuts (select all, copy, cut, paste, undo, redo) do not run on browser pages; use setText to replace a field\'s text',
    );
    assert.doesNotMatch(described, /\(headless requires ref\)/);
    assert.doesNotMatch(described, /each may be a chord/);
    const guidelines = act.definition.promptGuidelines ?? [];
    assert.ok(
      guidelines.some((line) => line.includes("typeText/keypress without ref go to")),
      "the act guideline describes ref-less keyboard input",
    );
    assert.ok(
      guidelines.some((line) => line.includes("Headless desktop mode requires ref.")),
      "the headless ref rule is limited to desktop delivery",
    );
    const statuses = guidelines.find((line) => line.includes('Result status "partial"'));
    assert.ok(statuses, "the act guideline documents the partial status");
    for (const status of [
      "foreground_required",
      "cancelled",
      "owned_by_other_session",
      "target_closed",
      "post_action_observation_failed",
    ])
      assert.ok(statuses.includes(status), `the act guideline names ${status}`);
    assert.match(statuses, /act_ui action N \(<action>\): … Nothing was sent\./);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("registered read-side tool schemas keep bounds, optionality and open objects", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "computer-use-schema-"));
  try {
    const extensionPath = new URL("../extensions/computer-use.ts", import.meta.url).pathname;
    const loaded = await discoverAndLoadExtensions([extensionPath], cwd, cwd);
    assert.deepEqual(loaded.errors, []);
    const checkFor = (name: string) => {
      const tool = loaded.extensions
        .flatMap((extension) => [...extension.tools.values()])
        .find((candidate) => candidate.definition.name === name);
      assert.ok(tool, name);
      return compile(tool.definition.parameters).check;
    };
    const findRoots = checkFor("find_roots");
    assert.equal(findRoots({}), true, "every find_roots field is optional");
    assert.equal(findRoots({ kind: "dialog", pid: 3, extra: 1 }), true, "open object");
    assert.equal(findRoots({ kind: "tab" }), false);
    assert.equal(findRoots({ text: "x".repeat(257) }), false);
    const waitFor = checkFor("wait_for");
    assert.equal(waitFor({ stateId: "s" }), true);
    assert.equal(waitFor({}), false, "stateId required");
    assert.equal(waitFor({ stateId: "s", timeoutMs: 99 }), false);
    assert.equal(waitFor({ stateId: "s", timeoutMs: 60_001 }), false);
    assert.equal(waitFor({ stateId: "s", until: "gone" }), false);
    const expand = checkFor("expand_ui");
    assert.equal(expand({ ref: "@e1", depth: 8 }), true);
    assert.equal(expand({ ref: "@e1", depth: 9 }), false);
    assert.equal(expand({ depth: 2 }), false, "ref required");
    const readText = checkFor("read_text");
    assert.equal(readText({ ref: "@e1", offset: 0 }), true);
    assert.equal(readText({ ref: "@e1", offset: -1 }), false);
    const observe = checkFor("observe_ui");
    assert.equal(observe({ mode: "visual" }), true);
    assert.equal(observe({ mode: "ocr" }), false);
    const evaluate = checkFor("evaluate_browser");
    assert.equal(evaluate({ stateId: "s", expression: "1" }), true);
    assert.equal(evaluate({ stateId: "s", expression: "x".repeat(65_537) }), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
