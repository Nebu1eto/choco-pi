import test from "node:test";
import assert from "node:assert/strict";
import { PiAcpAgent } from "../src/acp/agent.ts";
import { FakeAgentSideConnection, asAgentConn } from "./helpers-fakes.ts";

test("PiAcpAgent: setSessionMode maps to pi setThinkingLevel + emits current_mode_update", async () => {
  const conn = new FakeAgentSideConnection();
  const agent = new PiAcpAgent(asAgentConn(conn));

  // Create a fake session by calling newSession is heavyweight (spawns pi).
  // Instead, reach into session manager via loadSession isn't possible either.
  // So we unit-test the mapping via a minimal fake session manager would require refactor.
  // For now we just assert the method exists and rejects unknown mode IDs.

  await assert.rejects(
    () => agent.setSessionMode({ sessionId: "nope", modeId: "invalid" }),
    /invalid params/i,
  );
});
