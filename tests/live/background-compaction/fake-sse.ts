import type { Api, AssistantMessage, JsonObject, Model } from "@earendil-works/pi-ai";

/** Deterministic Anthropic SSE fixtures served by the scoped fake transport only. */
export const FAKE_MODEL: Model<"anthropic-messages"> = {
  id: "harness-fake",
  name: "Harness offline",
  api: "anthropic-messages",
  provider: "harness-offline",
  baseUrl: "https://harness.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 1000,
};
/**
 * Mirrors the installed catalog entry `anthropic/claude-opus-5-5` (managed effort:
 * adaptive thinking with `thinking.block_binding`), so strict binding is exercised
 * by the installed adapter. Cost is zeroed; transport is the scoped fake only.
 */
export const FAKE_ANTHROPIC_MODEL: Model<"anthropic-messages"> = {
  id: "claude-opus-5-5",
  name: "Claude Opus 5.5 (offline mirror)",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000000,
  maxTokens: 128000,
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  },
  compat: {
    supportsMidConvoEffort: true,
    supportsMidConvoSystemMessages: true,
    supportsMidConvoToolChanges: true,
    forceAdaptiveThinking: true,
    supportsTemperature: false,
    supportsStrictTools: true,
  },
};
/** OAuth-shaped synthetic key; never a real credential. */
export const FAKE_ANTHROPIC_KEY = "sk-ant-oat-harness-offline-placeholder";
export const FAKE_OFFLINE_KEY = "harness-not-a-secret";
/** The deterministic harness tool every launched session declares. */
export const STEP_TOOL = "harness_step";
/** Emitted only by the offline fake summarizer, so it marks the checkpoint message. */
export const FAKE_CHECKPOINT_MARKER = "HARNESS-TEXT-CHECKPOINT";
const TEXT_SUMMARY = `## Goal\n${FAKE_CHECKPOINT_MARKER}\n## Constraints & Preferences\n- Offline fixture\n## Progress\n### Done\n- Frozen prefix recorded\n### In Progress\n- None\n### Blocked\n- None\n## Key Decisions\n- Deterministic response\n## Next Steps\nNone; awaiting a new request\n## Critical Context\n- Prefix-only checkpoint`;

/** Tool results never contain their call label, so marker mapping stays unambiguous. */
export function stepResultText(label: string): string {
  return label.replace(/^HARNESS-/u, "HARNESS-RESULT-");
}

/** A summary whose checkpoint marker is unique to the summary request index. */
export function fakeSummary(index: number): string {
  return TEXT_SUMMARY.replace(FAKE_CHECKPOINT_MARKER, `${FAKE_CHECKPOINT_MARKER}-${index}`);
}

export function assistantMessage(text: string, model: Model<Api> = FAKE_MODEL): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    stopReason: "stop",
    usage: {
      input: 10,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 11,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

/** One server-sent event frame of the Anthropic Messages stream. */
export type SseFrame = JsonObject & { readonly type: string };

/** Wire encoding at the fake HTTP boundary. */
export function sseResponse(frames: readonly SseFrame[]): Response {
  const text = frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
  return new Response(text.join(""), { headers: { "content-type": "text/event-stream" } });
}

export function errorResponse(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export interface FakeTurn {
  readonly index: number;
  /** Foreground requests below this index answer with one step tool call. */
  readonly toolCycles: number;
  readonly childId?: string;
  readonly summaryText?: string;
  /** Signed thinking emitted before the text block (thinking-enabled sessions). */
  readonly thinking?: { readonly text: string; readonly signature: string };
  readonly modelId: string;
  /** `usage.input_tokens` the response reports (default 10). */
  readonly inputTokens?: number;
}

function stepLabel(turn: FakeTurn): string {
  if (turn.childId !== undefined) return `HARNESS-CHILD-${turn.childId}-STEP-${turn.index}`;
  return `HARNESS-STEP-${turn.index}`;
}

function doneText(turn: FakeTurn): string {
  if (turn.summaryText !== undefined) return turn.summaryText;
  if (turn.childId !== undefined) return `HARNESS-CHILD-${turn.childId}-DONE-${turn.index}`;
  return `HARNESS-DONE-${turn.index}`;
}

function thinkingFrames(turn: FakeTurn): SseFrame[] {
  if (!turn.thinking) return [];
  return [
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: turn.thinking.text },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: turn.thinking.signature },
    },
    { type: "content_block_stop", index: 0 },
  ];
}

function toolFrames(index: number, label: string): SseFrame[] {
  return [
    {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: `call-${label}`, name: STEP_TOOL, input: {} },
    },
    {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify({ label }) },
    },
    { type: "content_block_stop", index },
  ];
}

export function fakeResponse(turn: FakeTurn): Response {
  const tool = turn.summaryText === undefined && turn.index < turn.toolCycles;
  const label = stepLabel(turn);
  const first = turn.thinking ? 1 : 0;
  return sseResponse([
    {
      type: "message_start",
      message: {
        id: `harness-response-${turn.index}`,
        type: "message",
        role: "assistant",
        model: turn.modelId,
        content: [],
        stop_reason: null,
        usage: { input_tokens: turn.inputTokens ?? 10, output_tokens: 0 },
      },
    },
    ...thinkingFrames(turn),
    {
      type: "content_block_start",
      index: first,
      content_block: { type: "text", text: tool ? label : doneText(turn) },
    },
    { type: "content_block_stop", index: first },
    ...(tool ? toolFrames(first + 1, label) : []),
    {
      type: "message_delta",
      delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);
}
