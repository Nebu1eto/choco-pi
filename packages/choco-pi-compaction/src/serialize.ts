import {
  convertToLlm,
  estimateTokens,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";

import type { CompactionMessage } from "./types.ts";

export function serializeMessages(messages: readonly CompactionMessage[]): string {
  return serializeConversation(convertToLlm([...messages]));
}

export function estimateTextTokens(text: string): number {
  return estimateTokens({ role: "user", content: text, timestamp: 0 });
}
