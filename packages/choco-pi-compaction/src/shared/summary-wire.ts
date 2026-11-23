/** The host's wire form of a compaction summary, shared by the native replay rewrites. */
import { convertToLlm } from "@earendil-works/pi-coding-agent";

/** Text the host sends for a compaction summary (public `convertToLlm`). */
export function summaryWireText(summary: string): string {
  const [message] = convertToLlm([
    { role: "compactionSummary", summary, tokensBefore: 0, timestamp: 0 },
  ]);
  const part =
    message?.role === "user" && Array.isArray(message.content) ? message.content[0] : undefined;
  if (part?.type !== "text") throw new Error("Unexpected host compaction summary message");
  return part.text;
}
