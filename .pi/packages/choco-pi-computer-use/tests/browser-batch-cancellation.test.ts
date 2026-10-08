import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";

function isTcpAddress(value: AddressInfo | string | null): value is AddressInfo {
  return (
    value !== null &&
    Object.hasOwn(Object(value), "port") &&
    Object.hasOwn(Object(value), "address") &&
    Object.hasOwn(Object(value), "family")
  );
}
import {
  executeAct,
  executeFind,
  executeObserve,
  shutdownComputerUseSession,
  type UiAction,
} from "../src/bridge.ts";
import { replaceCdpTransportForTest, type CdpTransport } from "../src/cdp.ts";
import { isJsonObject, isNumber, isString, type JsonObject, type JsonValue } from "../src/json.ts";
import { replacePlatformBackendForTest } from "../src/platform/index.ts";
import { createTestExtensionContext } from "./helpers/extension-context.ts";

interface Command {
  id: number;
  method: string;
  params: JsonObject;
}

function commandFrom(raw: string): Command {
  const value: JsonValue = JSON.parse(raw);
  if (
    !isJsonObject(value) ||
    !isNumber(value.id) ||
    !isString(value.method) ||
    !isJsonObject(value.params)
  )
    throw new Error("Invalid CDP command");
  return { id: value.id, method: value.method, params: value.params };
}

function forbidden(): never {
  throw new Error("Native backend must not be invoked");
}

test(
  "browser batches stop on abort, release paired input and unlock",
  { timeout: 15000 },
  async () => {
    const restoreBackend = replacePlatformBackendForTest({
      name: "macos",
      async ensureReady(_ctx, state) {
        return state;
      },
      async listApps() {
        return [];
      },
      async listRoots() {
        return [];
      },
      async getFrontmost() {
        return forbidden();
      },
      async focusWindow() {
        return forbidden();
      },
      async observe() {
        return forbidden();
      },
      async act() {
        return forbidden();
      },
      async readText() {
        return forbidden();
      },
      async waitFor() {
        return forbidden();
      },
      isBrowserApp() {
        return false;
      },
      isChromeFamilyApp() {
        return false;
      },
      async openBrowserLocation() {
        return forbidden();
      },
    });
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify([
          {
            id: "fixture",
            type: "page",
            title: "Fixture",
            url: "about:blank",
            webSocketDebuggerUrl: `ws://127.0.0.1:${listeningPort}/devtools/page/fixture`,
          },
        ]),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address();
    if (!isTcpAddress(port)) throw new Error("Missing TCP address");
    const listeningPort = port.port;
    const oldPort = process.env.PI_COMPUTER_USE_CDP_PORT;
    process.env.PI_COMPUTER_USE_CDP_PORT = String(listeningPort);
    const commands: Command[] = [];
    let hold: ((command: Command, reply: () => void) => boolean) | undefined;
    const restoreTransport = replaceCdpTransportForTest(() => {
      const transport: CdpTransport = {
        readyState: WebSocket.OPEN,
        onopen: null,
        onclose: null,
        onerror: null,
        onmessage: null,
        close() {},
        send(data) {
          const command = commandFrom(data);
          commands.push(command);
          let result: JsonObject = {};
          if (command.method === "Runtime.evaluate") result = { result: { value: "Fixture page" } };
          else if (command.method === "Accessibility.getFullAXTree") result = { nodes: [] };
          else if (command.method === "DOM.resolveNode") result = { object: { objectId: "node" } };
          const reply = () =>
            transport.onmessage?.(
              new MessageEvent("message", { data: JSON.stringify({ id: command.id, result }) }),
            );
          if (!hold?.(command, reply)) queueMicrotask(reply);
        },
      };
      queueMicrotask(() => transport.onopen?.(new Event("open")));
      return transport;
    });
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
        hold = (command, reply) => {
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
        hold = undefined;
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
      restoreTransport();
      restoreBackend();
      if (oldPort === undefined) delete process.env.PI_COMPUTER_USE_CDP_PORT;
      else process.env.PI_COMPUTER_USE_CDP_PORT = oldPort;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
