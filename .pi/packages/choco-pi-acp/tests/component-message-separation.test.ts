import test from "node:test";
import assert from "node:assert/strict";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { PiAcpAgent, type SessionManagerLike } from "../src/acp/agent.ts";
import { PiAcpSession } from "../src/acp/session.ts";
import { decodePiRpcEvent } from "../src/pi-rpc/protocol.ts";
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from "./helpers-fakes.ts";

// Zed appends consecutive agent text chunks to one rendered block, so distinct outputs
// must be separated by a paragraph break while one streamed message stays byte-exact.

const SEP = "\n\n";

/** A session manager that always resolves to one prepared session. */
class SingleSessionManager implements SessionManagerLike {
  private readonly session: PiAcpSession;

  constructor(session: PiAcpSession) {
    this.session = session;
  }

  async create(): Promise<PiAcpSession> {
    return this.session;
  }

  maybeGet(): PiAcpSession {
    return this.session;
  }

  get(): PiAcpSession {
    return this.session;
  }

  getOrCreate(): PiAcpSession {
    return this.session;
  }

  close(): void {}

  disposeAll(): void {}

  async shutdownAll(): Promise<void> {}
}

function newSession(
  conn: FakeAgentSideConnection,
  proc: FakePiRpcProcess,
  sessionId = "s1",
): PiAcpSession {
  return new PiAcpSession({
    sessionId,
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
  });
}

function agentFor(conn: FakeAgentSideConnection, session: PiAcpSession): PiAcpAgent {
  const agent = new PiAcpAgent(asAgentConn(conn));
  const sessions: SessionManagerLike = new SingleSessionManager(session);
  // `sessions` is private to `PiAcpAgent`; `Object.assign` installs the fake through
  // the same property without weakening any declared type.
  Object.assign(agent, { sessions });
  return agent;
}

/** One line per thread-visible update: text verbatim, thoughts prefixed, others bracketed. */
function describe(notification: SessionNotification): string | undefined {
  const { update } = notification;
  if (
    update.sessionUpdate === "agent_message_chunk" ||
    update.sessionUpdate === "agent_thought_chunk"
  ) {
    const body = update.content.type === "text" ? update.content.text : `<${update.content.type}>`;
    return update.sessionUpdate === "agent_thought_chunk" ? `thought:${body}` : body;
  }
  // Queue depth and similar metadata never render in the message stream.
  if (update.sessionUpdate === "session_info_update") return undefined;
  return `[${update.sessionUpdate}]`;
}

function transcript(conn: FakeAgentSideConnection, sessionId = "s1"): string[] {
  const lines: string[] = [];
  for (const notification of conn.updates) {
    if (notification.sessionId !== sessionId) continue;
    const line = describe(notification);
    if (line !== undefined) lines.push(line);
  }
  return lines;
}

let uiRequestCount = 0;

function notify(proc: FakePiRpcProcess, message: string): void {
  uiRequestCount += 1;
  proc.emit({
    type: "extension_ui_request",
    id: `ui-${uiRequestCount}`,
    method: "notify",
    message,
    notifyType: "info",
  });
}

function textDelta(proc: FakePiRpcProcess, delta: string): void {
  proc.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
}

function thinkingDelta(proc: FakePiRpcProcess, delta: string): void {
  proc.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta } });
}

/** Pi brackets each message with these events; the adapter decodes them as unknown events. */
function messageEnd(proc: FakePiRpcProcess): void {
  proc.emit(decodePiRpcEvent({ type: "message_end", message: { role: "assistant" } }));
}

function messageStart(proc: FakePiRpcProcess): void {
  proc.emit(decodePiRpcEvent({ type: "message_start", message: { role: "assistant" } }));
}

async function drain(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Wait until the agent has handed the `count`th prompt to Pi. */
async function promptSent(proc: FakePiRpcProcess, count: number): Promise<void> {
  for (let i = 0; i < 50 && proc.prompts.length < count; i += 1) await drain();
  assert.equal(proc.prompts.length, count, "the prompt reached Pi");
}

test("separation: notification then notification", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  newSession(conn, proc);

  notify(proc, "Review: 2 findings");
  notify(proc, "Review target selection was cancelled.");
  await drain();

  assert.deepEqual(transcript(conn), [
    "Review: 2 findings",
    `${SEP}Review target selection was cancelled.`,
  ]);
});

test("separation: notification then streamed assistant text", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  newSession(conn, proc);

  notify(proc, "Loaded 3 skills");
  messageStart(proc);
  textDelta(proc, "Hel");
  textDelta(proc, "lo");
  await drain();

  // Only the first chunk of the message is separated; the second continues it exactly.
  assert.deepEqual(transcript(conn), ["Loaded 3 skills", `${SEP}Hel`, "lo"]);
});

test("separation: assistant text then notification, and text resumed after it", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  newSession(conn, proc);

  textDelta(proc, "Working");
  textDelta(proc, " on it.");
  notify(proc, "Context nearing limit");
  textDelta(proc, " Done.");
  await drain();

  assert.deepEqual(transcript(conn), [
    "Working",
    " on it.",
    `${SEP}Context nearing limit`,
    `${SEP} Done.`,
  ]);
});

test("separation: two assistant messages in a row start separate paragraphs", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  newSession(conn, proc);

  messageStart(proc);
  textDelta(proc, "First.");
  messageEnd(proc);
  messageStart(proc);
  textDelta(proc, "Second.");
  messageEnd(proc);
  await drain();

  assert.deepEqual(transcript(conn), ["First.", `${SEP}Second.`]);
});

