import {
  type AssistantMessage,
  type ModelsSimpleStreamOptions,
  retryAssistantCall,
  type RetryPolicy,
  type Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const THINKING_LEVELS_ASCENDING = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

type ActiveThinkingLevel = (typeof THINKING_LEVELS_ASCENDING)[number];

export type SessionThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

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

export class CompactionAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactionAbortedError";
  }
}

export class SummaryTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummaryTruncatedError";
  }
}

export interface SummaryCallRequest {
  readonly modelRegistry: ExtensionContext["modelRegistry"];
  readonly model: NonNullable<ExtensionContext["model"]>;
  readonly systemPrompt: string;
  readonly promptText: string;
  readonly maxTokens: number;
  readonly signal: AbortSignal;
  readonly thinkingLevel: SessionThinkingLevel | undefined;
  readonly retry: RetryPolicy | undefined;
  readonly label: string;
}

export interface SummaryCallResult {
  readonly text: string;
  readonly usage: Usage;
}

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
