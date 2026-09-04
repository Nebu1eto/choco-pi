import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";
import { PiAcpSession } from "../src/acp/session.ts";
import { decodePiRpcEvent } from "../src/pi-rpc/protocol.ts";
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from "./helpers-fakes.ts";

type ToolCallStart = Extract<SessionUpdate, { sessionUpdate: "tool_call" }>;
type ToolCallProgress = Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>;
type AgentMessageChunk = Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" }>;

/** The recorded `session/update` payload at `index`. */
function updateAt(conn: FakeAgentSideConnection, index: number): SessionUpdate {
  const notification = conn.updates[index];
  assert.ok(notification, `expected a session update at index ${index}`);
  return notification.update;
}

/** The recorded update at `index`, which must announce a new tool call. */
function toolCallAt(conn: FakeAgentSideConnection, index: number): ToolCallStart {
  const update = updateAt(conn, index);
  assert.ok(update.sessionUpdate === "tool_call", `update ${index} is a tool_call`);
  return update;
}

/** The recorded update at `index`, which must carry tool call progress. */
function toolCallUpdateAt(conn: FakeAgentSideConnection, index: number): ToolCallProgress {
  const update = updateAt(conn, index);
  assert.ok(update.sessionUpdate === "tool_call_update", `update ${index} is a tool_call_update`);
  return update;
}

/** The recorded update at `index`, which must be an agent message chunk. */
function chunkAt(conn: FakeAgentSideConnection, index: number): AgentMessageChunk {
  const update = updateAt(conn, index);
  assert.ok(
    update.sessionUpdate === "agent_message_chunk",
    `update ${index} is an agent_message_chunk`,
  );
  return update;
}

/** The text of the agent message chunk recorded at `index`. */
function chunkTextAt(conn: FakeAgentSideConnection, index: number): string {
  const { content } = chunkAt(conn, index);
  assert.ok(content.type === "text", `update ${index} carries text content`);
  return content.text;
}

/** The text of a notification that is an agent message chunk, else `undefined`. */
function chunkTextOf(notification: SessionNotification): string | undefined {
  const { update } = notification;
  if (update.sessionUpdate !== "agent_message_chunk") return undefined;
  return update.content.type === "text" ? update.content.text : undefined;
}

test("PiAcpSession: emits agent_message_chunk for text_delta", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  proc.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "hi" },
  });

  await new Promise((r) => setTimeout(r, 0));

  assert.equal(conn.updates.length, 1);
  assert.equal(conn.updates[0]!.sessionId, "s1");
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "hi" },
  });
});

test("PiAcpSession: emits agent_thought_chunk for thinking_delta", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  proc.emit({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "thinking..." },
  });

  await new Promise((r) => setTimeout(r, 0));

  assert.equal(conn.updates.length, 1);
  assert.equal(conn.updates[0]!.sessionId, "s1");
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "thinking..." },
  });
});

test("PiAcpSession: emits tool_call + tool_call_update + completes", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  proc.emit({
    type: "tool_execution_start",
    toolCallId: "t1",
    toolName: "bash",
    args: { command: "ls" },
  });
  proc.emit({
    type: "tool_execution_update",
    toolCallId: "t1",
    partialResult: { content: [{ type: "text", text: "running" }] },
  });
  proc.emit({
    type: "tool_execution_end",
    toolCallId: "t1",
    isError: false,
    result: { content: [{ type: "text", text: "done" }] },
  });

  await new Promise((r) => setTimeout(r, 0));

  assert.equal(conn.updates.length, 3);

  assert.equal(conn.updates[0]!.update.sessionUpdate, "tool_call");
  const started = toolCallAt(conn, 0);
  assert.equal(started.toolCallId, "t1");
  assert.equal(started.title, "ls");
  assert.equal(started.kind, "execute");
  assert.equal(started.status, "in_progress");
  assert.equal(started.locations, undefined);
  assert.deepEqual(started.content, [{ type: "terminal", terminalId: "t1" }]);
  assert.deepEqual(started._meta, {
    terminal_info: { terminal_id: "t1", cwd: process.cwd() },
    editorToolPresentation: {
      title: "bash",
      terminal: { command: "ls", cwd: process.cwd() },
    },
  });
  assert.equal(started.rawInput, undefined);

  assert.equal(conn.updates[1]!.update.sessionUpdate, "tool_call_update");
  const progressed = toolCallUpdateAt(conn, 1);
  assert.equal(progressed.toolCallId, "t1");
  assert.equal(progressed.status, "in_progress");
  assert.equal(progressed.content, undefined);
  assert.deepEqual(progressed._meta, {
    terminal_output: { terminal_id: "t1", data: "running" },
    editorToolPresentation: {
      title: "bash",
      terminal: { command: "ls", cwd: process.cwd() },
    },
  });
  assert.equal(progressed.rawOutput, undefined);

  assert.equal(conn.updates[2]!.update.sessionUpdate, "tool_call_update");
  const completed = toolCallUpdateAt(conn, 2);
  assert.equal(completed.toolCallId, "t1");
  assert.equal(completed.status, "completed");
  assert.equal(completed.content, undefined);
  assert.deepEqual(completed._meta, {
    terminal_output: { terminal_id: "t1", data: "done" },
    terminal_exit: { terminal_id: "t1", exit_code: 0, signal: null },
    editorToolPresentation: {
      title: "bash",
      terminal: { command: "ls", cwd: process.cwd(), exitCode: 0 },
    },
  });
  assert.equal(completed.rawOutput, undefined);
});

