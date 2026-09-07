import assert from "node:assert/strict";
import test from "node:test";
import { createPrototypeHost } from "../src/prototype/host.ts";
import { demoServer } from "./prototype-support.ts";

// Opt-in real Pi SDK host, deterministic transport; never part of the baseline suite.
for (const mode of ["steering", "async"] as const) {
  test(`public Pi extension host: ${mode}, no Pi tools or monkeypatches`, async () => {
    const server = demoServer(mode);
    let steer: Promise<void> | undefined;
    let trace: string[] = [];
    let executions = 0;
    const host = await createPrototypeHost({
      mode,
      connect: async () => server.transport,
      onCreated() {
        if (mode === "steering" && !steer) {
          steer = host.session.prompt("Change direction", { streamingBehavior: "steer" });
          void steer.catch(() => {});
        }
      },
      onFinished(turn) {
        trace = [...turn.trace];
      },
    });
    try {
      host.session.subscribe((event) => {
        if (event.type === "tool_execution_start") executions++;
      });
      await host.session.prompt("Synthetic test");
      await steer;
      const output = host.session.messages.at(-1);
      assert.equal(output?.role, "assistant");
      assert.equal(
        output?.role === "assistant" && output.stopReason,
        "stop",
        JSON.stringify(output),
      );
      assert.equal(executions, 0);
      assert.ok(
        trace.includes(
          mode === "steering" ? "steering_successor_completed" : "async_continuation_completed",
        ),
      );
      assert.equal(host.session.messages.filter((message) => message.role === "user").length, 1);
      if (mode === "steering") {
        assert.ok(
          host.session.sessionManager
            .getEntries()
            .some(
              (entry) => entry.type === "custom" && entry.customType === "codex-prototype-steer",
            ),
        );
      }
      await host.session.prompt("Unsupported second turn");
      const second = host.session.messages.at(-1);
      assert.equal(
        second?.role === "assistant" && second.errorMessage,
        "prototype_requires_fresh_single_turn_session",
      );
    } finally {
      await host.dispose();
    }
  });
}
