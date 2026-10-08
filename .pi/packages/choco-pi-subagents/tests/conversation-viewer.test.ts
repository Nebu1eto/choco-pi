/**
 * conversation-viewer.test.ts — The viewer renders the subagent transcript
 * through the same transcript components as the main Pi agent
 * (UserMessageComponent / AssistantMessageComponent / ToolExecutionComponent /
 * BashExecutionComponent), giving the overlay — and any zentui install that
 * restyles those components — the main agent's look and feel.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type {
  AgentInvocation,
  AgentRecord,
  NotificationDetails,
  SubagentType,
} from "../src/types.ts";
import { formatAgentMessage } from "../src/messaging.ts";
import { ConversationViewer } from "../src/ui/conversation-viewer.ts";
import { renderSubagentNotification } from "../src/ui/notification-render.ts";
import { createSdkFixture } from "./sdk-fixture.ts";

initTheme("dark", false);

for (const status of ["completed", "running"] as const) {
  test(`focused reasoning clicks toggle a cached second message (${status})`, () => {
    const { session } = makeSession([
      makeUserMessage(Array.from({ length: 60 }, (_, i) => `Earlier row ${i}`).join("\n")),
      makeAssistantMessage([
        { type: "thinking", thinking: "Visible private reasoning" },
        { type: "text", text: "Public answer" },
      ]),
    ]);
    let requests = 0;
    const tui = makeTui();
    tui.requestRender = () => {
      requests++;
    };
    const viewer = new ConversationViewer(
      tui,
      session,
      makeRecord(session, status),
      undefined,
      theme,
      () => {},
      undefined,
      undefined,
      undefined,
      { profile: "focus" },
    );
    const render = () => viewer.render(100).map(stripTerminalSequences);
    try {
      let lines = render();
      assert.deepEqual(render(), lines, "exercise whole-transcript cache");
      const y = lines.findIndex((line) => line.includes("Visible private reasoning"));
      assert.ok(y > 40, "reasoning is beyond the terminal viewport");
      const click: TuiMouseEvent = {
        type: "click",
        button: "left",
        x: 3,
        y,
        screenX: 3,
        screenY: 5,
        width: 100,
        height: lines.length,
        shift: false,
        alt: false,
        ctrl: false,
      };
      assert.equal(viewer.handleMouse({ ...click, button: "right" }), undefined);
      assert.equal(requests, 0);
      assert.equal(viewer.handleMouse(click)?.handled, true);
      assert.equal(requests, 1);
      lines = render();
      assert.ok(!lines.some((line) => line.includes("Visible private reasoning")));
      const hiddenY = lines.findIndex((line) => line.includes("Thinking..."));
      assert.ok(hiddenY >= 0);
      assert.equal(
        viewer.handleMouse({ ...click, y: hiddenY, height: lines.length })?.handled,
        true,
      );
      assert.ok(render().some((line) => line.includes("Visible private reasoning")));
      assert.equal(requests, 2);
    } finally {
      viewer.dispose();
    }
  });
}

function partialFixture<T extends object>(fixture: Partial<T>): T {
  // SAFETY: Each test supplies the named slice exercised by its subject.
  return fixture as T;
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function makeTui(): TUI {
  return partialFixture<TUI>({
    terminal: partialFixture<TUI["terminal"]>({ rows: 40 }),
    requestRender() {},
  });
}

function makeSession(messages: unknown[]) {
  const listeners: AgentSessionEventListener[] = [];
  const session = partialFixture<AgentSession>({
    // SAFETY: each fixture builds pi-ai UserMessage / AssistantMessage /
    // ToolResultMessage values, all members of the session message union.
    messages: messages as AgentSession["messages"],
    subscribe: (listener: AgentSessionEventListener) => {
      listeners.push(listener);
      return () => {};
    },
    getToolDefinition: () => undefined,
    sessionManager: partialFixture<AgentSession["sessionManager"]>({
      getCwd: () => "/project",
    }),
  });
  return {
    session,
    fire: (event: AgentSessionEvent = { type: "agent_settled" }) =>
      listeners.forEach((listener) => listener(event)),
  };
}

function makeRecord(
  session: AgentSession,
  status: AgentRecord["status"] = "completed",
): AgentRecord {
  return partialFixture<AgentRecord>({
    id: "agent-1",
    // SAFETY: general is a registered default agent type.
    type: "general" as SubagentType,
    description: "test agent",
    status,
    toolUses: 1,
    startedAt: Date.now() - 1000,
    completedAt: status === "running" ? undefined : Date.now(),
    session,
  });
}

function makeUserMessage(content: string): UserMessage {
  return { role: "user", content, timestamp: Date.now() };
}

function makeAssistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "main-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function makeToolResult(toolCallId: string, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  };
}

function makeViewer(session: AgentSession, record?: AgentRecord) {
  const viewer = new ConversationViewer(
    makeTui(),
    session,
    record ?? makeRecord(session),
    undefined,
    theme,
    () => {},
  );
  return {
    viewer,
    rendered: () =>
      viewer
        .render(120)
        .map((line) => stripTerminalSequences(line))
        .join("\n"),
  };
}

test("append-mode roles omit prompt-mode labels while keeping invocation tags", () => {
  const { session } = makeSession([]);
  const record = makeRecord(session);
  // SAFETY: general-purpose is a registered default agent type with prompt mode append.
  record.type = "general-purpose" as SubagentType;
  record.invocation = partialFixture<AgentInvocation>({
    modelName: "gpt-5.6 terra",
    thinking: "medium",
    runInBackground: true,
  });

  const { rendered } = makeViewer(session, record);
  const output = rendered();
  assert.doesNotMatch(output, /\(twin\)/);
  assert.match(output, /gpt-5\.6 terra · thinking: medium · background/);
});

test("user and assistant messages render as styled transcript, not raw labels", () => {
  const { session } = makeSession([
    makeUserMessage("Explain **why** the build failed."),
    makeAssistantMessage([{ type: "text", text: "It failed because tsc errored." }]),
  ]);
  const { viewer, rendered } = makeViewer(session);
  const text = rendered();
  assert.ok(!text.includes("[User]"), "no [User] label remains");
  assert.ok(!text.includes("[Assistant]"), "no [Assistant] label remains");
  assert.ok(!text.includes("**why**"), "markdown asterisks are consumed by rendering");
  assert.ok(text.includes("why"), "user text survives");
  assert.ok(text.includes("the build failed"), "user text survives");
  assert.ok(text.includes("tsc"), "assistant text survives");
  viewer.dispose();
});

test("agent-message envelopes render with a sender header and no raw markup", () => {
  const { session } = makeSession([
    makeUserMessage(formatAgentMessage("planner", "Check the second branch.", "TASK")),
  ]);
  const { viewer, rendered } = makeViewer(session);
  const text = rendered();
  assert.match(text, /✉ planner \[TASK\]/);
  assert.match(text, /Check the second branch\./);
  assert.doesNotMatch(text, /<agent-message/);
  viewer.dispose();
});

test("assistant text renders as markdown: headings lose their # markers", () => {
  const { session } = makeSession([
    makeAssistantMessage([{ type: "text", text: "## Findings\n\nThe answer is **42**." }]),
  ]);
  const { viewer, rendered } = makeViewer(session);
  const text = rendered();
  assert.ok(text.includes("Findings"), "heading text survives");
  assert.ok(!text.includes("## Findings"), "heading markers are consumed by the renderer");
  assert.ok(!text.includes("**42**"), "emphasis markers are consumed by the renderer");
  viewer.dispose();
});

test("tool calls and their results render through ToolExecutionComponent", () => {
  const { session } = makeSession([
    makeUserMessage("Read workflow.ts"),
    makeAssistantMessage(
      [
        { type: "text", text: "Reading the file." },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "workflow.ts" } },
      ],
      "toolUse",
    ),
    makeToolResult("call-1", "export function runWorkflow() {}"),
    makeAssistantMessage([{ type: "text", text: "The workflow exports runWorkflow." }]),
  ]);
  const { viewer, rendered } = makeViewer(session);
  const text = rendered();
  assert.ok(text.includes("read"), "tool call name is visible");
  assert.ok(text.includes("runWorkflow"), "tool result renders inline with its call");
  assert.ok(!text.includes("[Result]"), "results no longer get a plain [Result] block");
  viewer.dispose();
});

test("bash executions render as transcript bash blocks", () => {
  const { session } = makeSession([
    {
      role: "bashExecution",
      command: "git status --short",
      output: " M src/app.ts",
      exitCode: 0,
      cancelled: false,
      truncated: false,
    },
  ]);
  const { viewer, rendered } = makeViewer(session);
  const text = rendered();
  assert.ok(text.includes("git status --short"), "command is visible");
  assert.ok(text.includes("src/app.ts"), "output is visible");
  viewer.dispose();
});

test("opening mid-response includes the agent's uncommitted streaming snapshot", () => {
  const { session } = makeSession([]);
  const tail = makeAssistantMessage([{ type: "text", text: "Already streaming" }]);
  Object.defineProperty(session, "agent", { value: { state: { streamingMessage: tail } } });
  const { viewer, rendered } = makeViewer(session, makeRecord(session, "running"));
  assert.match(rendered(), /Already streaming/);
  assert.equal(session.messages.length, 0);
  viewer.dispose();
});

test("live assistant deltas render before commit and finalize exactly once", async () => {
  const messages = [makeUserMessage("Work on it.")];
  const { session, fire } = makeSession(messages);
  const { viewer, rendered } = makeViewer(session, makeRecord(session, "running"));
  const start = makeAssistantMessage([{ type: "text", text: "Starting" }]);
  fire({ type: "message_start", message: start });
  assert.match(rendered(), /Starting/);
  assert.equal(session.messages.length, 1, "live tail is not committed");

  const delta = makeAssistantMessage([{ type: "text", text: "Starting... now halfway through" }]);
  fire({
    type: "message_update",
    message: delta,
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "... now halfway through",
      partial: delta,
    },
  });
  assert.doesNotMatch(rendered(), /halfway through/, "frame budget reuses tail lines");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.match(rendered(), /halfway through/, "delta renders without committing it");

  const final = makeAssistantMessage([{ type: "text", text: "The final answer." }]);
  session.messages.push(final);
  fire({ type: "message_end", message: final });
  const committed = rendered();
  assert.doesNotMatch(committed, /halfway through/);
  assert.equal(committed.split("The final answer.").length - 1, 1);
  viewer.dispose();
});

test("tool partial output is routed by call ID before the committed result", () => {
  const assistant = makeAssistantMessage(
    [
      { type: "toolCall", id: "call-live", name: "stream_output", arguments: { path: "live.ts" } },
      {
        type: "toolCall",
        id: "call-other",
        name: "stream_output",
        arguments: { path: "other.ts" },
      },
    ],
    "toolUse",
  );
  const { session, fire } = makeSession([]);
  const { viewer, rendered } = makeViewer(session, makeRecord(session, "running"));
  fire({ type: "message_start", message: makeAssistantMessage([]) });
  rendered();
  fire({
    type: "message_update",
    message: assistant,
    assistantMessageEvent: {
      type: "toolcall_delta",
      contentIndex: 0,
      delta: "{}",
      partial: assistant,
    },
  });
  assert.match(rendered(), /live.ts/, "tool calls appear as the assistant streams");
  session.messages.push(assistant);
  fire({ type: "message_end", message: assistant });
  fire({
    type: "tool_execution_update",
    toolCallId: "call-live",
    toolName: "read",
    args: {},
    partialResult: { content: [{ type: "text", text: "Partial live output" }] },
  });
  const partial = rendered();
  assert.equal(partial.split("Partial live output").length - 1, 1);
  assert.ok(partial.indexOf("Partial live output") < partial.indexOf("other.ts"));
  assert.equal(session.messages.length, 1);
  session.messages.push(makeToolResult("call-live", "Final live output"));
  fire();
  assert.match(rendered(), /Final live output/);
  assert.doesNotMatch(rendered(), /Partial live output/);
  viewer.dispose();
});

test("closed viewers ignore assistant and tool events", () => {
  const { session, fire } = makeSession([]);
  let requests = 0;
  const tui = makeTui();
  tui.requestRender = () => {
    requests++;
  };
  const viewer = new ConversationViewer(
    tui,
    session,
    makeRecord(session, "running"),
    undefined,
    theme,
    () => {},
  );
  viewer.handleInput("q");
  fire({
    type: "message_start",
    message: makeAssistantMessage([{ type: "text", text: "Ignored tail" }]),
  });
  fire({
    type: "tool_execution_update",
    toolCallId: "ignored",
    toolName: "read",
    args: {},
    partialResult: { content: [{ type: "text", text: "Ignored partial" }] },
  });
  assert.equal(requests, 0);
  assert.doesNotMatch(viewer.render(120).join("\n"), /Ignored/);
  viewer.dispose();
});

test("settling flushes the throttled tail into its final render immediately", () => {
  const messages: unknown[] = [makeUserMessage("Work on it.")];
  const tail = makeAssistantMessage([{ type: "text", text: "Half" }]);
  const { session, fire } = makeSession(messages);
  const record = makeRecord(session, "running");
  const { viewer, rendered } = makeViewer(session, record);
  fire({ type: "message_start", message: tail });
  assert.ok(rendered().includes("Half"));

  // The final delta lands together with the status flip, inside the throttle
  // window: the settle must bypass the window, not wait 100ms.
  tail.content = [{ type: "text", text: "Half — the full answer." }];
  messages.push(tail);
  fire({ type: "message_end", message: tail });
  record.status = "completed";
  record.completedAt = Date.now();
  fire();
  const settled = rendered();
  assert.ok(settled.includes("the full answer"), "settle render is fresh immediately");
  viewer.dispose();
});

test("a settled transcript catches tool results that landed before viewing", () => {
  const { session } = makeSession([
    makeAssistantMessage(
      [{ type: "toolCall", id: "call-9", name: "grep", arguments: { pattern: "needle" } }],
      "toolUse",
    ),
    makeToolResult("call-9", "needle found at line 3"),
  ]);
  const { viewer, rendered } = makeViewer(session);
  assert.ok(rendered().includes("needle found at line 3"), "result visible on first open");
  viewer.dispose();
});

test("focus profile renders the frameless main-transcript look", () => {
  const session_msgs: unknown[] = [
    makeUserMessage("Focused question"),
    makeAssistantMessage([{ type: "text", text: "Focused **answer** with detail." }]),
  ];
  const { session } = makeSession(session_msgs);
  const viewer = new ConversationViewer(
    makeTui(),
    session,
    makeRecord(session),
    undefined,
    theme,
    () => {},
    undefined,
    undefined,
    undefined,
    { profile: "focus" },
  );
  const lines = viewer.render(120).map((line) => stripTerminalSequences(line));
  const text = lines.join("\n");
  assert.ok(text.includes("Focused question"), "user message renders");
  assert.ok(text.includes("Focused answer with detail."), "assistant message renders");
  assert.ok(
    !text.includes("╭") && !text.includes("╰") && !text.includes("│"),
    "no overlay box borders in focus",
  );
  assert.ok(!text.includes("Esc close"), "no overlay footer hints in focus");
  assert.ok(!text.includes("lines ·"), "no scroll readout in focus");
  viewer.dispose();
});

test("focused pending messages render only their first terminal line", () => {
  const { session } = makeSession([]);
  Object.assign(session, {
    getSteeringMessages: () => ["steer first\nsteer hidden"],
    getFollowUpMessages: () => ["follow first\nfollow hidden"],
  });
  const viewer = new ConversationViewer(
    makeTui(),
    session,
    makeRecord(session, "running"),
    undefined,
    theme,
    () => {},
    undefined,
    undefined,
    undefined,
    { profile: "focus" },
  );

  assert.deepEqual(viewer.renderPendingMessages(120).map(stripTerminalSequences), [
    "",
    " Steering: steer first",
    " Follow-up: follow first",
  ]);
  viewer.dispose();
});

test("viewer expansion applies to existing and newly arriving tool and bash rows", () => {
  const longOutput = (prefix: string) =>
    Array.from(
      { length: 30 },
      (_, index) => `${prefix}-${String(index + 1).padStart(2, "0")}`,
    ).join("\n");
  const messages: unknown[] = [
    makeAssistantMessage(
      [{ type: "toolCall", id: "initial-tool", name: "read", arguments: { path: "file.ts" } }],
      "toolUse",
    ),
    makeToolResult("initial-tool", longOutput("initial-tool")),
    {
      role: "bashExecution",
      command: "initial bash",
      output: longOutput("initial-bash"),
      exitCode: 0,
      cancelled: false,
      truncated: false,
    },
  ];
  const { session, fire } = makeSession(messages);
  const viewer = new ConversationViewer(
    makeTui(),
    session,
    makeRecord(session),
    undefined,
    theme,
    () => {},
    undefined,
    undefined,
    undefined,
    { profile: "focus" },
  );
  const rendered = () =>
    viewer
      .render(120)
      .map((line) => stripTerminalSequences(line))
      .join("\n");

  assert.doesNotMatch(rendered(), /initial-tool-30/);
  assert.doesNotMatch(rendered(), /initial-bash-01/);

  viewer.setToolOutputExpanded(true);
  assert.equal(viewer.getToolOutputExpanded(), true);
  assert.match(rendered(), /initial-tool-30/);
  assert.match(rendered(), /initial-bash-01/);

  messages.push(
    makeAssistantMessage(
      [{ type: "toolCall", id: "new-tool", name: "read", arguments: { path: "new.ts" } }],
      "toolUse",
    ),
    makeToolResult("new-tool", longOutput("new-tool")),
    {
      role: "bashExecution",
      command: "new bash",
      output: longOutput("new-bash"),
      exitCode: 0,
      cancelled: false,
      truncated: false,
    },
  );
  fire();
  assert.match(rendered(), /new-tool-30/, "new tool inherits expanded state");
  assert.match(rendered(), /new-bash-01/, "new bash row inherits expanded state");

  viewer.toggleToolOutputExpanded();
  assert.equal(viewer.getToolOutputExpanded(), false);
  assert.doesNotMatch(rendered(), /new-tool-30/);
  assert.doesNotMatch(rendered(), /new-bash-01/);
  viewer.dispose();
});

function makeFocusedViewer(session: AgentSession) {
  return new ConversationViewer(
    makeTui(),
    session,
    makeRecord(session),
    undefined,
    theme,
    () => {},
    undefined,
    undefined,
    undefined,
    { profile: "focus" },
  );
}

function focusedText(viewer: ConversationViewer): string {
  return viewer.render(120).map(stripTerminalSequences).join("\n");
}

const completionDetails: NotificationDetails = {
  id: "descendant-1",
  description: "Descendant regression check",
  type: "general",
  status: "completed",
  toolUses: 1,
  turnCount: 1,
  totalTokens: 10,
  durationMs: 1000,
  resultPreview: "Descendant completed visibly.\nExpanded descendant detail.",
};

function sendCompletion(session: AgentSession, display: boolean): Promise<void> {
  return session.sendCustomMessage(
    {
      customType: "subagent-notification",
      content: "Descendant completed visibly.",
      display,
      details: completionDetails,
    },
    // Exercise descendant delivery without starting a provider-backed turn.
    { deliverAs: "steer", triggerTurn: false },
  );
}

for (const display of [true, false]) {
  test(`focused descendant completion honors display:${display} and the child renderer`, async () => {
    let renderCalls = 0;
    const { session } = await createSdkFixture(undefined, [
      (pi) => {
        pi.registerMessageRenderer<NotificationDetails>(
          "subagent-notification",
          (message, options, hostTheme) => {
            renderCalls++;
            if (!message.details) return undefined;
            return new Text(renderSubagentNotification(message.details, options, hostTheme), 0, 0);
          },
        );
      },
    ]);
    const viewer = makeFocusedViewer(session);
    try {
      focusedText(viewer);
      await sendCompletion(session, display);
      const output = focusedText(viewer);
      if (display) {
        assert.match(output, /Delegation: Completed/);
        assert.match(output, /Descendant completed visibly/);
        assert.doesNotMatch(output, /Expanded descendant detail/);
        viewer.toggleToolOutputExpanded();
        assert.match(focusedText(viewer), /Expanded descendant detail/);
        assert.ok(renderCalls > 0);
      } else {
        assert.doesNotMatch(output, /Descendant|Delegation/);
        assert.equal(renderCalls, 0);
      }
    } finally {
      viewer.dispose();
      session.dispose();
    }
  });
}

test("focused custom messages without a renderer retain the host text fallback", async () => {
  const { session } = await createSdkFixture();
  await sendCompletion(session, true);
  session.sessionManager.appendCustomMessageEntry(
    "historical-notice",
    [{ type: "text", text: "Historical notification text." }],
    true,
  );
  session.refreshContext();
  const viewer = makeFocusedViewer(session);
  try {
    const output = focusedText(viewer);
    assert.match(output, /\[subagent-notification\]/);
    assert.match(output, /Descendant completed visibly/);
    assert.match(output, /Historical notification text/);
  } finally {
    viewer.dispose();
    session.dispose();
  }
});

test("focused tool renderers resolve historical tools and override registered and built-in tools", async () => {
  const resolverNames: string[] = [];
  const { session } = await createSdkFixture(undefined, [
    (pi) => {
      pi.registerTool({
        name: "registered-render-test",
        label: "Registered renderer",
        description: "Renderer regression fixture.",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [{ type: "text", text: "Unused execution." }],
          details: undefined,
        }),
        renderCall: () => new Text("BASE REGISTERED CALL", 0, 0),
        renderResult: () => new Text("BASE REGISTERED RESULT", 0, 0),
      });
      pi.registerToolRenderer((name, next) => {
        resolverNames.push(name);
        if (name === "resolver-only" || name === "registered-render-test") {
          return {
            renderCall: () => new Text(`RESOLVED CALL ${name}`, 0, 0),
            renderResult: () => new Text(`RESOLVED RESULT ${name}`, 0, 0),
          };
        }
        if (name === "read") {
          const base = next();
          assert.ok(base?.renderCall, "built-in renderers are visible to next()");
          return { ...base, renderCall: () => new Text("RESOLVED BUILT-IN CALL", 0, 0) };
        }
        return next();
      });
    },
  ]);
  // The SDK fixture disables executable tools; expose its real registered definition as the base.
  session.getToolDefinition = (name) => session.extensionRunner.getToolDefinition(name);
  assert.ok(session.getToolDefinition("registered-render-test"));
  assert.equal(session.getToolDefinition("resolver-only"), undefined);
  const names = ["resolver-only", "registered-render-test", "unknown-historical", "read"];
  for (const name of names) {
    session.sessionManager.appendMessage(
      makeAssistantMessage(
        [{ type: "toolCall", id: name, name, arguments: { path: "historical.ts" } }],
        "toolUse",
      ),
    );
    session.sessionManager.appendMessage({
      ...makeToolResult(name, `RESULT ${name}`),
      toolName: name,
    });
  }
  session.refreshContext();
  const viewer = makeFocusedViewer(session);
  try {
    const output = focusedText(viewer);
    for (const name of ["resolver-only", "registered-render-test"]) {
      assert.match(output, new RegExp(`RESOLVED CALL ${name}`));
      assert.match(output, new RegExp(`RESOLVED RESULT ${name}`));
    }
    assert.doesNotMatch(output, /BASE REGISTERED/);
    assert.match(output, /unknown-historical/);
    assert.match(output, /RESULT unknown-historical/);
    assert.match(output, /RESOLVED BUILT-IN CALL/);
    viewer.setToolOutputExpanded(true);
    assert.match(focusedText(viewer), /RESULT read/);
    assert.deepEqual(resolverNames, names);
  } finally {
    viewer.dispose();
    session.dispose();
  }
});

test("settled tools keep their result render cache across live deltas", async () => {
  let resultRenders = 0;
  const fixture = await createSdkFixture(undefined, [
    (pi) => {
      pi.registerToolRenderer((name, next) =>
        name === "cached-tool"
          ? {
              renderCall: () => new Text("CACHED CALL", 0, 0),
              renderResult: () => {
                resultRenders++;
                return new Text("CACHED RESULT", 0, 0);
              },
            }
          : next(),
      );
    },
  ]);
  const assistant = makeAssistantMessage(
    [{ type: "toolCall", id: "cached-call", name: "cached-tool", arguments: {} }],
    "toolUse",
  );
  const { session, fire } = makeSession([
    assistant,
    { ...makeToolResult("cached-call", "done"), toolName: "cached-tool" },
  ]);
  Object.defineProperty(session, "extensionRunner", { value: fixture.session.extensionRunner });
  const { viewer, rendered } = makeViewer(session, makeRecord(session, "running"));
  try {
    assert.match(rendered(), /CACHED RESULT/);
    const settledRenders = resultRenders;
    assert.ok(settledRenders > 0);
    for (let i = 0; i < 3; i++) {
      const delta = makeAssistantMessage([{ type: "text", text: `Live delta ${i}` }]);
      fire({
        type: "message_update",
        message: delta,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: `${i}`,
          partial: delta,
        },
      });
      rendered();
      assert.equal(resultRenders, settledRenders, "historical tool is not re-rendered");
    }
  } finally {
    viewer.dispose();
    fixture.session.dispose();
  }
});

test("invalidate drops the caches and re-renders identically", () => {
  const { session } = makeSession([
    makeUserMessage("Hello **there**."),
    makeAssistantMessage([{ type: "text", text: "General **Kenobi**." }]),
  ]);
  const { viewer, rendered } = makeViewer(session);
  const before = rendered();
  viewer.invalidate();
  const after = rendered();
  assert.equal(after, before);
  viewer.dispose();
});