test("PiAcpSession: emits tool locations from pi path args", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  proc.emit({
    type: "tool_execution_start",
    toolCallId: "t1",
    toolName: "read",
    args: { path: "src/acp/session.ts" },
  });

  await new Promise((r) => setTimeout(r, 0));

  assert.equal(conn.updates.length, 1);
  assert.equal(conn.updates[0]!.update.sessionUpdate, "tool_call");
  assert.deepEqual(toolCallAt(conn, 0).locations, [
    { path: `${process.cwd()}/src/acp/session.ts` },
  ]);
});

test("PiAcpSession: handles extension select via ACP permission request", async () => {
  const conn = new FakeAgentSideConnection();
  conn.nextPermissionResponse = { outcome: { outcome: "selected", optionId: "choice-1" } };
  const proc = new FakePiRpcProcess();

  new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  proc.emit({
    type: "extension_ui_request",
    id: "ui-1",
    method: "select",
    title: "Pick one",
    options: ["Alpha", "Beta"],
  });

  await new Promise((r) => setTimeout(r, 0));

  assert.equal(conn.permissionRequests.length, 1);
  assert.deepEqual(conn.permissionRequests[0], {
    sessionId: "s1",
    toolCall: {
      toolCallId: "pi-ui-ui-1",
      title: "Pick one",
      kind: "other",
      status: "pending",
      rawInput: { method: "select", title: "Pick one", options: ["Alpha", "Beta"] },
    },
    options: [
      { optionId: "choice-0", name: "Alpha", kind: "allow_once" },
      { optionId: "choice-1", name: "Beta", kind: "allow_once" },
    ],
  });
  assert.deepEqual(proc.extensionUiResponses, [{ id: "ui-1", value: "Beta" }]);
});

test("PiAcpSession: handles extension confirm via ACP permission request", async () => {
  const conn = new FakeAgentSideConnection();
  conn.nextPermissionResponse = { outcome: { outcome: "selected", optionId: "no" } };
  const proc = new FakePiRpcProcess();

  new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  proc.emit({
    type: "extension_ui_request",
    id: "ui-2",
    method: "confirm",
    title: "Clear session?",
    message: "All messages will be lost.",
  });

  await new Promise((r) => setTimeout(r, 0));

  assert.equal(conn.permissionRequests.length, 1);
  assert.deepEqual(conn.permissionRequests[0]!.options, [
    { optionId: "yes", name: "Yes", kind: "allow_once" },
    { optionId: "no", name: "No", kind: "reject_once" },
  ]);
  assert.deepEqual(proc.extensionUiResponses, [{ id: "ui-2", confirmed: false }]);
});

test("PiAcpSession: sends cancelled response when ACP confirm is cancelled", async () => {
  const conn = new FakeAgentSideConnection();
  conn.nextPermissionResponse = { outcome: { outcome: "cancelled" } };
  const proc = new FakePiRpcProcess();

  new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  proc.emit({ type: "extension_ui_request", id: "ui-5", method: "confirm", title: "Continue?" });

  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(proc.extensionUiResponses, [{ id: "ui-5", cancelled: true }]);
});

