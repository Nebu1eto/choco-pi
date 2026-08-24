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
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import type { AgentRecord, SubagentType } from "../src/types.ts";
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

function makeSession(messages: unknown[]): AgentSession {
  return partialFixture<AgentSession>({
    messages: messages as AgentSession["messages"],
    subscribe: () => () => {},
    getToolDefinition: () => undefined,
    sessionManager: partialFixture<AgentSession["sessionManager"]>({
      getCwd: () => "/project",
    }),
  });
}

function makeRecord(session: AgentSession, status: AgentRecord["status"] = "completed"): AgentRecord {
  return partialFixture<AgentRecord>({
    id: "agent-1",
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

function makeViewer(
  session: AgentSession,
  record?: AgentRecord,
): { viewer: ConversationViewer; rendered: () => string } {
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
    rendered: () => viewer.render(120).map((line) => stripTerminalSequences(line)).join("\n"),
  };
}

test("user and assistant messages render as styled transcript, not raw labels", () => {
  const session = makeSession([
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

test("assistant text renders as markdown: headings lose their # markers", () => {
  const session = makeSession([
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
  const session = makeSession([
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
  const session = makeSession([
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

test("a running agent streams: mutated tail re-renders, new messages appear", () => {
  const messages: unknown[] = [
    makeUserMessage("Work on it."),
    makeAssistantMessage([{ type: "text", text: "Starting" }]),
  ];
  const session = makeSession(messages);
  const { viewer, rendered } = makeViewer(session, makeRecord(session, "running"));
  assert.ok(rendered().includes("Starting"));

  // Streaming mutates the tail message in place, as pi-ai delivers deltas.
  const tail = messages[1] as AssistantMessage;
  (tail.content[0] as { text: string }).text = "Starting... now halfway through";
  const updated = rendered();
  assert.ok(updated.includes("halfway through"), "mutated tail text reaches the next frame");

  messages.push(makeAssistantMessage([{ type: "text", text: "Done." }]));
  const grown = rendered();
  assert.ok(grown.includes("Done."), "newly appended messages render");
  viewer.dispose();
});

test("a settled transcript catches tool results that landed before viewing", () => {
  const session = makeSession([
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

test("invalidate drops the caches and re-renders identically", () => {
  const session = makeSession([
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
