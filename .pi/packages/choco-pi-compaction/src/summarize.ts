import {
  type AssistantMessage,
  type ModelsSimpleStreamOptions,
  retryAssistantCall,
  type RetryPolicy,
  type Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Pi thinking levels from least to most reasoning, "off" excluded. */
const THINKING_LEVELS_ASCENDING = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

type ActiveThinkingLevel = (typeof THINKING_LEVELS_ASCENDING)[number];

/** Thinking level as the host hands it to extensions, including "off". */
export type SessionThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

/**
 * The thinking level a summary call sends: the lowest level the model
 * supports, never above the session's own level.
 *
 * A summary is a structured transcription, not a reasoning task, and on
 * endpoints where reasoning shares the output cap every reasoning token is
 * taken from the summary. A model's `thinkingLevelMap` marks unsupported
 * levels with `null` (GLM-5.3 supports only "high" and "max"); undefined
 * keys use the provider default and count as supported. "off" stays "off",
 * and a non-reasoning model gets no level at all.
 */
export function summaryThinkingLevel(
  model: Pick<SummaryCallRequest["model"], "reasoning" | "thinkingLevelMap">,
  sessionLevel: SessionThinkingLevel | undefined,
): ActiveThinkingLevel | undefined {
  if (!model.reasoning || sessionLevel === undefined || sessionLevel === "off") return undefined;
  const sessionIndex = THINKING_LEVELS_ASCENDING.indexOf(sessionLevel);
  const ceiling = sessionIndex >= 0 ? sessionIndex : THINKING_LEVELS_ASCENDING.length - 1;
  for (let index = 0; index <= ceiling; index++) {
    const level = THINKING_LEVELS_ASCENDING[index];
    if (level !== undefined && model.thinkingLevelMap?.[level] !== null) return level;
  }
  return sessionLevel;
}

/** Raised when a summarization call ended because the caller aborted it. */
export class CompactionAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactionAbortedError";
  }
}

/**
 * Raised when a summarization call stopped at its output cap (`stopReason`
 * "length"): the summary is incomplete, which on a reasoning model usually
 * means reasoning consumed the cap. Callers map it to "summary-truncated".
 */
export class SummaryTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummaryTruncatedError";
  }
}

/** One summarization request against the session's active model. */
export interface SummaryCallRequest {
  readonly modelRegistry: ExtensionContext["modelRegistry"];
  readonly model: NonNullable<ExtensionContext["model"]>;
  readonly systemPrompt: string;
  readonly promptText: string;
  readonly maxTokens: number;
  readonly signal: AbortSignal;
  readonly thinkingLevel: SessionThinkingLevel | undefined;
  /**
   * Retry policy for transient provider failures, or undefined for a single
   * attempt. Aborts and deterministic errors never retry.
   */
  readonly retry: RetryPolicy | undefined;
  /** Prefix for failure messages, e.g. "Summarization". */
  readonly label: string;
}

export interface SummaryCallResult {
  readonly text: string;
  readonly usage: Usage;
}

/**
 * Issue one summarization call and reject anything unsafe to persist.
 *
 * A truncated, empty, errored, or tool-calling response must never become a
 * session checkpoint: the checkpoint replaces the conversation, so a bad
 * summary destroys context instead of condensing it.
 *
 * A transient stream drop is not such a response: it carries no summary at
 * all. The call is therefore wrapped in the host's own `retryAssistantCall`
 * with the session's retry policy, exactly as the host's default compaction
 * does, so a dropped stream does not cancel an overflow-triggered compaction.
 * Aborts are terminal there, deterministic errors return immediately, and the
 * classification below runs on whatever the retry loop finally returns.
 */
export async function runSummaryCall(request: SummaryCallRequest): Promise<SummaryCallResult> {
  const options: ModelsSimpleStreamOptions = {
    signal: request.signal,
    maxTokens: request.maxTokens,
    cacheRetention: "none",
  };
  const reasoning = summaryThinkingLevel(request.model, request.thinkingLevel);
  if (reasoning !== undefined) options.reasoning = reasoning;

  const produce = async (): Promise<AssistantMessage> =>
    await request.modelRegistry
      .streamSimple(
        request.model,
        {
          systemPrompt: request.systemPrompt,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: request.promptText }],
              timestamp: Date.now(),
            },
          ],
        },
        options,
      )
      .result();
  const response = await retryAssistantCall(produce, request.retry, request.signal);

  if (request.signal.aborted || response.stopReason === "aborted") {
    throw new CompactionAbortedError(`${request.label} aborted`);
  }
  if (response.stopReason === "error") {
    throw new Error(`${request.label} failed: ${response.errorMessage || "Unknown error"}`);
  }
  if (response.stopReason === "length") {
    throw new SummaryTruncatedError(
      `${request.label} failed: generation hit the token cap and the summary is incomplete`,
    );
  }
  let text = "";
  for (const block of response.content) {
    if (block.type === "toolCall") {
      throw new Error(`${request.label} attempted to call a tool`);
    }
    if (block.type === "text") {
      text += block.text;
    }
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error(`${request.label} failed: the model returned an empty summary`);
  }
  return { text: trimmed, usage: response.usage };
}
