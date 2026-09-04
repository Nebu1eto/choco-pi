import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PiAcpAgent } from "../src/acp/agent.ts";
import {
  isBoundaryArray,
  isBoundaryRecord,
  isString,
  parseJsonLine,
  type BoundaryRecord,
} from "../src/boundary.ts";
import { PiAcpSession } from "../src/acp/session.ts";
import { PiRpcProcess } from "../src/pi-rpc/process.ts";
import { ToolPresentationTracker } from "../src/translate/tool-presentation.ts";
import { FakeAgentSideConnection, asAgentConn } from "./helpers-fakes.ts";

function executable(root: string, source: string): string {
  const path = join(root, "fake-pi");
  writeFileSync(path, `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), 1_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function terminalOutputText(entry: FakeAgentSideConnection["updates"][number]): string | undefined {
  const update = entry.update;
  if (update.sessionUpdate !== "tool_call_update" || !isBoundaryRecord(update._meta)) {
    return undefined;
  }
  const terminalOutput = update._meta.terminal_output;
  return isBoundaryRecord(terminalOutput) && isString(terminalOutput.data)
    ? terminalOutput.data
    : undefined;
}

function spawnRecord(records: BoundaryRecord[]): BoundaryRecord | undefined {
  return records.find((record) => record.type === "spawn");
}

const rpcResponder = `
const fs = require("node:fs");
const readline = require("node:readline");
const recordsPath = process.env.PHASE5_RECORDS;
const sessionId = process.env.PHASE5_SESSION_ID || "phase5-session";
fs.appendFileSync(recordsPath, JSON.stringify({ type: "spawn", argv: process.argv.slice(2), pid: process.pid }) + "\\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(recordsPath, JSON.stringify({ type: "request", command: request.type }) + "\\n");
  let data = {};
  if (request.type === "get_state") data = { sessionId, thinkingLevel: "medium", model: { provider: "test", id: "model" } };
  if (request.type === "get_available_models") data = { models: [{ provider: "test", id: "model", name: "Model" }] };
  if (request.type === "get_commands") data = { commands: [] };
  if (request.type === "get_messages") data = { messages: [{ role: "user", content: "Persisted question" }, { role: "assistant", content: [{ type: "text", text: "Persisted answer" }] }] };
  send({ type: "response", id: request.id, command: request.type, success: true, data });
  if (request.type === "prompt") {
    send({ type: "agent_start" });
    send({ type: "tool_execution_start", toolCallId: "large-output", toolName: "bash", args: { command: "generate" } });
    send({ type: "tool_execution_update", toolCallId: "large-output", partialResult: { content: [{ type: "text", text: "x".repeat(50_000) }] } });
    send({ type: "tool_execution_end", toolCallId: "large-output", isError: false, result: { content: [{ type: "text", text: "done" }], exitCode: 0 } });
    send({ type: "agent_end" });
    send({ type: "agent_settled" });
  }
});
`;

test("the real ACP turn queue rejects the sixty-fifth queued prompt explicitly", async () => {
  const root = mkdtempSync(join(tmpdir(), "choco-pi-phase5-turn-queue-"));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  const sessionId = `phase5-queue-${randomUUID()}`;
  const client = new FakeAgentSideConnection();
  const agent = new PiAcpAgent(asAgentConn(client), {
    piCommand: executable(
      root,
      `
const readline = require("node:readline");
const sessionId = ${JSON.stringify(sessionId)};
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  let data = {};
  if (request.type === "get_state") data = { sessionId, thinkingLevel: "medium", model: { provider: "test", id: "model" } };
  if (request.type === "get_available_models") data = { models: [{ provider: "test", id: "model", name: "Model" }] };
  if (request.type === "get_commands") data = { commands: [] };
  send({ type: "response", id: request.id, command: request.type, success: true, data });
  if (request.type === "abort") send({ type: "agent_settled" });
});
`,
    ),
  });

  try {
    await bounded(agent.newSession({ cwd: root, mcpServers: [] }), "create queue session");

    const prompt = (text: string) => agent.prompt({ sessionId, prompt: [{ type: "text", text }] });
    const accepted = [prompt("active")];
    for (let index = 0; index < 64; index += 1) {
      accepted.push(prompt(`queued ${index + 1}`));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await assert.rejects(
      prompt("overflow"),
      /Pi ACP turn queue is full \(maximum 64 queued prompts\)/,
    );

    await bounded(agent.cancel({ sessionId }), "cancel full turn queue");
    assert.deepEqual(
      await bounded(Promise.all(accepted), "settle accepted queued turns"),
      Array.from({ length: 65 }, () => ({ stopReason: "cancelled" })),
    );
  } finally {
    await bounded(agent.shutdown(50), "shutdown queue session");
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("large streamed terminal output crosses a scripted Pi child over real stdio and is truncation-marked", async () => {
  const root = mkdtempSync(join(tmpdir(), "choco-pi-phase5-stream-"));
  const recordsPath = join(root, "records.jsonl");
  const previousRecords = process.env.PHASE5_RECORDS;
  process.env.PHASE5_RECORDS = recordsPath;
  const client = new FakeAgentSideConnection();
  const agent = new PiAcpAgent(asAgentConn(client), {
    piCommand: executable(root, rpcResponder),
  });

  try {
    const session = await bounded(
      agent.newSession({ cwd: root, mcpServers: [] }),
      "create streamed-output session",
    );
    const response = await bounded(
      agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "stream output" }],
      }),
      "complete streamed-output prompt",
    );
    assert.deepEqual(response, { stopReason: "end_turn" });

    const output = client.updates.find((entry) =>
      terminalOutputText(entry)?.includes("[truncated]"),
    );
    const text = output ? terminalOutputText(output) : undefined;
    assert.ok(isString(text));
    assert.equal(text.length, 32 * 1024);
    assert.match(text, /…\[truncated\]$/);
    assert.equal(JSON.stringify(output).includes("x".repeat(40_000)), false);
  } finally {
    await bounded(agent.shutdown(100), "shutdown streamed-output session");
    if (previousRecords === undefined) delete process.env.PHASE5_RECORDS;
    else process.env.PHASE5_RECORDS = previousRecords;
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversized apply-patch input is not retained by the real presentation tracker", () => {
  const tracker = new ToolPresentationTracker();
  const oversizedInput = [
    "*** Begin Patch",
    "*** Add File: oversized.txt",
    `+${"p".repeat(300_000)}`,
    "*** End Patch",
  ].join("\n");

  const result = tracker.start({
    toolCallId: "oversized-patch",
    toolName: "apply_patch",
    args: { input: oversizedInput },
    cwd: "/work/project",
  });

  assert.deepEqual(result.presentation, { title: "apply_patch" });
  assert.equal(JSON.stringify(result).includes("p".repeat(1_000)), false);
});

test("oversized rawInput from a scripted Pi child over real stdio is bounded and carries truncation metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "choco-pi-phase5-raw-input-"));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  const client = new FakeAgentSideConnection();
  let proc: PiRpcProcess | undefined;

  try {
    proc = await bounded(
      PiRpcProcess.spawn({
        cwd: root,
        piCommand: executable(
          root,
          `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type !== "prompt") return;
  send({ type: "response", id: request.id, command: "prompt", success: true, data: {} });
  send({ type: "tool_execution_start", toolCallId: "oversized-raw-input", toolName: "apply_patch", args: { input: "p".repeat(300_000) } });
  send({ type: "agent_settled" });
});
`,
        ),
      }),
      "spawn raw-input Pi",
    );
    const session = new PiAcpSession({
      sessionId: `phase5-raw-input-${randomUUID()}`,
      cwd: root,
      mcpServers: [],
      proc,
      conn: asAgentConn(client),
    });

    assert.equal(
      await bounded(session.prompt("emit raw input"), "complete raw-input turn"),
      "end_turn",
    );
    const update = client.updates.find(
      (entry) =>
        entry.update.sessionUpdate === "tool_call" &&
        entry.update.toolCallId === "oversized-raw-input",
    )?.update;
    assert.ok(update?.sessionUpdate === "tool_call");
    const rawInput = parseJsonLine(JSON.stringify(update.rawInput));
    assert.ok(isBoundaryRecord(rawInput));
    const preview = rawInput.preview;
    assert.ok(isString(preview));
    assert.equal(preview.length, 10_000);
    assert.match(preview, /…\[truncated\]$/);
    assert.ok(isBoundaryRecord(update._meta));
    const piAcp = update._meta.piAcp;
    assert.ok(isBoundaryRecord(piAcp));
    assert.deepEqual(piAcp.rawInputTruncation, {
      truncated: true,
      originalCharacters: 300_012,
      limitCharacters: 10_000,
    });
    assert.equal(JSON.stringify(update).includes("p".repeat(20_000)), false);
  } finally {
    await proc?.shutdown(50);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent loadSession calls share one resumed scripted Pi child and replay persisted history", async () => {
  const root = mkdtempSync(join(tmpdir(), "choco-pi-phase5-resume-"));
  const cwd = join(root, "project");
  const sessionsDir = join(root, "sessions", "fixture");
  const sessionFile = join(sessionsDir, "resume.jsonl");
  const recordsPath = join(root, "records.jsonl");
  const sessionId = `phase5-${randomUUID()}`;
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-02-11T00:00:00.000Z",
      cwd,
    })}\n`,
  );

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousHome = process.env.HOME;
  const previousRecords = process.env.PHASE5_RECORDS;
  const previousSessionId = process.env.PHASE5_SESSION_ID;
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.HOME = root;
  process.env.PHASE5_RECORDS = recordsPath;
  process.env.PHASE5_SESSION_ID = sessionId;
  const client = new FakeAgentSideConnection();
  const agent = new PiAcpAgent(asAgentConn(client), {
    piCommand: executable(root, rpcResponder),
  });

  try {
    await bounded(
      Promise.all([
        agent.loadSession({ sessionId, cwd, mcpServers: [] }),
        agent.loadSession({ sessionId, cwd, mcpServers: [] }),
      ]),
      "load one session concurrently",
    );

    const records = readFileSync(recordsPath, "utf8")
      .trim()
      .split("\n")
      .map(parseJsonLine)
      .filter(isBoundaryRecord);
    assert.equal(records.filter((record) => record.type === "spawn").length, 1);
    const spawn = spawnRecord(records);
    assert.ok(spawn);
    assert.ok(isBoundaryArray(spawn.argv));
    assert.deepEqual(spawn.argv, ["--mode", "rpc", "--no-themes", "--session", sessionFile]);

    const replayed = client.updates.map((entry) => entry.update);
    assert.ok(
      replayed.some(
        (update) =>
          update.sessionUpdate === "user_message_chunk" &&
          update.content.type === "text" &&
          update.content.text === "Persisted question",
      ),
    );
    assert.ok(
      replayed.some(
        (update) =>
          update.sessionUpdate === "agent_message_chunk" &&
          update.content.type === "text" &&
          update.content.text === "Persisted answer",
      ),
    );
  } finally {
    await bounded(agent.shutdown(100), "shutdown resumed session");
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousRecords === undefined) delete process.env.PHASE5_RECORDS;
    else process.env.PHASE5_RECORDS = previousRecords;
    if (previousSessionId === undefined) delete process.env.PHASE5_SESSION_ID;
    else process.env.PHASE5_SESSION_ID = previousSessionId;
    rmSync(root, { recursive: true, force: true });
  }
});
