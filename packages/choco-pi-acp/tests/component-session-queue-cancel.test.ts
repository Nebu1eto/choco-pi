import test from "node:test";
import assert from "node:assert/strict";
import { PiAcpSession } from "../src/acp/session.ts";
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from "./helpers-fakes.ts";

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
  const third = session.prompt("three");

  assert.equal(proc.prompts.length, 1);

  await session.cancel();

  assert.equal(proc.abortCount, 1);

  assert.equal(await second, "cancelled");
  assert.equal(await third, "cancelled");

  proc.emit({ type: "agent_start" });
  proc.emit({ type: "turn_end" });
  proc.emit({ type: "agent_end" });
  proc.emit({ type: "agent_settled" });
  assert.equal(await first, "cancelled");

  assert.equal(proc.prompts.length, 1);
});