test("PiAcpSession: cancels unsupported input and editor extension UI requests with visible fallback", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  proc.emit({ type: "extension_ui_request", id: "ui-3", method: "input", title: "Enter name" });
  proc.emit({ type: "extension_ui_request", id: "ui-4", method: "editor", title: "Edit text" });

  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(proc.extensionUiResponses, [
    { id: "ui-3", cancelled: true },
    { id: "ui-4", cancelled: true },
  ]);
  assert.equal(conn.updates.length, 2);
  assert.match(chunkTextAt(conn, 0), /input UI request is not supported/);
  assert.match(chunkTextAt(conn, 1), /editor UI request is not supported/);
});

test("PiAcpSession: emits agent_message_chunk for auto_retry_start with attempt/maxAttempts and rounded delay", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  proc.emit({ type: "auto_retry_start", attempt: 2, maxAttempts: 5, delayMs: 2400 });

  await new Promise((r) => setTimeout(r, 0));

  assert.equal(conn.updates.length, 1);
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Retrying (attempt 2/5, waiting 2s)..." },
  });
});

test("PiAcpSession: formats a positive sub-second auto_retry_start delay as waiting 1s", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  proc.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1 });

  await new Promise((r) => setTimeout(r, 0));

  assert.equal(conn.updates.length, 1);
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Retrying (attempt 1/3, waiting 1s)..." },
  });
});

test("PiAcpSession: falls back to a generic retry message when auto_retry_start fields are missing or malformed", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  proc.emit(
    decodePiRpcEvent({
      type: "auto_retry_start",
      attempt: "oops",
      maxAttempts: null,
      delayMs: "bad",
    }),
  );

  await new Promise((r) => setTimeout(r, 0));

  assert.equal(conn.updates.length, 1);
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Retrying..." },
  });
});

test("PiAcpSession: omits raw errorMessage content from surfaced auto_retry_start status text", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  proc.emit({
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 4,
    delayMs: 1500,
    errorMessage: "provider overloaded: 529",
  });

  await new Promise((r) => setTimeout(r, 0));

  assert.equal(conn.updates.length, 1);
  assert.equal(conn.updates[0]!.update.sessionUpdate, "agent_message_chunk");
  assert.equal(chunkTextAt(conn, 0), "Retrying (attempt 1/4, waiting 2s)...");
  assert.equal(chunkTextAt(conn, 0).includes("provider overloaded"), false);
});

test("PiAcpSession: emits agent_message_chunk for auto_retry_end", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  proc.emit({ type: "auto_retry_end" });

  await new Promise((r) => setTimeout(r, 0));

  assert.equal(conn.updates.length, 1);
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Retry finished, resuming." },
  });
});

test("PiAcpSession: emits agent_message_chunk for auto_compaction_start", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  proc.emit({ type: "auto_compaction_start" });

  await new Promise((r) => setTimeout(r, 0));

  assert.equal(conn.updates.length, 1);
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Context nearing limit, running automatic compaction..." },
  });
});

test("PiAcpSession: emits agent_message_chunk for auto_compaction_end", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  proc.emit({ type: "auto_compaction_end" });

  await new Promise((r) => setTimeout(r, 0));

  assert.equal(conn.updates.length, 1);
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text: "Automatic compaction finished; context was summarized to continue the session.",
    },
  });
});

test("PiAcpSession: preserves ordering when auto_retry_start is interleaved with text_delta events", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  proc.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "before " },
  });
  proc.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 2000 });
  proc.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "after" },
  });

  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(
    conn.updates.map((u) => u.update),
    [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "before " } },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Retrying (attempt 1/2, waiting 2s)..." },
      },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "after" } },
    ],
  );
});

test("PiAcpSession: emits streamed tool locations from pi path args", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  proc.emit({
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_start",
      toolCall: {
        id: "t1",
        name: "write",
        arguments: { path: "/tmp/test.txt", content: "hello" },
      },
    },
  });

  await new Promise((r) => setTimeout(r, 0));

  assert.equal(conn.updates.length, 1);
  assert.equal(conn.updates[0]!.update.sessionUpdate, "tool_call");
  assert.deepEqual(toolCallAt(conn, 0).locations, [{ path: "/tmp/test.txt" }]);
});

