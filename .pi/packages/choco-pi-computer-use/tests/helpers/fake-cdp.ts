import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { replaceCdpTransportForTest, type CdpTransport } from "../../src/cdp.ts";
import {
  isJsonObject,
  isNumber,
  isString,
  type JsonObject,
  type JsonValue,
} from "../../src/json.ts";
import { replacePlatformBackendForTest } from "../../src/platform/index.ts";

/** One CDP command the bridge sent, in send order across every connection. */
export interface FakeCdpCommand {
  id: number;
  method: string;
  params: JsonObject;
}

/**
 * How the fake answers a command: a result, a protocol error, or closing the
 * connection without a reply. `undefined` from a responder uses the default.
 */
export type FakeCdpResponse = { result: JsonObject } | { error: string } | "close";

export interface FakeCdpPage {
  id: string;
  title: string;
  url: string;
}

export interface FakeCdpOptions {
  page?: FakeCdpPage;
  /** Answer the viewport probe with this [width, height]; otherwise it gets the page text. */
  viewport?: [number, number];
  /** Accessibility.getFullAXTree nodes. */
  axNodes?: JsonObject[];
}

export interface FakeCdp {
  readonly port: number;
  readonly commands: FakeCdpCommand[];
  /** Page targets served by /json/list; tests may remove or restore them. */
  pages: FakeCdpPage[];
  /** When true, /json/list answers with invalid JSON. */
  listBroken: boolean;
  /** Overrides the default answer for a command. */
  respond: ((command: FakeCdpCommand) => FakeCdpResponse | undefined) | undefined;
  /** Returns true to keep a reply until the test calls `reply`. */
  hold: ((command: FakeCdpCommand, reply: () => void) => boolean) | undefined;
  /** Commands with an input-bearing method (keys, mouse, text, focus, page script). */
  inputCommands(from?: number): FakeCdpCommand[];
  close(): Promise<void>;
}

const INPUT_METHODS = new Set([
  "Input.dispatchKeyEvent",
  "Input.dispatchMouseEvent",
  "Input.insertText",
  "Runtime.callFunctionOn",
]);

function commandFrom(raw: string): FakeCdpCommand {
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

function isTcpAddress(value: AddressInfo | string | null): value is AddressInfo {
  return (
    value !== null &&
    Object.hasOwn(Object(value), "port") &&
    Object.hasOwn(Object(value), "address") &&
    Object.hasOwn(Object(value), "family")
  );
}

function forbidden(): never {
  throw new Error("Native backend must not be invoked");
}

/** Replaces the platform backend with one that refuses every native call; returns the restore function. */
export function replaceWithForbiddenBackend(): () => void {
  return replacePlatformBackendForTest({
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
    async restoreUserFocus() {
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
}

/**
 * A fake CDP endpoint: a local HTTP page listing plus the test-only transport
 * hook, so the production CDP client and protocol handling run unchanged and
 * nothing reaches a real browser. Sets PI_COMPUTER_USE_CDP_PORT until close().
 */
export async function startFakeCdp(options: FakeCdpOptions = {}): Promise<FakeCdp> {
  const page = options.page ?? { id: "fixture", title: "Fixture", url: "about:blank" };
  let port = 0;
  const server: Server = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (fake.listBroken) {
      res.end("not json");
      return;
    }
    res.end(
      JSON.stringify(
        fake.pages.map((entry) => ({
          ...entry,
          type: "page",
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${entry.id}`,
        })),
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!isTcpAddress(address)) throw new Error("Missing TCP address");
  port = address.port;
  const previousPort = process.env.PI_COMPUTER_USE_CDP_PORT;
  process.env.PI_COMPUTER_USE_CDP_PORT = String(port);

  const defaultResult = (command: FakeCdpCommand): JsonObject => {
    if (command.method === "Runtime.evaluate") {
      const expression = isString(command.params.expression) ? command.params.expression : "";
      if (options.viewport && expression.includes("innerWidth"))
        return { result: { value: options.viewport } };
      return { result: { value: "Fixture page" } };
    }
    if (command.method === "Accessibility.getFullAXTree") return { nodes: options.axNodes ?? [] };
    if (command.method === "DOM.resolveNode") return { object: { objectId: "node" } };
    return {};
  };

  const restoreTransport = replaceCdpTransportForTest(() => {
    let readyState: number = WebSocket.OPEN;
    const transport: CdpTransport = {
      get readyState() {
        return readyState;
      },
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      close() {
        readyState = WebSocket.CLOSED;
      },
      send(data) {
        const command = commandFrom(data);
        fake.commands.push(command);
        const response = fake.respond?.(command) ?? { result: defaultResult(command) };
        if (response === "close") {
          readyState = WebSocket.CLOSED;
          queueMicrotask(() => transport.onclose?.(new CloseEvent("close")));
          return;
        }
        const payload =
          "error" in response
            ? { id: command.id, error: { message: response.error } }
            : { id: command.id, result: response.result };
        const reply = () =>
          transport.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
        if (!fake.hold?.(command, reply)) queueMicrotask(reply);
      },
    };
    queueMicrotask(() => transport.onopen?.(new Event("open")));
    return transport;
  });

  const fake: FakeCdp = {
    port,
    commands: [],
    pages: [page],
    listBroken: false,
    respond: undefined,
    hold: undefined,
    inputCommands(from = 0) {
      return fake.commands.slice(from).filter((command) => INPUT_METHODS.has(command.method));
    },
    async close() {
      restoreTransport();
      if (previousPort === undefined) delete process.env.PI_COMPUTER_USE_CDP_PORT;
      else process.env.PI_COMPUTER_USE_CDP_PORT = previousPort;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
  return fake;
}
