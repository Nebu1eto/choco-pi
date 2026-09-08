import assert from "node:assert/strict";
import test from "node:test";
import { createNativeHost } from "./native-host-support.ts";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const live = process.env.CHOCO_PI_NATIVE_LIVE === "1";

test(
  "thinking-phase steering after a previous turn consumes a native successor",
  { skip: !live },
  async () => {
    const host = await createNativeHost({});
    let steer: Promise<void> | undefined;
    try {
      await host.session.prompt("Say only SEED_READY.");
      host.session.subscribe((event) => {
        if (
          event.type === "message_update" &&
          !steer &&
          event.assistantMessageEvent.type === "thinking_start"
        ) {
          steer = host.session.prompt("Skip the counting problem. Say exactly THINKING_STEER_OK.", {
            streamingBehavior: "steer",
          });
          void steer.catch(() => {});
        }
      });
      await host.session.prompt(
        "Without tools, determine how many permutations of 1 through 12 have every adjacent pair sum to a prime. Think carefully through the counting before answering. Do not output preliminary commentary.",
      );
      assert.ok(steer, "The test must submit during thinking, not substitute a text-phase steer");
      await steer;
      assert.equal(host.observations.automatic, 1, "Native successor was not consumed");
      assert.equal(host.observations.steeringPhases.includes("failed"), false);
      assert.equal(host.session.messages.filter((message) => message.role === "user").length, 3);
      const last = host.session.messages.at(-1);
      assert.ok(last?.role === "assistant" && last.stopReason === "stop");
      assert.ok(
        last.content.some(
          (part) => part.type === "text" && part.text.includes("THINKING_STEER_OK"),
        ),
      );
      console.log(
        JSON.stringify({
          scenario: "thinking-after-previous-turn",
          model: host.session.model?.id,
          ...host.observations,
        }),
      );
    } finally {
      await host.dispose();
    }
  },
);

for (const scenario of ["native", "off", "sse", "fallback"] as const) {
  test(`steering UI correlates real Astra delivery: ${scenario}`, { skip: !live }, async () => {
    const frames: string[][] = [];
    // SAFETY: The production native input hook uses only setWidget in this SDK UI fixture.
    // Interactive rendering is exercised separately by native-steering-tui.ts.
    const uiContext = {
      setWidget(_key: string, lines: string[] | undefined) {
        if (lines) frames.push([...lines]);
      },
    } as ExtensionUIContext;
    const host = await createNativeHost({
      enabled: scenario !== "off",
      transport: scenario === "sse" ? "sse" : "websocket-cached",
      transformSteer: scenario === "fallback",
      uiContext,
    });
    let steer: Promise<void> | undefined;
    host.session.subscribe((event) => {
      if (
        event.type === "message_update" &&
        !steer &&
        (event.assistantMessageEvent.type === "text_delta" ||
          event.assistantMessageEvent.type === "thinking_delta")
      ) {
        steer = host.session.prompt("Change direction. Say exactly STEERING_UI_OK.", {
          streamingBehavior: "steer",
        });
        void steer.catch(() => {});
      }
    });
    try {
      assert.equal(host.session.model?.id, "gpt-6-astra");
      assert.equal(host.session.model?.provider, "openai-codex");
      await host.session.prompt("Explain five approaches to sorting a list with examples.");
      await steer;
      const rendered = frames.flat().join("\n");
      assert.match(rendered, /Steer #1 · Queued/);
      if (scenario === "native") {
        assert.match(rendered, /Mid-turn sent/);
        assert.match(rendered, /Mid-turn accepted/);
        assert.match(frames.at(-1)![0]!, /Mid-turn applied/);
        assert.equal(host.observations.automatic, 1);
      } else if (scenario === "fallback") {
        assert.match(rendered, /Mid-turn accepted/);
        assert.match(frames.at(-1)![0]!, /Queue fallback/);
        assert.doesNotMatch(rendered, /Mid-turn applied/);
      } else {
        assert.doesNotMatch(rendered, /Mid-turn|Queue fallback/);
        assert.equal(host.observations.steeringPhases.includes("sent"), false);
      }
      assert.equal(host.session.messages.filter((message) => message.role === "user").length, 2);
      const last = host.session.messages.at(-1);
      assert.ok(last?.role === "assistant" && last.stopReason === "stop");
      assert.ok(
        last.content.some((part) => part.type === "text" && part.text.includes("STEERING_UI_OK")),
      );
      console.log(
        JSON.stringify({ scenario, model: host.session.model?.id, frames, ...host.observations }),
      );
    } finally {
      await host.dispose();
    }
  });
}

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
