import { STEP_TOOL } from "../fake-sse.ts";
import type { Host } from "./types.ts";

/**
 * Live prompts keep the scenario marker as their first line and add plain
 * instructions the fake server never needed. The requested final token is given
 * in lowercase so the model's uppercase reply is never a substring of the
 * prompt (entry mapping is case-sensitive substring search).
 */
export function stepsPrompt(host: Host, marker: string, steps: number, ack: string): string {
  if (host.mode === "fake") return marker;
  const labels = Array.from({ length: steps }, (_, index) => `HARNESS-STEP-${index + 1}`).join(
    ", ",
  );
  return [
    marker,
    `Call the ${STEP_TOOL} tool exactly ${steps} times, strictly one call per response, waiting for each result before the next call.`,
    `Use these labels in order: ${labels}.`,
    "Do not write any text alongside the tool calls.",
    `After the last tool result, reply with only the uppercase form of this token: ${ack.toLowerCase()}`,
  ].join("\n");
}

export function replyPrompt(host: Host, marker: string, ack: string): string {
  if (host.mode === "fake") return marker;
  return [
    marker,
    "Do not call any tool.",
    `Reply with only the uppercase form of this token: ${ack.toLowerCase()}`,
  ].join("\n");
}
