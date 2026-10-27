import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { UiAction } from "../src/contract.ts";

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
    const guidelines = act.definition.promptGuidelines ?? [];
    assert.ok(
      guidelines.some((line) => line.includes("typeText/keypress without ref go to")),
      "the act guideline describes ref-less keyboard input",
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