test("PiAcpSession: emits edit tool line when oldText matches uniquely", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  const cwd = mkdtempSync(join(tmpdir(), "pi-acp-lines-"));
  const filePath = join(cwd, "a.txt");

  mkdirSync(cwd, { recursive: true });
  writeFileSync(filePath, "one\ntwo\nneedle\nthree\n", "utf8");

  new PiAcpSession({
    sessionId: "s1",
    cwd,
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  proc.emit({
    type: "tool_execution_start",
    toolCallId: "t1",
    toolName: "edit",
    args: { path: "a.txt", oldText: "needle" },
  });

  await new Promise((r) => setTimeout(r, 0));

  assert.equal(conn.updates.length, 1);
  assert.equal(conn.updates[0]!.update.sessionUpdate, "tool_call");
  assert.deepEqual(toolCallAt(conn, 0).locations, [{ path: filePath, line: 3 }]);
});

test("PiAcpSession: emits edit tool line from edits array when oldText matches uniquely", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  const cwd = mkdtempSync(join(tmpdir(), "pi-acp-lines-edits-"));
  const filePath = join(cwd, "a.txt");

  mkdirSync(cwd, { recursive: true });
  writeFileSync(filePath, "one\ntwo\nneedle\nthree\n", "utf8");

  new PiAcpSession({
    sessionId: "s1",
    cwd,
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  proc.emit({
    type: "tool_execution_start",
    toolCallId: "t1",
    toolName: "edit",
    args: { path: "a.txt", edits: [{ oldText: "needle", newText: "replacement" }] },
  });

  await new Promise((r) => setTimeout(r, 0));

  assert.equal(conn.updates.length, 1);
  assert.equal(conn.updates[0]!.update.sessionUpdate, "tool_call");
  assert.deepEqual(toolCallAt(conn, 0).locations, [{ path: filePath, line: 3 }]);
});

test("PiAcpSession: emits edit tool line from stringified edits array", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  const cwd = mkdtempSync(join(tmpdir(), "pi-acp-lines-edits-string-"));
  const filePath = join(cwd, "a.txt");

  mkdirSync(cwd, { recursive: true });
  writeFileSync(filePath, "one\ntwo\nneedle\nthree\n", "utf8");

  new PiAcpSession({
    sessionId: "s1",
    cwd,
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  proc.emit({
    type: "tool_execution_start",
    toolCallId: "t1",
    toolName: "edit",
    args: { path: "a.txt", edits: JSON.stringify([{ oldText: "needle", newText: "replacement" }]) },
  });

  await new Promise((r) => setTimeout(r, 0));

  assert.equal(conn.updates.length, 1);
  assert.equal(conn.updates[0]!.update.sessionUpdate, "tool_call");
  assert.deepEqual(toolCallAt(conn, 0).locations, [{ path: filePath, line: 3 }]);
});

test("PiAcpSession: omits edit tool line when oldText matches multiple times", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  const cwd = mkdtempSync(join(tmpdir(), "pi-acp-lines-dup-"));
  const filePath = join(cwd, "a.txt");

  mkdirSync(cwd, { recursive: true });
  writeFileSync(filePath, "one\nneedle\ntwo\nneedle\n", "utf8");

  new PiAcpSession({
    sessionId: "s1",
    cwd,
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  proc.emit({
    type: "tool_execution_start",
    toolCallId: "t2",
    toolName: "edit",
    args: { path: "a.txt", oldText: "needle" },
  });

  await new Promise((r) => setTimeout(r, 0));

  assert.equal(conn.updates.length, 1);
  assert.equal(conn.updates[0]!.update.sessionUpdate, "tool_call");
  assert.deepEqual(toolCallAt(conn, 0).locations, [{ path: filePath }]);
});

test("PiAcpSession: prompt stays open through retry runs until agent_settled", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  const session = new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  let resolved = false;
  const p = session.prompt("hello").then((reason) => {
    resolved = true;
    return reason;
  });

  proc.emit({ type: "agent_start" });
  proc.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000 });
  proc.emit({ type: "agent_end", willRetry: true });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(resolved, false);

  proc.emit({ type: "agent_start" });
  proc.emit({ type: "turn_end" });
  proc.emit({ type: "agent_end", willRetry: false });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(resolved, false);

  proc.emit({ type: "agent_settled" });
  const reason = await p;
  assert.equal(reason, "end_turn");
});

test("PiAcpSession: does not re-emit startup info on first prompt after it was already sent", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  const session = new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  const notice = "New version available: v0.74.0 (installed v0.73.1).";

  session.setStartupInfo(notice);
  session.sendStartupInfoIfPending();
  await new Promise((r) => setTimeout(r, 0));

  const p = session.prompt("hello");
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(proc.prompts.length, 1);
  assert.equal(proc.prompts[0]!.message, "hello");
  const startupUpdates = conn.updates.filter((entry) => chunkTextOf(entry) === notice);
  assert.equal(startupUpdates.length, 1);

  proc.emit({ type: "agent_start" });
  proc.emit({ type: "turn_end" });
  proc.emit({ type: "agent_end" });
  proc.emit({ type: "agent_settled" });

  const reason = await p;
  assert.equal(reason, "end_turn");
});

