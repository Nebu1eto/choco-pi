import {
  convertToLlm,
  estimateTokens,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";

import type { CompactionMessage } from "./types.ts";

/**
 * Render messages exactly the way the host renders them for summarization.
 *
 * Reusing the host serializer keeps the `[Tool result]` framing and its
 * 2000-character truncation identical to the default path, so a summary
 * produced here reads the same as one produced by pi itself.
 */
export function serializeMessages(messages: readonly CompactionMessage[]): string {
  return serializeConversation(convertToLlm([...messages]));
}

/** Estimate prompt tokens with the host's own chars/4 heuristic. */
export function estimateTextTokens(text: string): number {
  return estimateTokens({ role: "user", content: text, timestamp: 0 });
}
