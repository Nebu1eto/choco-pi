import test from "node:test";
import assert from "node:assert/strict";
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationPropertySchema,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
  StringPropertySchema,
} from "@agentclientprotocol/sdk";
import {
  DEFAULT_PI_ACP_SESSION_IDLE_MS,
  PiAcpSession,
  SessionManager,
  boundedSessionIdleMs,
} from "../src/acp/session.ts";
import type { PiRpcEvent, PiRpcExit, PiRpcProcessLike } from "../src/pi-rpc/process.ts";
import { numberField, recordField, type PiExtensionUiResponse } from "../src/pi-rpc/protocol.ts";
import type { AcpConnectionLike } from "./helpers-fakes.ts";

class UiConnection implements AcpConnectionLike {
  readonly updates: SessionNotification[] = [];
  readonly elicitations: CreateElicitationRequest[] = [];
  handler: (request: CreateElicitationRequest) => Promise<CreateElicitationResponse> =
    async () => ({
      action: "cancel",
    });

  async sessionUpdate(update: SessionNotification): Promise<void> {
    this.updates.push(update);
  }

  async requestPermission(): Promise<RequestPermissionResponse> {
    throw new Error("these extension UI tests never request tool permission");
  }

  async unstable_createElicitation(
    request: CreateElicitationRequest,
  ): Promise<CreateElicitationResponse> {
    this.elicitations.push(request);
    return this.handler(request);
  }
}

class UiProcess implements PiRpcProcessLike {
  readonly responses: PiExtensionUiResponse[] = [];
  readonly attempts: PiExtensionUiResponse[] = [];
  readonly shutdownCalls: Array<number | undefined> = [];
  private handler: ((event: PiRpcEvent) => void) | undefined;
  failResponses = false;
  hangResponses = false;
  readonly promptCalls: string[] = [];

  onEvent(handler: (event: PiRpcEvent) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = undefined;
    };
  }

  emit(event: PiRpcEvent): void {
    this.handler?.(event);
  }

  async sendExtensionUiResponse(response: PiExtensionUiResponse): Promise<void> {
    this.attempts.push(response);
    if (this.failResponses) throw new Error("disconnected");
    if (this.hangResponses) await new Promise(() => {});
    this.responses.push(response);
  }

  async prompt(message: string): Promise<void> {
    this.promptCalls.push(message);
  }

  async shutdown(graceMs?: number): Promise<PiRpcExit> {
    this.shutdownCalls.push(graceMs);
    return { code: 0, signal: null };
  }
}

/** The `cancelled` flag of an extension UI reply, or `undefined` for other replies. */
function cancelledFlag(response: PiExtensionUiResponse): boolean | undefined {
  return "cancelled" in response ? response.cancelled : undefined;
}

/** The text payload of an extension UI reply. */
function responseValue(response: PiExtensionUiResponse): string {
  assert.ok("value" in response, "extension UI reply carries a text value");
  return response.value;
}

/** The form properties of an elicitation this adapter raised. */
function formProperties(
  request: CreateElicitationRequest,
): Record<string, ElicitationPropertySchema> {
  assert.ok(request.mode === "form", "extension UI elicitations use form mode");
  return request.requestedSchema.properties ?? {};
}

/** One string-typed form property of an elicitation this adapter raised. */
function stringProperty(request: CreateElicitationRequest, key: string): StringPropertySchema {
  const property = formProperties(request)[key];
  assert.ok(property?.type === "string", `elicitation property \`${key}\` is a string field`);
  return property;
}

/** The text of an `agent_message_chunk` notification. */
function messageChunkText(update: SessionUpdate | undefined): string {
  assert.ok(update?.sessionUpdate === "agent_message_chunk", "update is an agent message chunk");
  assert.ok(update.content.type === "text", "agent message chunk carries text content");
  return update.content.text;
}

