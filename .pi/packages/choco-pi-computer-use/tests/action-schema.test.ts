import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
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
    for (const action of examples) {
      assert.equal(Value.Check(schema, { actions: [action] }), true, JSON.stringify(action));
    }
    assert.equal(
      Value.Check(schema, {
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
      Value.Check(schema, {
        actions: [{ action: "click", ref: "@e1", clickCount: 1.5 }],
      }),
      false,
      "clickCount must be an integer",
    );

    const invalidTargets: UiAction[] = [
      { action: "click" },
      { action: "click", ref: "@e1", x: 10, y: 20 },
      { action: "click", x: 10 },
      { action: "click", y: 20 },
    ];
    for (const action of invalidTargets) {
      assert.equal(Value.Check(schema, { actions: [action] }), true);
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
      'Modifiers then one key form one chord, e.g. ["cmd","shift","z"]; otherwise keys are pressed in order. Chord strings like "cmd+a" are desktop-only; browser pages reject them and take DOM key values (one character or a name such as "Enter" or "ArrowRight") with modifiers as separate keys',
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
