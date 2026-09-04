import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionManagerLike } from "../src/acp/agent.ts";
import { SessionManager } from "../src/acp/session.ts";
import type { PiRpcEvent } from "../src/pi-rpc/protocol.ts";
import { createFakeAcpToPiHarness, createRealPiRpcHarness } from "./component-rpc-harness.ts";

test("component harness: ACP adapter initializes fake Pi RPC and shuts it down once", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "choco-pi-acp cwd "));
  const harness = createFakeAcpToPiHarness(cwd);
  const previousMarker = process.env.PI_ACP_HARNESS_MARKER;
  process.env.PI_ACP_HARNESS_MARKER = "preserved";

  try {
    const initialized = await harness.agent.initialize({ protocolVersion: 1 });
    assert.equal(initialized.agentCapabilities?.promptCapabilities?.embeddedContext, false);

    const session = await harness.agent.newSession({ cwd, mcpServers: [] });
    assert.equal(session.sessionId, "fake-session");
    await harness.agent.shutdown(500);
    await harness.agent.shutdown(500);

    const records = harness.readRecords();
    const spawn = records.find((record) => record.type === "spawn");
    assert.equal(realpathSync(String(spawn?.cwd)), realpathSync(cwd));
    assert.deepEqual(spawn?.argv, ["--mode", "rpc", "--no-themes"]);
    assert.equal(spawn?.marker, "preserved");

    const commands = records
      .filter((record) => record.type === "request")
      .map((record) => record.command);
    assert.ok(commands.includes("get_state"));
    assert.ok(commands.includes("get_available_models"));
    assert.ok(commands.includes("get_commands"));
    assert.equal(
      records.filter((record) => record.type === "signal" && record.signal === "SIGTERM").length,
      1,
    );
  } finally {
    if (previousMarker === undefined) delete process.env.PI_ACP_HARNESS_MARKER;
    else process.env.PI_ACP_HARNESS_MARKER = previousMarker;
  }
});

test("component harness: real-Pi variant is lazy and uses the same adapter boundary", () => {
  const harness = createRealPiRpcHarness(process.cwd());
  assert.equal(harness.cwd, process.cwd());
  harness.agent.dispose();
});

test(
  "component harness: real Pi discovers and executes Phase 2 commands",
  { skip: process.env.PI_ACP_REAL_PI !== "1" },
  async () => {
    const harness = createRealPiRpcHarness(process.cwd());
    const sessions = new SessionManager();
    // The real manager is injected before session creation so the test can observe its Pi events.
    Object.assign(harness.agent, { sessions } satisfies { sessions: SessionManagerLike });
    try {
      const created = await harness.agent.newSession({ cwd: harness.cwd, mcpServers: [] });
      await new Promise((resolve) => setTimeout(resolve, 250));

      const commandUpdate = harness.client.updates.findLast(
        (entry) => entry.update.sessionUpdate === "available_commands_update",
      );
      const commandNames = new Set(
        commandUpdate?.update.sessionUpdate === "available_commands_update"
          ? commandUpdate.update.availableCommands.map((command) => command.name)
          : [],
      );
      for (const name of [
        "status",
        "context",
        "goal",
        "sessions",
        "hooks",
        "check",
        "skill:check",
      ]) {
        assert.equal(commandNames.has(name), true, `missing real Pi command: ${name}`);
      }

      for (const name of ["status", "context", "goal", "sessions", "hooks"]) {
        assert.deepEqual(
          await harness.agent.prompt({
            sessionId: created.sessionId,
            prompt: [{ type: "text", text: `/${name}` }],
          }),
          { stopReason: "end_turn" },
        );
      }

      const reviewSession = sessions.maybeGet(created.sessionId);
      assert.ok(reviewSession, "missing real Pi session for /review event observation");
      assert.ok(reviewSession.proc.getMessages, "real Pi process must support message replay");
      const modelContextEventTypes = new Set([
        "agent_start",
        "turn_start",
        "message_start",
        "message_update",
        "message_end",
        "turn_end",
        "agent_end",
      ]);
      const modelContextEvents: PiRpcEvent[] = [];
      const reviewNotifications: string[] = [];
      const stopObservingReview = reviewSession.proc.onEvent((event) => {
        if (event.type === "extension_ui_request" && event.method === "notify") {
          reviewNotifications.push(event.message ?? "");
        }
        if (modelContextEventTypes.has(event.type)) modelContextEvents.push(event);
      });
      const reviewUpdateIndex = harness.client.updates.length;
      const messagesBeforeReview = await reviewSession.proc.getMessages();

      try {
        assert.deepEqual(
          await harness.agent.prompt({
            sessionId: created.sessionId,
            prompt: [{ type: "text", text: "/review branch main HEAD" }],
          }),
          { stopReason: "end_turn" },
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
      } finally {
        stopObservingReview();
      }

      const reviewText = harness.client.updates
        .slice(reviewUpdateIndex)
        .flatMap((entry) =>
          entry.update.sessionUpdate === "agent_message_chunk" &&
          entry.update.content.type === "text"
            ? [entry.update.content.text]
            : [],
        )
        .join("\n");
      assert.ok(
        reviewNotifications.some((message) => message.includes("Review:")),
        "/review must emit a headless Review: notification",
      );
      assert.match(reviewText, /Review:/);
      assert.deepEqual(modelContextEvents, [], "/review must not start a model-context turn");
      assert.deepEqual(
        await reviewSession.proc.getMessages(),
        messagesBeforeReview,
        "/review must not add messages to Pi model context",
      );

      for (const name of ["check", "skill:check"]) {
        assert.deepEqual(
          await harness.agent.prompt({
            sessionId: created.sessionId,
            prompt: [{ type: "text", text: `/${name}` }],
          }),
          { stopReason: "end_turn" },
        );
      }
    } finally {
      await harness.agent.shutdown(1_000);
    }
  },
);
