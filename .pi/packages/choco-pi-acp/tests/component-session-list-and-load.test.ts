import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PiAcpAgent } from "../src/acp/agent.ts";
import { isBoundaryArray, isBoundaryRecord, isString, parseJsonLine } from "../src/boundary.ts";
import { FakeAgentSideConnection, asAgentConn } from "./helpers-fakes.ts";

function executable(root: string, recordsPath: string): string {
  const path = join(root, "fake-pi");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
fs.appendFileSync(${JSON.stringify(recordsPath)}, JSON.stringify({ type: "spawn", argv: process.argv.slice(2) }) + "\\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  let data = {};
  if (request.type === "get_messages") data = { messages: [
    { role: "user", content: "Hello" },
    { role: "assistant", content: [{ type: "text", text: "Hi there!" }] },
  ] };
  if (request.type === "get_available_models") data = { models: [] };
  if (request.type === "get_state") data = { thinkingLevel: "medium" };
  if (request.type === "get_commands") data = { commands: [] };
  send({ type: "response", id: request.id, command: request.type, success: true, data });
});
`,
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
  return path;
}

test("PiAcpAgent: listSessions lists pi sessions and loadSession replays history", async () => {
  // Create a fake PI_CODING_AGENT_DIR with one session.
  const root = mkdtempSync(join(tmpdir(), "pi-acp-test-"));
  const projectDir = join(root, "project");
  const sessionsDir = join(
    root,
    "sessions",
    `--${projectDir.replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-")}--`,
  );
  const sessionFile = join(sessionsDir, "0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl");
  const recordsPath = join(root, "records.jsonl");

  // Ensure parent dirs.
  mkdirSync(projectDir);
  mkdirSync(sessionsDir, { recursive: true });

  writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "sess-1",
        timestamp: "2026-02-11T00:00:00.000Z",
        cwd: projectDir,
      }),
      JSON.stringify({
        type: "message",
        id: "a1b2c3d4",
        parentId: null,
        timestamp: "2026-02-11T00:00:01.000Z",
        message: { role: "user", content: "Hello" },
      }),
      JSON.stringify({
        type: "message",
        id: "b2c3d4e5",
        parentId: "a1b2c3d4",
        timestamp: "2026-02-11T00:00:02.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Hi there!" }] },
      }),
      JSON.stringify({
        type: "session_info",
        id: "c3d4e5f6",
        parentId: "b2c3d4e5",
        timestamp: "2026-02-11T00:00:03.000Z",
        name: "My Named Session",
      }),
    ].join("\n") + "\n",
    { encoding: "utf8" },
  );

  const oldEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;

  try {
    const conn = new FakeAgentSideConnection();
    const agent = new PiAcpAgent(asAgentConn(conn), {
      piCommand: executable(root, recordsPath),
    });

    // 1) list sessions
    const listed = await agent.listSessions({
      cwd: projectDir,
      cursor: null,
      _meta: null,
    });
    assert.ok(listed.sessions.length >= 1);

    const s = listed.sessions.find((x) => x.sessionId === "sess-1");
    assert.ok(s);
    assert.equal(s?.cwd, projectDir);
    assert.equal(s?.title, "My Named Session");

    // 2) load session through a scripted Pi process with getMessages history.
    try {
      await agent.loadSession({
        sessionId: "sess-1",
        cwd: projectDir,
        mcpServers: [],
        _meta: null,
      });

      const records = readFileSync(recordsPath, "utf8")
        .trim()
        .split("\n")
        .map(parseJsonLine)
        .filter(isBoundaryRecord);
      const spawn = records.find((record) => record.type === "spawn");
      assert.ok(spawn);
      assert.ok(isBoundaryArray(spawn.argv));
      const resumedPath = spawn.argv.at(-1);
      assert.ok(isString(resumedPath));
      assert.ok(resumedPath.endsWith("/0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl"));

      // loadSession should have replayed messages as session/update notifications.
      const texts = conn.updates
        .map((notification) => notification.update)
        .flatMap((update) =>
          (update.sessionUpdate === "user_message_chunk" ||
            update.sessionUpdate === "agent_message_chunk") &&
          update.content.type === "text"
            ? [{ kind: update.sessionUpdate, text: update.content.text }]
            : [],
        );

      assert.ok(texts.some((t) => t.kind === "user_message_chunk" && t.text === "Hello"));
      assert.ok(texts.some((t) => t.kind === "agent_message_chunk" && t.text === "Hi there!"));
    } finally {
      await agent.shutdown(100);
    }
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldEnv;
  }
});
