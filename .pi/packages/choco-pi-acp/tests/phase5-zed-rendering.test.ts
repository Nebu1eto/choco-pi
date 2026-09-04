import assert from "node:assert/strict";
import test from "node:test";

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { PiAcpSession, sanitizeExtensionUiText } from "../src/acp/session.ts";
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from "./helpers-fakes.ts";

/** Either shape a tool call is reported with over `session/update`. */
type ToolCallNotification = Extract<
  SessionUpdate,
  { sessionUpdate: "tool_call" | "tool_call_update" }
>;

/** Recorded `agent_message_chunk` payloads, in emission order. */
function agentMessageChunks(
  conn: FakeAgentSideConnection,
): Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" }>[] {
  const chunks: Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" }>[] = [];
  for (const { update } of conn.updates) {
    if (update.sessionUpdate === "agent_message_chunk") chunks.push(update);
  }
  return chunks;
}

/** The single recorded tool call notification with this id and status. */
function toolCallNotification(
  conn: FakeAgentSideConnection,
  toolCallId: string,
  status: string,
): ToolCallNotification {
  for (const { update } of conn.updates) {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
      continue;
    }
    if (update.toolCallId === toolCallId && update.status === status) return update;
  }
  assert.fail(`no ${status} tool call notification for ${toolCallId}`);
}

function makeSession(cwd = process.cwd()) {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  new PiAcpSession({
    sessionId: "phase5-zed-rendering",
    cwd,
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });
  return { conn, proc };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("sanitizes extension UI controls while preserving portable Unicode and whitespace", () => {
  const esc = String.fromCharCode(0x1b);
  const csi = String.fromCharCode(0x9b);
  const bell = String.fromCharCode(0x07);
  const st = `${esc}\\`;
  const input =
    `${esc}[31mCafé · 中文 … → 🙂${esc}[0m\r\n` +
    `tab\t${csi}38;5;2mgreen${csi}0m\r` +
    `${esc}]0;hidden title${bell}${esc}]8;;https://example.invalid${st}visible █▬─`;
  const sanitized = sanitizeExtensionUiText(input);

  assert.equal(sanitized, "Café · 中文 … → 🙂\ntab\tgreenvisible ###");
  assert.equal(sanitizeExtensionUiText(sanitized), sanitized);
});

test("sanitizes the observed context notification before emitting ACP text", async () => {
  const { conn, proc } = makeSession();
  const esc = String.fromCharCode(0x1b);
  const message = [
    `${esc}[38;2;212;212;212mContext Usage`,
    `Model context ████████░░ 14k/600k tokens (2.3%)`,
    `Skills └ 21 skills · 1.7k tokens${esc}[39m`,
  ].join("\n");

  proc.emit({
    type: "extension_ui_request",
    id: "context-notify",
    method: "notify",
    message,
  });
  await tick();

  const [update] = agentMessageChunks(conn);
  const content = update?.content;
  const text = content !== undefined && content.type === "text" ? content.text : "";
  assert.match(text, /Context Usage/);
  assert.match(text, /14k\/600k tokens \(2\.3%\)/);
  assert.match(text, /21 skills · 1\.7k tokens/);
  assert.match(text, /·/);
  assert.equal(text.includes(esc), false);
  assert.equal(text.includes(String.fromCharCode(0x9b)), false);
  assert.equal(text.includes("[38;2;212;212;212m"), false);
  assert.equal(text.includes("[39m"), false);
  assert.doesNotMatch(text, /[\u2500-\u259f\u25ac]/u);
});

test("emits successful embedded apply_patch as an ACP diff and keeps errors textual", async () => {
  const cwd = "/work/project";
  const { conn, proc } = makeSession(cwd);
  const code = [
    "const patch = `*** Begin Patch",
    "*** Update File: greet.js",
    "@@",
    "-// e2e-marker",
    "+// e2e-marker-2",
    "*** End Patch`;",
    "await tools.apply_patch(patch);",
  ].join("\n");

  proc.emit({
    type: "tool_execution_start",
    toolCallId: "exec-patch-success",
    toolName: "exec",
    args: { code },
  });
  proc.emit({
    type: "tool_execution_end",
    toolCallId: "exec-patch-success",
    isError: false,
    result: { content: [{ type: "text", text: "Applied patch successfully" }] },
  });
  proc.emit({
    type: "tool_execution_start",
    toolCallId: "exec-patch-error",
    toolName: "exec",
    args: { code },
  });
  proc.emit({
    type: "tool_execution_end",
    toolCallId: "exec-patch-error",
    isError: true,
    result: { content: [{ type: "text", text: "Patch failed" }] },
  });
  await tick();

  const success = toolCallNotification(conn, "exec-patch-success", "completed");
  assert.deepEqual(success.locations, [{ path: "/work/project/greet.js", line: 1 }]);
  assert.deepEqual(success.content, [
    {
      type: "diff",
      path: "/work/project/greet.js",
      oldText: "// e2e-marker\n",
      newText: "// e2e-marker-2\n",
    },
  ]);
  assert.equal(success.rawOutput, undefined);

  const failure = toolCallNotification(conn, "exec-patch-error", "failed");
  assert.equal(failure.status, "failed");
  assert.equal(
    Array.isArray(failure.content) && failure.content.some((item) => item.type === "diff"),
    false,
  );
});
