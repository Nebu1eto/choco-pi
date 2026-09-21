import type { ModelsSimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Thinking level as the host hands it to extensions, including "off". */
export type SessionThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

/** Raised when a summarization call ended because the caller aborted it. */
export class CompactionAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactionAbortedError";
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
 * summary destroys context instead of condensing it. There is no client-side
 * retry here; the host reports the failure and the user can compact again.
 */
export async function runSummaryCall(request: SummaryCallRequest): Promise<SummaryCallResult> {
  const options: ModelsSimpleStreamOptions = {
    signal: request.signal,
    maxTokens: request.maxTokens,
    cacheRetention: "none",
  };
  if (request.model.reasoning && request.thinkingLevel && request.thinkingLevel !== "off") {
    options.reasoning = request.thinkingLevel;
  }

  const response = await request.modelRegistry
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

  if (request.signal.aborted || response.stopReason === "aborted") {
    throw new CompactionAbortedError(`${request.label} aborted`);
  }
  if (response.stopReason === "error") {
    throw new Error(`${request.label} failed: ${response.errorMessage || "Unknown error"}`);
  }
  if (response.stopReason === "length") {
    throw new Error(
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
