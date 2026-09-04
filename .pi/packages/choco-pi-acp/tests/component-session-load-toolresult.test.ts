import test from "node:test";
import assert from "node:assert/strict";

import { PiAcpAgent, type SessionStoreLike } from "../src/acp/agent.ts";
import type { SessionStoreEntry, StoredSession } from "../src/acp/session-store.ts";
import { FakeAgentSideConnection, asAgentConn } from "./helpers-fakes.ts";
import { PiRpcProcess, type PiRpcProcessLike } from "../src/pi-rpc/process.ts";
import type { PiMessages } from "../src/pi-rpc/protocol.ts";

type SpawnParameters = Parameters<typeof PiRpcProcess.spawn>[0];

interface ProcessSpawner {
  spawn(params: SpawnParameters): Promise<PiRpcProcessLike>;
}

class FakeStore implements SessionStoreLike {
  get(_sessionId: string): StoredSession {
    return {
      sessionId: "s1",
      cwd: "/tmp/project",
      sessionFile: "/tmp/s.jsonl",
      updatedAt: new Date().toISOString(),
    };
  }
  upsert(_entry: SessionStoreEntry): void {}
  delete(_sessionId: string): void {}
}

test("PiAcpAgent: loadSession replays toolResult as tool_call + tool_call_update", async () => {
  const spawner: ProcessSpawner = PiRpcProcess;
  const originalSpawn = spawner.spawn;
  spawner.spawn = async () => {
    const fakeProcess: PiRpcProcessLike = {
      onEvent: () => () => {},
      prompt: async () => {},
      getMessages: async (): Promise<PiMessages> => ({
        messages: [
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "bash",
            args: { command: "echo hello" },
            content: [{ type: "text", text: "hello from bash" }],
            isError: false,
          },
        ],
      }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: "medium" }),
    };
    return fakeProcess;
  };

  try {
    const conn = new FakeAgentSideConnection();
    const agent = new PiAcpAgent(asAgentConn(conn));
    // The injected fake implements the complete store contract used by PiAcpAgent.
    Object.assign(agent, { store: new FakeStore() } satisfies { store: SessionStoreLike });

    await agent.loadSession({ sessionId: "s1", cwd: "/tmp/project", mcpServers: [] });

    const updates = conn.updates.map((notification) => notification.update);

    const toolCall = updates.find((update) => update.sessionUpdate === "tool_call");
    assert.ok(toolCall);
    assert.equal(toolCall.toolCallId, "call_1");
    assert.equal(toolCall.title, "echo hello");
    assert.equal(toolCall.kind, "execute");
    assert.deepEqual(toolCall.content, [{ type: "terminal", terminalId: "call_1" }]);
    assert.deepEqual(toolCall._meta, {
      terminal_info: { terminal_id: "call_1", cwd: "/tmp/project" },
    });
    assert.equal(toolCall.rawOutput, undefined);

    const toolCallUpdate = updates.find((update) => update.sessionUpdate === "tool_call_update");
    assert.ok(toolCallUpdate);
    assert.equal(toolCallUpdate.toolCallId, "call_1");
    assert.equal(toolCallUpdate.status, "completed");
    assert.deepEqual(toolCallUpdate._meta, {
      terminal_output: { terminal_id: "call_1", data: "hello from bash" },
      terminal_exit: { terminal_id: "call_1", exit_code: 0, signal: null },
    });
    assert.equal(toolCallUpdate.rawOutput, undefined);
  } finally {
    spawner.spawn = originalSpawn;
  }
});
