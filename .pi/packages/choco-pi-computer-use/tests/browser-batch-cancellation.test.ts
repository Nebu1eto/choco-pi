import assert from "node:assert/strict";
import test from "node:test";
import {
  executeAct,
  executeFind,
  executeObserve,
  shutdownComputerUseSession,
  type UiAction,
} from "../src/bridge.ts";
import { createTestExtensionContext } from "./helpers/extension-context.ts";
import { replaceWithForbiddenBackend, startFakeCdp } from "./helpers/fake-cdp.ts";

test(
  "browser batches stop on abort, release paired input and unlock",
  { timeout: 15000 },
  async () => {
    const restoreBackend = replaceWithForbiddenBackend();
    const fake = await startFakeCdp();
    const commands = fake.commands;
    try {
      const ctx = await createTestExtensionContext(process.cwd());
      const roots = await executeFind("find", { kind: "browser_page" }, undefined, undefined, ctx);
      const root = roots.details?.windows[0]?.windowRef;
      assert.ok(root);
      async function observe() {
        const result = await executeObserve(
          "observe",
          { root, mode: "semantic" },
          undefined,
          undefined,
          ctx,
        );
        if (!result.details || !("stateId" in result.details))
          throw new Error("Missing browser details");
        return result.details.stateId;
      }
      const actions: UiAction[] = [
        { action: "typeText", text: "first" },
        { action: "click", x: 10, y: 20 },
        { action: "keypress", keys: ["shift", "A", "B"] },
        {
          action: "drag",
          path: [
            { x: 10, y: 20 },
            { x: 30, y: 40 },
          ],
        },
      ];
      for (const action of actions) {
        const stateId = await observe();
        const controller = new AbortController();
        const received = Promise.withResolvers<void>();
        let lateReply: (() => void) | undefined;
        fake.hold = (command, reply) => {
          if (
            !lateReply &&
            command.method.startsWith("Input.") &&
            command.params.type !== "keyUp" &&
            command.params.type !== "mouseReleased"
          ) {
            lateReply = reply;
            received.resolve();
            return true;
          }
          return false;
        };
        const start = commands.length;
        const transaction = executeAct(
          "act",
          { stateId, actions: [action, { action: "typeText", text: "second" }] },
          controller.signal,
          undefined,
          ctx,
        );
        const rejected = assert.rejects(transaction, /abort/i);
        await received.promise;
        controller.abort();
        assert.ok(lateReply);
        if (action.action === "typeText") {
          // A late first-action reply cannot authorize action two.
          lateReply();
          await rejected;
        } else {
          // Paired cleanup and rejection do not depend on the held reply.
          await rejected;
          lateReply();
        }
        fake.hold = undefined;
        const delivered = commands
          .slice(start)
          .filter((command) => command.method.startsWith("Input."));
        assert.equal(
          delivered.some((command) => command.params.text === "second"),
          false,
        );
        if (action.action === "click" || action.action === "drag")
          assert.deepEqual(
            delivered.map((command) => command.params.type),
            ["mousePressed", "mouseReleased"],
          );
        if (action.action === "keypress") {
          assert.deepEqual(
            delivered.map((command) => command.params.type),
            ["keyDown", "keyUp"],
          );
          assert.equal(delivered[0].params.modifiers, 8);
          assert.equal(delivered[1].params.modifiers, 8);
        }
        const freshState = await observe();
        await executeAct(
          "following",
          { stateId: freshState, actions: [{ action: "typeText", text: "following" }] },
          undefined,
          undefined,
          ctx,
        );
        assert.ok(commands.some((command) => command.params.text === "following"));
      }
    } finally {
      await shutdownComputerUseSession();
      await fake.close();
      restoreBackend();
    }
  },
);
