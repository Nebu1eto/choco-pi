import assert from "node:assert/strict";
import test from "node:test";
import { createNativeHost } from "./native-host-support.ts";

const live = process.env.CHOCO_PI_NATIVE_LIVE === "1";

test(
  "production Mid-turn Steering preserves normal Pi user history and subsequent turns",
  { skip: !live },
  async () => {
    const host = await createNativeHost({});
    let steer: Promise<void> | undefined;
    host.session.subscribe((event) => {
      if (
        event.type === "message_update" &&
        (event.assistantMessageEvent.type === "text_delta" ||
          event.assistantMessageEvent.type === "thinking_delta") &&
        !steer
      ) {
        steer = host.session.prompt("Change direction. Say exactly NATIVE_STEER_OK.", {
          streamingBehavior: "steer",
        });
        void steer.catch(() => {});
      }
    });
    try {
      await host.session.prompt("Explain five approaches to sorting a list with examples.");
      await steer;
      console.log(JSON.stringify({ scenario: "steering-observation", ...host.observations }));
      assert.equal(host.session.messages.filter((message) => message.role === "user").length, 2);
      assert.equal(host.observations.automatic, 1, "No automatic native successor consumed");
      const last = host.session.messages.at(-1);
      assert.ok(last?.role === "assistant" && last.stopReason === "stop");
      assert.ok(
        last.content.some((part) => part.type === "text" && part.text.includes("NATIVE_STEER_OK")),
      );
      await host.session.prompt("What exact marker did I ask you to say? Repeat only that marker.");
      const subsequent = host.session.messages.at(-1);
      assert.ok(subsequent?.role === "assistant" && subsequent.stopReason === "stop");
      assert.ok(
        subsequent.content.some(
          (part) => part.type === "text" && part.text.includes("NATIVE_STEER_OK"),
        ),
      );
      console.log(JSON.stringify({ scenario: "mid-turn-steering", ...host.observations }));
    } finally {
      await host.dispose();
    }
  },
);

test(
  "production native async exec yields a real Code Mode cell and preserves wait results",
  { skip: !live },
  async () => {
    const host = await createNativeHost({ codeMode: true });
    try {
      await host.session.prompt(
        "Call exec once with exactly: text(await tools.delay_marker({})); Do not add an @exec pragma. Once exec returns a running cell ID, say CODE_CELL_RUNNING before calling wait. Wait for that cell and report its exact marker, identified as synthetic. Do not finish without the actual result.",
      );
      const last = host.session.messages.at(-1);
      assert.ok(last?.role === "assistant" && last.stopReason === "stop");
      assert.ok(
        last.content.some((part) => part.type === "text" && part.text.includes(host.marker)),
      );
      assert.equal(host.observations.started, 1);
      assert.equal(host.observations.finished, 1);
      assert.equal(host.observations.asyncCalls, 1);
      assert.ok(host.observations.yielded >= 1);
      assert.equal(host.observations.textWhilePending, true);
      assert.ok(
        host.session.messages.some(
          (message) => message.role === "toolResult" && message.toolName === "wait",
        ),
      );
      console.log(JSON.stringify({ scenario: "async-code-mode", ...host.observations }));
    } finally {
      await host.dispose();
    }
  },
);

test("native async exec still obeys Pi tool_call blocking", { skip: !live }, async () => {
  const host = await createNativeHost({ codeMode: true, blockExec: true });
  try {
    await host.session.prompt(
      "Call exec with text(await tools.delay_marker({})); If it is blocked, report that and do not retry or use another tool.",
    );
    assert.equal(host.observations.blocked, 1);
    assert.equal(host.observations.started, 0);
    assert.equal(host.observations.asyncCalls, 1);
    assert.ok(
      host.session.messages.some((message) => message.role === "toolResult" && message.isError),
    );
    console.log(JSON.stringify({ scenario: "tool-preflight", ...host.observations }));
  } finally {
    await host.dispose();
  }
});

for (const scenario of ["off", "sse"] as const) {
  test(`native async Code Mode stays inactive with ${scenario}`, { skip: !live }, async () => {
    const host = await createNativeHost({
      codeMode: true,
      enabled: scenario !== "off",
      transport: scenario === "sse" ? "sse" : "websocket-cached",
      delayMs: 10,
    });
    try {
      await host.session.prompt(
        "Call exec once with text(await tools.delay_marker({})); Report the exact synthetic marker returned.",
      );
      assert.equal(host.observations.started, 1);
      assert.equal(host.observations.asyncCalls, 0);
      assert.equal(host.observations.yielded, 0);
      console.log(JSON.stringify({ scenario, ...host.observations }));
    } finally {
      await host.dispose();
    }
  });
}
