import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { InitializeRequest } from "@agentclientprotocol/sdk";
import { PiAcpAgent } from "../src/acp/agent.ts";
import { FakeAgentSideConnection, asAgentConn } from "./helpers-fakes.ts";

beforeEach(() => {
  delete process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT;
});

afterEach(() => {
  delete process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT;
});

async function initializeWithEmbeddedContext(value?: string) {
  if (value != null) process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT = value;

  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
  const request: InitializeRequest = { protocolVersion: 1, clientCapabilities: {} };
  const res = await agent.initialize(request);

  assert.ok(res.agentCapabilities);
  assert.ok(res.agentCapabilities.promptCapabilities);
  return res.agentCapabilities.promptCapabilities.embeddedContext;
}

test("PI_ACP_ENABLE_EMBEDDED_CONTEXT: defaults embeddedContext to false when undefined", async () => {
  assert.equal(await initializeWithEmbeddedContext(), false);
});

test("PI_ACP_ENABLE_EMBEDDED_CONTEXT: 'false' keeps embeddedContext disabled", async () => {
  assert.equal(await initializeWithEmbeddedContext("false"), false);
});

test("PI_ACP_ENABLE_EMBEDDED_CONTEXT: advertises tested embedded context only when true", async () => {
  assert.equal(await initializeWithEmbeddedContext("true"), true);
  assert.equal(await initializeWithEmbeddedContext("TRUE"), false);
});
