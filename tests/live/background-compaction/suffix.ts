import { lit, obj, str } from "@earendil-works/pi-schema";
import { matches } from "./schema-check.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isArtifactRecord, type ArtifactInput } from "./artifacts.ts";
export interface ToolPair {
  kind: "call" | "result";
  id: string;
}
/** Actual serialized Anthropic tool blocks, in wire order (not deduplicated). */
export function wireToolPairs(payload: ArtifactInput): ToolPair[] {
  const pairs: ToolPair[] = [];
  const callSchema = obj({ type: lit("tool_use"), id: str() }, { open: true });
  const resultSchema = obj({ type: lit("tool_result"), tool_use_id: str() }, { open: true });
  function visit(item: ArtifactInput): void {
    if (matches(callSchema, item)) pairs.push({ kind: "call", id: item.id });
    else if (matches(resultSchema, item)) pairs.push({ kind: "result", id: item.tool_use_id });
    else if (Array.isArray(item)) for (const child of item) visit(child);
    else if (isArtifactRecord(item)) for (const child of Object.values(item)) visit(child);
  }
  visit(payload);
  return pairs;
}
function entryToolPairs(entry: SessionEntry): ToolPair[] {
  if (entry.type !== "message") return [];
  const message = entry.message;
  if (message.role === "toolResult") return [{ kind: "result", id: message.toolCallId }];
  if (message.role !== "assistant") return [];
  return message.content.flatMap((block): ToolPair[] =>
    block.type === "toolCall" ? [{ kind: "call", id: block.id }] : [],
  );
}
export function branchToolPairs(entries: readonly SessionEntry[]): ToolPair[] {
  return entries.flatMap(entryToolPairs);
}
