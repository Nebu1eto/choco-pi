import { randomUUID } from "node:crypto";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai";
import { isThinkingPart, retainThoughtSignature } from "@earendil-works/pi-ai/api/google-shared";
import type { StreamPart, StreamResponse, StreamUsageMetadata } from "./chunks.ts";

const LENGTH_REASONS: ReadonlySet<string> = new Set(["MAX_TOKENS", "CONTINUATION"]);

/**
 * google FinishReason to Pi StopReason, the table pi-ai's mapStopReason uses. pi-ai's function
 * takes the @google/genai enum (not a dependency of this package) and throws on values it does
 * not know; an unknown reason here is an error stop instead.
 */
export function stopReasonFor(finishReason: string): StopReason {
  if (finishReason === "STOP") return "stop";
  if (LENGTH_REASONS.has(finishReason)) return "length";
  return "error";
}

type OpenBlock = TextContent | ThinkingContent;

function signatureOf(block: OpenBlock): string | undefined {
  return block.type === "text" ? block.textSignature : block.thinkingSignature;
}

function generatedToolCallId(name: string): string {
  const prefix = name.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 40) || "call";
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/**
 * Folds streamed GenerateContentResponse chunks into one Pi assistant message and its events.
 * Consecutive text (or thought) parts extend one block; a part that brings a second, different
 * thought signature starts a new block so no signature is ever overwritten. Signature-only
 * empty parts are kept, because Gemini requires them echoed back on replay.
 */
export class ResponseAccumulator {
  readonly #output: AssistantMessage;
  readonly #stream: AssistantMessageEventStream;
  readonly #model: Model<"google-generative-ai">;
  #open: OpenBlock | undefined;
  #started = false;

  constructor(
    output: AssistantMessage,
    stream: AssistantMessageEventStream,
    model: Model<"google-generative-ai">,
  ) {
    this.#output = output;
    this.#stream = stream;
    this.#model = model;
  }

  /** Whether any content block has been emitted (after which a transport retry is unsafe). */
  get emittedContent(): boolean {
    return this.#output.content.length > 0;
  }

  /** Pushes the start event once. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#stream.push({ type: "start", partial: this.#output });
  }

  apply(response: StreamResponse): void {
    this.start();
    const output = this.#output;
    if (!output.responseId && response.responseId) output.responseId = response.responseId;
    if (!output.responseModel && response.modelVersion) {
      output.responseModel = response.modelVersion;
    }
    const candidate = response.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) this.#part(part);
    if (candidate?.finishReason) {
      output.rawStopReason = candidate.finishReason;
      output.stopReason = stopReasonFor(candidate.finishReason);
    }
    if (output.stopReason === "stop" && output.content.some((b) => b.type === "toolCall")) {
      output.stopReason = "toolUse";
    }
    if (response.usageMetadata) this.#usage(response.usageMetadata);
  }

  /** Closes the open block. Call once the stream ends or fails. */
  close(): void {
    const block = this.#open;
    if (!block) return;
    this.#open = undefined;
    const contentIndex = this.#output.content.length - 1;
    if (block.type === "text") {
      this.#stream.push({
        type: "text_end",
        contentIndex,
        content: block.text,
        partial: this.#output,
      });
    } else {
      this.#stream.push({
        type: "thinking_end",
        contentIndex,
        content: block.thinking,
        partial: this.#output,
      });
    }
  }

  #part(part: StreamPart): void {
    if (part.text !== undefined) this.#textPart(part, part.text);
    if (part.functionCall) this.#toolCall(part, part.functionCall);
  }

  #textPart(part: StreamPart, text: string): void {
    const thinking = isThinkingPart(part);
    const incoming = part.thoughtSignature || undefined;
    let block = this.#open;
    const existing = block ? signatureOf(block) : undefined;
    const sameKind = block !== undefined && (block.type === "thinking") === thinking;
    if (!block || !sameKind || (incoming && existing && incoming !== existing)) {
      this.close();
      block = thinking ? { type: "thinking", thinking: "" } : { type: "text", text: "" };
      this.#output.content.push(block);
      this.#open = block;
      this.#stream.push({
        type: thinking ? "thinking_start" : "text_start",
        contentIndex: this.#output.content.length - 1,
        partial: this.#output,
      });
    }
    const contentIndex = this.#output.content.length - 1;
    if (block.type === "thinking") {
      block.thinking += text;
      const signature = retainThoughtSignature(block.thinkingSignature, incoming);
      if (signature !== undefined) block.thinkingSignature = signature;
      if (text !== "") {
        this.#stream.push({
          type: "thinking_delta",
          contentIndex,
          delta: text,
          partial: this.#output,
        });
      }
    } else {
      block.text += text;
      const signature = retainThoughtSignature(block.textSignature, incoming);
      if (signature !== undefined) block.textSignature = signature;
      if (text !== "") {
        this.#stream.push({ type: "text_delta", contentIndex, delta: text, partial: this.#output });
      }
    }
  }

  #toolCall(part: StreamPart, call: NonNullable<StreamPart["functionCall"]>): void {
    this.close();
    const provided = call.id;
    const duplicate =
      provided !== undefined &&
      this.#output.content.some((block) => block.type === "toolCall" && block.id === provided);
    const toolCall: ToolCall = {
      type: "toolCall",
      id: provided && !duplicate ? provided : generatedToolCallId(call.name),
      name: call.name,
      arguments: call.args ?? {},
    };
    if (part.thoughtSignature) toolCall.thoughtSignature = part.thoughtSignature;
    this.#output.content.push(toolCall);
    const contentIndex = this.#output.content.length - 1;
    this.#stream.push({ type: "toolcall_start", contentIndex, partial: this.#output });
    this.#stream.push({
      type: "toolcall_delta",
      contentIndex,
      delta: JSON.stringify(toolCall.arguments),
      partial: this.#output,
    });
    this.#stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: this.#output });
  }

  #usage(metadata: StreamUsageMetadata): void {
    const prompt = metadata.promptTokenCount ?? 0;
    const cached = metadata.cachedContentTokenCount ?? 0;
    const thoughts = metadata.thoughtsTokenCount ?? 0;
    const candidates = metadata.candidatesTokenCount ?? 0;
    const usage = {
      input: Math.max(0, prompt - cached),
      output: candidates + thoughts,
      cacheRead: cached,
      cacheWrite: 0,
      reasoning: thoughts,
      totalTokens: metadata.totalTokenCount ?? prompt + candidates + thoughts,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    calculateCost(this.#model, usage);
    this.#output.usage = usage;
  }
}
