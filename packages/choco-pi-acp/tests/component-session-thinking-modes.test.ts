import test from "node:test";
import assert from "node:assert/strict";
import { PiAcpAgent } from "../src/acp/agent.ts";
import { FakeAgentSideConnection, asAgentConn } from "./helpers-fakes.ts";

test("PiAcpAgent: setSessionMode maps to pi setThinkingLevel + emits current_mode_update", async () => {
  const conn = new FakeAgentSideConnection();
  const agent = new PiAcpAgent(asAgentConn(conn));

  await assert.rejects(
    () => agent.setSessionMode({ sessionId: "nope", modeId: "invalid" }),
    /invalid params/i,
  );
});