test("separation: the adapter's credential warning then anything that follows", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  newSession(conn, proc);

  proc.emit({ type: "extension_ui_request", id: "cred", method: "input", title: "API key" });
  notify(proc, "cred: no value (cancelled)");
  textDelta(proc, "Continuing.");
  await drain();

  const lines = transcript(conn);
  assert.equal(lines.length, 3);
  const warning = lines[0] ?? "";
  assert.ok(warning.length > 0 && !warning.startsWith(SEP), "the warning comes first, unprefixed");
  assert.equal(lines[1], `${SEP}cred: no value (cancelled)`);
  assert.equal(lines[2], `${SEP}Continuing.`);
  // The credential check itself is unchanged: the request is cancelled, nothing is sent.
  assert.deepEqual(proc.extensionUiResponses.slice(0, 1), [{ id: "cred", cancelled: true }]);
});

test("separation: a new tool call opens a new block, tool call updates do not", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  newSession(conn, proc);

  textDelta(proc, "Reading.");
  proc.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
  notify(proc, "After the tool call");
  proc.emit({
    type: "tool_execution_end",
    toolCallId: "t1",
    result: { content: [{ type: "text", text: "ok" }] },
  });
  notify(proc, "After the update");
  await drain();

  assert.deepEqual(transcript(conn), [
    "Reading.",
    "[tool_call]",
    "After the tool call",
    "[tool_call_update]",
    `${SEP}After the update`,
  ]);
});

test("separation: thought chunks and message chunks are separate channels", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  newSession(conn, proc);

  messageStart(proc);
  thinkingDelta(proc, "plan");
  textDelta(proc, "answer");
  messageEnd(proc);
  notify(proc, "note");
  messageStart(proc);
  thinkingDelta(proc, "more");
  messageEnd(proc);
  messageStart(proc);
  thinkingDelta(proc, "again");
  textDelta(proc, "done");
  await drain();

  assert.deepEqual(transcript(conn), [
    "thought:plan",
    // A thought and the answer that follows render as separate blocks already.
    "answer",
    `${SEP}note`,
    "thought:more",
    // Two distinct thoughts on the same channel are separated like messages.
    `thought:${SEP}again`,
    "done",
  ]);
});

test("separation: newlines already present are counted, streamed text is never altered", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  newSession(conn, proc);

  notify(proc, "ends with a blank line\n\n");
  textDelta(proc, "line one\n");
  textDelta(proc, "\n");
  textDelta(proc, "\nline two");
  notify(proc, "ends with one newline\n");
  notify(proc, "plain");
  notify(proc, "\n\nstarts with a blank line");
  await drain();

  assert.deepEqual(transcript(conn), [
    "ends with a blank line\n\n",
    "line one\n",
    "\n",
    "\nline two",
    `${SEP}ends with one newline\n`,
    "\nplain",
    "\n\nstarts with a blank line",
  ]);
});

test("separation: cancellation in the middle of a streamed message", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  const session = newSession(conn, proc);

  const first = session.prompt("one");
  textDelta(proc, "Hel");
  const second = session.prompt("two");
  await session.cancel();
  notify(proc, "Operation aborted");
  proc.emit({ type: "agent_settled" });

  assert.equal(await first, "cancelled");
  assert.equal(await second, "cancelled");
  assert.deepEqual(transcript(conn), [
    "Hel",
    `${SEP}Queued message (position 1).`,
    `${SEP}Cleared queued prompts.`,
    `${SEP}Operation aborted`,
  ]);
});

test("separation: command output follows queued updates in order and is separated", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  const session = newSession(conn, proc);

  notify(proc, "queued notification");
  await session.sendUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Steering mode: all" },
  });

  assert.deepEqual(transcript(conn), ["queued notification", `${SEP}Steering mode: all`]);
});

test("separation: two prompts in a row, each starting without a leading blank", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  const session = newSession(conn, proc);
  const agent = agentFor(conn, session);

  const first = agent.prompt({ sessionId: "s1", prompt: [{ type: "text", text: "one" }] });
  await promptSent(proc, 1);
  notify(proc, "N1");
  textDelta(proc, "Answer one");
  proc.emit({ type: "agent_settled" });
  assert.equal((await first).stopReason, "end_turn");

  const second = agent.prompt({ sessionId: "s1", prompt: [{ type: "text", text: "two" }] });
  await promptSent(proc, 2);
  notify(proc, "N2");
  textDelta(proc, "Answer two");
  proc.emit({ type: "agent_settled" });
  assert.equal((await second).stopReason, "end_turn");

  // The client renders each prompt as its own entry, so the separator state resets.
  assert.deepEqual(transcript(conn), ["N1", `${SEP}Answer one`, "N2", `${SEP}Answer two`]);
});

test("separation: adapter command output is the first output of its prompt", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  const session = newSession(conn, proc);
  const agent = agentFor(conn, session);

  notify(proc, "out-of-turn notification");
  notify(proc, "another one");
  await drain();
  const result = await agent.prompt({
    sessionId: "s1",
    prompt: [{ type: "text", text: "/steering" }],
  });

  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(
    transcript(conn).filter((line) => !line.startsWith("[")),
    ["out-of-turn notification", `${SEP}another one`, "Steering mode: unknown"],
  );
});

test("separation: state does not leak between sessions", async () => {
  const conn = new FakeAgentSideConnection();
  const procA = new FakePiRpcProcess();
  const procB = new FakePiRpcProcess();
  newSession(conn, procA, "a");
  newSession(conn, procB, "b");

  textDelta(procA, "from A");
  notify(procB, "first in B");
  notify(procA, "second in A");
  await drain();

  assert.deepEqual(transcript(conn, "a"), ["from A", `${SEP}second in A`]);
  assert.deepEqual(transcript(conn, "b"), ["first in B"]);
});