/** How many extension UI dialogs the session still holds open. */
function pendingExtensionUiCount(session: PiAcpSession): number {
  const pending = recordField(session, "pendingExtensionUi");
  const size = pending === undefined ? undefined : numberField(pending, "size");
  assert.ok(size !== undefined, "PiAcpSession tracks its pending extension UI dialogs");
  return size;
}

function makeSession(conn = new UiConnection(), proc = new UiProcess()) {
  const session = new PiAcpSession({
    sessionId: "s-ui",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn,
    fileCommands: [],
  });
  return { conn, proc, session };
}

async function tick(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("session idle timeout defaults and clamps to one through 120 minutes", () => {
  assert.equal(boundedSessionIdleMs(undefined), DEFAULT_PI_ACP_SESSION_IDLE_MS);
  assert.equal(boundedSessionIdleMs("invalid"), DEFAULT_PI_ACP_SESSION_IDLE_MS);
  assert.equal(boundedSessionIdleMs(0), 60_000);
  assert.equal(boundedSessionIdleMs("90000"), 90_000);
  assert.equal(boundedSessionIdleMs(999_999_999), 120 * 60_000);
});

test("extension UI maps accepted form values and settles duplicate requests once", async () => {
  const { conn, proc } = makeSession();
  conn.handler = async (request): Promise<CreateElicitationResponse> => {
    const properties = formProperties(request);
    if (properties.confirmed) return { action: "accept", content: { confirmed: false } };
    if (stringProperty(request, "value").oneOf) {
      return { action: "accept", content: { value: "choice-1" } };
    }
    return { action: "accept", content: { value: "written text" } };
  };

  proc.emit({
    type: "extension_ui_request",
    id: "select",
    method: "select",
    title: "Pick",
    options: ["Alpha", "Beta"],
  });
  proc.emit({ type: "extension_ui_request", id: "confirm", method: "confirm", title: "Proceed?" });
  proc.emit({
    type: "extension_ui_request",
    id: "input",
    method: "input",
    title: "Name",
    placeholder: "Type here",
  });
  await tick();
  proc.emit({
    type: "extension_ui_request",
    id: "select",
    method: "select",
    options: ["Alpha", "Beta"],
  });
  await tick();

  assert.deepEqual(proc.responses, [
    { id: "select", value: "Beta" },
    { id: "confirm", confirmed: false },
    { id: "input", value: "written text" },
  ]);
  assert.equal(conn.elicitations.length, 3);
  assert.equal(conn.elicitations[0]!.message, "Pick");
  assert.deepEqual(stringProperty(conn.elicitations[0]!, "value").oneOf, [
    { const: "choice-0", title: "Alpha" },
    { const: "choice-1", title: "Beta" },
  ]);
  assert.equal(stringProperty(conn.elicitations[2]!, "value").description, "Type here");
  assert.equal(stringProperty(conn.elicitations[2]!, "value").maxLength, 10_000);
});

test("extension UI accepts Zed selection IDs carried in elicitation metadata", async () => {
  const { conn, proc } = makeSession();
  conn.handler = async () => ({ action: "accept", _meta: { optionId: "choice-1" } });

  proc.emit({
    type: "extension_ui_request",
    id: "zed-meta-select",
    method: "select",
    title: "Review target",
    options: ["Current session", "Branch base: main"],
  });
  await tick();

  assert.deepEqual(proc.responses, [{ id: "zed-meta-select", value: "Branch base: main" }]);
});

test("extension UI bounds editor defaults and accepted text to its schema maximum", async () => {
  const { conn, proc } = makeSession();
  conn.handler = async (request) => {
    const maxLength = stringProperty(request, "value").maxLength;
    assert.ok(maxLength !== undefined && maxLength !== null, "editor schema bounds its length");
    return { action: "accept", content: { value: "r".repeat(maxLength + 1) } };
  };

  proc.emit({
    type: "extension_ui_request",
    id: "editor",
    method: "editor",
    title: "Long editor",
    prefill: "d".repeat(10_001),
  });
  await tick();

  const schema = stringProperty(conn.elicitations[0]!, "value");
  assert.equal(schema.maxLength, 10_000);
  assert.equal(schema.default?.length, schema.maxLength);
  assert.equal(responseValue(proc.responses[0]!).length, schema.maxLength);
});

test("extension UI decline, cancel, error, timeout, and shutdown each settle once", async () => {
  const { conn, proc, session } = makeSession();
  let resolveLate!: (response: CreateElicitationResponse) => void;
  conn.handler = async (request) => {
    if (request.message === "Decline") return { action: "decline" };
    if (request.message === "Error") throw new Error("client failed");
    if (request.message === "Late")
      return await new Promise((resolve) => {
        resolveLate = resolve;
      });
    return await new Promise(() => {});
  };

  proc.emit({ type: "extension_ui_request", id: "decline", method: "confirm", title: "Decline" });
  proc.emit({ type: "extension_ui_request", id: "error", method: "input", title: "Error" });
  proc.emit({
    type: "extension_ui_request",
    id: "late",
    method: "input",
    title: "Late",
    timeoutMs: 5,
  });
  await tick(15);
  resolveLate({ action: "accept", content: { value: "too late" } });
  await tick();
  proc.emit({ type: "extension_ui_request", id: "shutdown", method: "confirm", title: "Pending" });
  await tick();
  await session.closeExtensionUi();
  await session.closeExtensionUi();

  assert.deepEqual(proc.responses, [
    { id: "decline", cancelled: true },
    { id: "error", cancelled: true },
    { id: "late", cancelled: true },
    { id: "shutdown", cancelled: true },
  ]);
});

test("extension UI excludes sensitive auth and surfaces notify, status, title, widget, and fallback", async () => {
  const { conn, proc } = makeSession();
  const events = [
    { id: "auth", method: "input", title: "API token", prefill: "never-send-this-token" },
    { id: "notify", method: "notify", message: "Done", notifyType: "success" },
    { id: "status", method: "setStatus", message: "Working" },
    { id: "title", method: "setTitle", title: "New title" },
    { id: "title-value", method: "setTitle", value: "Value title" },
    { id: "title-text", method: "setTitle", text: "Text title" },
    { id: "widget", method: "setWidget", message: "Panel" },
    { id: "other", method: "custom", title: "Custom prompt" },
  ];
  for (const event of events) proc.emit({ type: "extension_ui_request", ...event });
  await tick();

  assert.equal(conn.elicitations.length, 0);
  assert.equal(proc.responses.length, events.length);
  assert.ok(proc.responses.every((response) => cancelledFlag(response) === true));
  const updates = conn.updates.map((entry) => entry.update);
  assert.match(messageChunkText(updates[0]), /sensitive authentication/);
  assert.match(messageChunkText(updates[0]), /Terminal Thread/);
  assert.match(messageChunkText(updates[0]), /in the terminal/);
  assert.doesNotMatch(JSON.stringify(updates), /never-send-this-token/);
  assert.deepEqual(updates[1]?._meta, { piAcp: { notify: { level: "success" } } });

  const titles: string[] = [];
  let sessionInfoUpdates = 0;
  for (const update of updates) {
    if (update.sessionUpdate !== "session_info_update") continue;
    sessionInfoUpdates += 1;
    if (update.title) titles.push(update.title);
  }
  assert.deepEqual(titles, ["New title", "Value title", "Text title"]);
  assert.equal(sessionInfoUpdates, 5);
  assert.match(messageChunkText(updates.at(-1)), /custom UI request is not supported/);
  assert.match(messageChunkText(updates.at(-1)), /Open a Terminal Thread/);
});

test("extension UI tombstones use exact FIFO eviction without rejecting unseen IDs", async () => {
  const { conn, proc, session } = makeSession();

  for (let index = 0; index < 8_193; index += 1) {
    proc.emit({ type: "extension_ui_request", id: `notify-${index}`, method: "notify" });
  }
  proc.emit({ type: "extension_ui_request", id: "notify-0", method: "notify" });
  conn.handler = async () => await new Promise(() => {});
  proc.emit({
    type: "extension_ui_request",
    id: "notify-485231",
    method: "confirm",
    title: "Fresh colliding-pattern ID",
  });
  await tick();

  assert.equal(pendingExtensionUiCount(session), 1);
  assert.deepEqual(proc.responses.at(-1), { id: "notify-0", cancelled: true });

  await session.closeExtensionUi();
  assert.deepEqual(proc.responses.at(-1), { id: "notify-485231", cancelled: true });
});

test("shutdown reaches the subprocess when extension UI delivery never settles", async () => {
  const conn = new UiConnection();
  const proc = new UiProcess();
  const manager = new SessionManager();
  conn.handler = async () => await new Promise(() => {});
  proc.hangResponses = true;
  manager.getOrCreate("s-hanging-ui", {
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn,
  });

  proc.emit({
    type: "extension_ui_request",
    id: "pending-dialog",
    method: "confirm",
    title: "Pending",
  });
  await tick();

  const result = await Promise.race([
    manager.shutdownAll(17).then(() => "shutdown"),
    tick(100).then(() => "timeout"),
  ]);

  assert.equal(result, "shutdown");
  assert.deepEqual(proc.attempts, [{ id: "pending-dialog", cancelled: true }]);
  assert.deepEqual(proc.shutdownCalls, [17]);
});

test("extension UI records one cancelled attempt when the Pi transport disconnects", async () => {
  const { conn, proc } = makeSession();
  conn.handler = async () => ({ action: "cancel" });
  proc.failResponses = true;

  proc.emit({
    type: "extension_ui_request",
    id: "disconnect",
    method: "confirm",
    title: "Continue",
  });
  await tick();
  proc.emit({
    type: "extension_ui_request",
    id: "disconnect",
    method: "confirm",
    title: "Continue",
  });
  await tick();

  assert.deepEqual(proc.attempts, [{ id: "disconnect", cancelled: true }]);
  assert.deepEqual(proc.responses, []);
});

test("idle reaping cancels pending dialogs before shutting down and unregistering", async () => {
  const conn = new UiConnection();
  const proc = new UiProcess();
  const manager = new SessionManager({ sessionIdleMs: 10 });
  conn.handler = async () => await new Promise(() => {});
  manager.getOrCreate("s-idle-dialog", {
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn,
  });

  proc.emit({
    type: "extension_ui_request",
    id: "idle-dialog",
    method: "confirm",
    title: "Pending",
  });
  await tick(30);

  assert.equal(manager.maybeGet("s-idle-dialog"), undefined);
  assert.deepEqual(proc.attempts, [{ id: "idle-dialog", cancelled: true }]);
  assert.deepEqual(proc.shutdownCalls, [undefined]);
});

test("idle reaping waits for the active turn and queued turns to settle", async () => {
  const conn = new UiConnection();
  const proc = new UiProcess();
  const manager = new SessionManager({ sessionIdleMs: 10 });
  const session = manager.getOrCreate("s-idle-queue", {
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn,
  });

  const first = session.prompt("first");
  const second = session.prompt("second");
  await tick(30);
  assert.deepEqual(proc.shutdownCalls, []);
  assert.deepEqual(proc.promptCalls, ["first"]);

  proc.emit({ type: "agent_settled" });
  await tick();
  await tick(20);
  assert.deepEqual(proc.shutdownCalls, []);
  assert.deepEqual(proc.promptCalls, ["first", "second"]);

  proc.emit({ type: "agent_settled" });
  assert.deepEqual(await Promise.all([first, second]), ["end_turn", "end_turn"]);
  await tick(30);
  assert.equal(manager.maybeGet("s-idle-queue"), undefined);
  assert.deepEqual(proc.shutdownCalls, [undefined]);
});