test("PiAcpSession: cancel flips stopReason to cancelled", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  const session = new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  const p = session.prompt("hello");
  await session.cancel();
  proc.emit({ type: "agent_start" });
  proc.emit({ type: "turn_end" });
  proc.emit({ type: "agent_end" });
  proc.emit({ type: "agent_settled" });
  const reason = await p;

  assert.equal(proc.abortCount, 1);
  assert.equal(reason, "cancelled");
});

test("PiAcpSession: queues concurrent prompt and starts it after agent_settled", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  const session = new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  const first = session.prompt("one");
  const second = session.prompt("two");

  assert.equal(proc.prompts.length, 1);
  assert.equal(proc.prompts[0]!.message, "one");

  proc.emit({ type: "agent_start" });
  proc.emit({ type: "turn_end" });
  proc.emit({ type: "agent_end" });
  proc.emit({ type: "agent_settled" });

  const r1 = await first;
  assert.equal(r1, "end_turn");

  assert.equal(proc.prompts.length, 2);
  assert.equal(proc.prompts[1]!.message, "two");

  proc.emit({ type: "agent_start" });
  proc.emit({ type: "turn_end" });
  proc.emit({ type: "agent_end" });
  proc.emit({ type: "agent_settled" });

  const r2 = await second;
  assert.equal(r2, "end_turn");
});

test("PiAcpSession: cancel clears queued prompts", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  const session = new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  const first = session.prompt("one");
  const second = session.prompt("two");

  assert.equal(proc.prompts.length, 1);

  await session.cancel();
  proc.emit({ type: "agent_start" });
  proc.emit({ type: "turn_end" });
  proc.emit({ type: "agent_end" });
  proc.emit({ type: "agent_settled" });

  const r1 = await first;
  const r2 = await second;

  assert.equal(r1, "cancelled");
  assert.equal(r2, "cancelled");
});

test("PiAcpSession: expands /command before sending to pi", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  const session = new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [
      {
        name: "hello",
        description: "test",
        content: "Say hello to $1",
        source: "(project)",
      },
    ],
  });

  const p = session.prompt("/hello world");
  assert.equal(proc.prompts.length, 1);
  assert.equal(proc.prompts[0]!.message, "Say hello to world");

  proc.emit({ type: "agent_start" });
  proc.emit({ type: "turn_end" });
  proc.emit({ type: "agent_end" });
  proc.emit({ type: "agent_settled" });

  const reason = await p;
  assert.equal(reason, "end_turn");
});

test("PiAcpSession: tags extension notify chunks with severity in _meta", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  proc.emit({
    type: "extension_ui_request",
    id: "n1",
    method: "notify",
    message: "MCP: connection failed",
    notifyType: "error",
  });

  await new Promise((r) => setTimeout(r, 0));

  assert.equal(conn.updates.length, 1);
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "MCP: connection failed" },
    _meta: { piAcp: { notify: { level: "error" } } },
  });
  assert.deepEqual(proc.extensionUiResponses[0], { id: "n1", cancelled: true });
});

test("PiAcpSession: defaults notify severity to info when notifyType is absent", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  proc.emit({
    type: "extension_ui_request",
    id: "n2",
    method: "notify",
    message: "heads up",
  });

  await new Promise((r) => setTimeout(r, 0));

  assert.equal(conn.updates.length, 1);
  assert.deepEqual(chunkAt(conn, 0)._meta, {
    piAcp: { notify: { level: "info" } },
  });
});
