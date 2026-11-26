import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readCallUsage, recordedModelId, totalTokens } from "./records.ts";
import { TIMING_ENTRY_TYPE } from "./scan.ts";

const FIRST_TOKEN_EVENTS: ReadonlySet<string> = new Set([
  "text_start",
  "text_delta",
  "thinking_start",
  "thinking_delta",
  "toolcall_start",
  "toolcall_delta",
]);

export type TimingEntry = {
  v: 1;
  at: number;
  provider: string;
  model: string;
  ttftMs: number;
  firstEvent: string;
};

type TimingApi = Pick<ExtensionAPI, "on" | "appendEntry">;

export function registerStatsTiming(pi: TimingApi, now: () => number = Date.now): () => number {
  const pending = new Map<number, { firstAt: number; firstEvent: string } | undefined>();
  let written = 0;

  pi.on("message_start", (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    pending.set(message.timestamp, undefined);
  });

  pi.on("message_update", (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    const type = event.assistantMessageEvent.type;
    if (!FIRST_TOKEN_EVENTS.has(type)) return;
    if (!pending.has(message.timestamp) || pending.get(message.timestamp) !== undefined) return;
    pending.set(message.timestamp, { firstAt: now(), firstEvent: type });
  });

  pi.on("agent_end", () => {
    pending.clear();
  });

  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    const first = pending.get(message.timestamp);
    pending.delete(message.timestamp);
    if (first === undefined) return;
    const usage = readCallUsage(message.usage);
    if (usage === undefined || (totalTokens(usage.tokens) === 0 && usage.cost.total === 0)) return;
    const entry: TimingEntry = {
      v: 1,
      at: message.timestamp,
      provider: message.provider,
      model:
        recordedModelId(message.provider, message.model, message.responseModel) ?? message.model,
      ttftMs: Math.max(0, first.firstAt - message.timestamp),
      firstEvent: first.firstEvent,
    };
    pi.appendEntry(TIMING_ENTRY_TYPE, entry);
    written += 1;
  });

  return () => written;
}
