import test from "node:test";
import assert from "node:assert/strict";
import { RequestError } from "@agentclientprotocol/sdk";
import { PiAcpAgent } from "../src/acp/agent.ts";
import { FakeAgentSideConnection, asAgentConn } from "./helpers-fakes.ts";

/** Run `call` and return the `RequestError` it must reject with. */
async function rejectionOf(call: () => Promise<void>): Promise<RequestError> {
  try {
    await call();
  } catch (error) {
    if (error instanceof RequestError) return error;
    throw error;
  }
  throw new Error("expected the call to reject with a RequestError");
}

test("PiAcpAgent: newSession returns a helpful Internal error when pi is not installed", async () => {
  const prevPiCmd = process.env.PI_ACP_PI_COMMAND;
  process.env.PI_ACP_PI_COMMAND = "pi-does-not-exist-12345";

  try {
    const conn = new FakeAgentSideConnection();
    const agent = new PiAcpAgent(asAgentConn(conn), {});

    const error = await rejectionOf(async () => {
      await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    });

    assert.equal(error.code, -32603);
    assert.ok(error.message.toLowerCase().includes("executable not found"));
  } finally {
    if (prevPiCmd == null) delete process.env.PI_ACP_PI_COMMAND;
    else process.env.PI_ACP_PI_COMMAND = prevPiCmd;
  }
});
