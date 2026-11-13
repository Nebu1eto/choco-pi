import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { readAgentsMdSettings } from "../src/settings.ts";
import { codeModeDiscoveryEvents } from "../src/tool-events.ts";

async function settingsFor(json: string): Promise<string[]> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "choco-pi-agents-md-schema-"));
  await writeFile(path.join(dir, "settings.json"), json);
  return (await readAgentsMdSettings(dir)).trustedRoots;
}

test("settings: accepts valid, tolerates unknown keys, rejects malformed and null", async () => {
  assert.deepEqual(await settingsFor(JSON.stringify({ agentsMd: { trustedRoots: ["/a"] } })), [
    "/a",
  ]);
  assert.deepEqual(
    await settingsFor(JSON.stringify({ other: 1, agentsMd: { trustedRoots: ["/a"], x: 1 } })),
    ["/a"],
  );
  assert.deepEqual(await settingsFor(JSON.stringify({})), []);
  assert.deepEqual(await settingsFor(JSON.stringify({ agentsMd: {} })), []);
  assert.deepEqual(await settingsFor(JSON.stringify({ agentsMd: null })), []);
  assert.deepEqual(
    await settingsFor(JSON.stringify({ agentsMd: { trustedRoots: ["/a", 1] } })),
    [],
  );
  assert.deepEqual(await settingsFor(JSON.stringify([])), []);
});

function resultEvent(
  details: ToolResultEvent["details"],
  input: ToolResultEvent["input"],
): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: "1",
    toolName: "exec",
    input,
    content: [{ type: "text", text: "x" }],
    isError: false,
    details,
  };
}

test("tool-events: keeps string inputs, drops non-strings, filters content shapes", () => {
  const event = resultEvent(
    {
      codeMode: true,
      traces: [
        {
          name: "exec_command",
          status: "done",
          input: { cmd: "ls", workdir: 5, cwd: null },
          result: {
            content: [
              { type: "text", text: "a", extra: 1 },
              { type: "text", text: null },
              { type: 1 },
              { type: "image" },
              null,
            ],
          },
        },
        { name: 3, status: "done", input: {}, result: { content: [] } },
        { name: "t", status: "pending", input: {}, result: { content: [] } },
      ],
    },
    { path: "/p", command: 1 },
  );
  const events = codeModeDiscoveryEvents(event);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0]?.input, { path: "/p" });
  assert.deepEqual(events[1]?.input, { cmd: "ls" });
  assert.deepEqual(events[1]?.content, [{ type: "text", text: "a", extra: 1 }, { type: "image" }]);
});
