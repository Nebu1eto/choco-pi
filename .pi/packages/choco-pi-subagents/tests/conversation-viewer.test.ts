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
  type AgentSessionEventListener,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import type { AgentInvocation, AgentRecord, SubagentType } from "../src/types.ts";
import { formatAgentMessage } from "../src/messaging.ts";
import { ConversationViewer } from "../src/ui/conversation-viewer.ts";

initTheme("dark", false);

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
  const listeners: Array<() => void> = [];
  const session = partialFixture<AgentSession>({
    // SAFETY: each fixture builds pi-ai UserMessage / AssistantMessage /
    // ToolResultMessage values, all members of the session message union.
    messages: messages as AgentSession["messages"],
    subscribe: (listener: AgentSessionEventListener) => {
      listeners.push(() => listener({ type: "agent_settled" }));
      return () => {};
    },
    getToolDefinition: () => undefined,
    sessionManager: partialFixture<AgentSession["sessionManager"]>({
      getCwd: () => "/project",
    }),
  });
  return { session, fire: () => listeners.forEach((listener) => listener()) };
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

test("a running agent streams: deltas reach frames within the throttle window", async () => {
  const messages: unknown[] = [
    makeUserMessage("Work on it."),
    makeAssistantMessage([{ type: "text", text: "Starting" }]),
  ];
  const { session, fire } = makeSession(messages);
  const { viewer, rendered } = makeViewer(session, makeRecord(session, "running"));
  assert.ok(rendered().includes("Starting"));

  // Streaming mutates the tail message in place, as pi-ai delivers deltas,
  // and every mutation arrives with a session event. Within the throttle
  // window a frame may keep the previous lines...
  // SAFETY: messages[1] is the assistant fixture created just above, with
  // exactly one text part.
  const tail = messages[1] as AssistantMessage;
  // SAFETY: see the narrowed tail above.
  (tail.content[0] as { text: string }).text = "Starting... now halfway through";
  fire();
  const withinWindow = rendered();
  assert.ok(withinWindow.includes("Starting"), "throttled frame still renders the tail");
  assert.ok(!withinWindow.includes("halfway through"), "throttled frame reuses tail lines");

  // ...and the next budget tick repaints it.
  await new Promise((resolve) => setTimeout(resolve, 150));
  fire();
  const updated = rendered();
  assert.ok(updated.includes("halfway through"), "next budget tick re-renders the tail");

  messages.push(makeAssistantMessage([{ type: "text", text: "Done." }]));
  fire();
  const grown = rendered();
  assert.ok(grown.includes("Done."), "newly appended messages render immediately");
  viewer.dispose();
});

test("settling flushes the throttled tail into its final render immediately", () => {
  const messages: unknown[] = [
    makeUserMessage("Work on it."),
    makeAssistantMessage([{ type: "text", text: "Half" }]),
  ];
  const { session, fire } = makeSession(messages);
  const record = makeRecord(session, "running");
  const { viewer, rendered } = makeViewer(session, record);
  assert.ok(rendered().includes("Half"));

  // The final delta lands together with the status flip, inside the throttle
  // window: the settle must bypass the window, not wait 100ms.
  // SAFETY: messages[1] is the assistant fixture created just above, with
  // exactly one text part.
  const tail = messages[1] as AssistantMessage;
  // SAFETY: see the narrowed tail above.
  (tail.content[0] as { text: string }).text = "Half — the full answer.";
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
