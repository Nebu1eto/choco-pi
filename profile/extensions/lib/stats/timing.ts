import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readCallUsage, totalTokens } from "./records.ts";
import { TIMING_ENTRY_TYPE } from "./scan.ts";

/**
 * Time to first token, recorded per assistant message.
 *
 * Pi persists each response's request start (`message.timestamp`) and total
 * `durationMs`, but not when the first token arrived. This recorder watches
 * the stream, notes the first content event, and writes one custom entry
 * ahead of the assistant message; the Statistics scanner joins the two by
 * provider, model, and request start. Custom entries never reach the model.
 */

/** The stream events that carry the first visible token of a response. */
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

/**
 * Registers the recorder. Returns the number of entries written so far, for
 * tests. `now` must share the clock of `message.timestamp` (Date.now).
 */
export function registerStatsTiming(pi: TimingApi, now: () => number = Date.now): () => number {
  /** Request start → first content event, for responses still streaming. */
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

  // An aborted run never ends its message; drop whatever is still pending when the run ends.
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
      model: message.responseModel ?? message.model,
      ttftMs: Math.max(0, first.firstAt - message.timestamp),
      firstEvent: first.firstEvent,
    };
    pi.appendEntry(TIMING_ENTRY_TYPE, entry);
    written += 1;
  });

  return () => written;
}
