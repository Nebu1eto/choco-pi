import type { BoundaryValue } from "../boundary.ts";
import { isNumberValue, isObjectValue, isStringValue } from "../boundary.ts";
import { DEFAULT_CODE_MODE_OUTPUT_TOKENS, MAX_CODE_MODE_OUTPUT_TOKENS } from "./host-protocol.ts";
import type {
  NotebookMemoryUsage,
  RuntimeContentItem,
  RuntimeResponse,
  RuntimeToolTrace,
} from "./types.ts";

interface CodeModeToolResultDetails {
  codeMode: true;
  cellId: string;
  status: RuntimeResponse["kind"];
  traces?: RuntimeToolTrace[] | undefined;
  droppedTraceCount?: number | undefined;
  notebookMemory?: NotebookMemoryUsage | undefined;
  scriptError?: string | undefined;
}

const MAX_OUTPUT_IMAGE_COUNT = 4;
const MAX_OUTPUT_IMAGE_CHARS = 16 * 1024 * 1024;

export function toCodeModeToolResult(response: RuntimeResponse, maxTokens?: number) {
  const scriptError = response.kind === "result" ? response.errorText : undefined;
  const status = scriptError
    ? `Script error: ${scriptError}`
    : response.kind === "yielded"
      ? `Still running (exec cell "${response.cellId}"). Use wait once near expected completion; avoid short polling`
      : response.kind === "terminated"
        ? "Script terminated"
        : "Script completed";
  let imageChars = 0;
  let imageCount = 0;
  let omittedImages = 0;
  const output = response.contentItems
    .map((item) => {
      const content = toPiContent(item);
      if (content?.type !== "image") return content;
      if (
        imageCount >= MAX_OUTPUT_IMAGE_COUNT ||
        imageChars + content.data.length > MAX_OUTPUT_IMAGE_CHARS
      ) {
        omittedImages += 1;
        return undefined;
      }
      imageCount += 1;
      imageChars += content.data.length;
      return content;
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  output.unshift(
    ...runningExecSessionGuidance(response.traces ?? []).map((text) => ({
      type: "text" as const,
      text,
    })),
  );
  if (response.notebookMemory) {
    output.unshift({ type: "text", text: formatNotebookMemory(response.notebookMemory) });
  }
  if (omittedImages > 0)
    output.push({
      type: "text",
      text: `[${omittedImages} code-mode image${omittedImages === 1 ? "" : "s"} omitted]`,
    });
  const outputTokens = Math.min(
    MAX_CODE_MODE_OUTPUT_TOKENS,
    Math.max(1, maxTokens ?? response.maxOutputTokens ?? DEFAULT_CODE_MODE_OUTPUT_TOKENS),
  );
  const details: CodeModeToolResultDetails = {
    codeMode: true,
    cellId: response.cellId,
    status: response.kind,
  };
  if (response.traces) details.traces = response.traces;
  if (response.droppedTraceCount) details.droppedTraceCount = response.droppedTraceCount;
  if (response.notebookMemory) details.notebookMemory = response.notebookMemory;
  if (scriptError) details.scriptError = scriptError;
  return {
    content: [
      { type: "text" as const, text: status },
      ...truncateTextContent(output, outputTokens * 4),
    ],
    details,
  };
}

export function formatNotebookMemory(memory: NotebookMemoryUsage): string {
  const ratio = memory.heapLimitBytes > 0 ? memory.heapUsedBytes / memory.heapLimitBytes : 0;
  const pressure =
    ratio >= 0.9
      ? " · CRITICAL: finish essential work and release unneeded notebook state"
      : ratio >= 0.8
        ? " · WARNING: release unneeded notebook state"
        : "";
  return `Notebook memory: heap ${formatBinaryBytes(memory.heapUsedBytes)} / ${formatBinaryBytes(memory.heapLimitBytes)} · RSS ${formatBinaryBytes(memory.rssBytes)}${pressure}`;
}

function formatBinaryBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  if (mib < 1024) return `${mib.toFixed(mib < 10 ? 1 : 0)} MiB`;
  const gib = mib / 1024;
  return `${gib.toFixed(gib < 10 ? 1 : 0)} GiB`;
}

function runningExecSessionGuidance(traces: NonNullable<RuntimeResponse["traces"]>): string[] {
  const sessionIds = new Set<number>();
  for (const trace of traces) {
    if (trace.status !== "done") continue;
    const details = trace.result?.details;
    const resultSessionId = numericSessionId(details);
    if (trace.name === "exec_command" && resultSessionId !== undefined) {
      sessionIds.add(resultSessionId);
      continue;
    }
    if (trace.name !== "write_stdin") continue;
    const inputSessionId = numericSessionId(trace.input);
    if (inputSessionId === undefined) continue;
    if (resultSessionId === undefined) sessionIds.delete(inputSessionId);
    else sessionIds.add(resultSessionId);
  }
  return [...sessionIds].map(formatRunningExecSessionGuidance);
}

export function formatRunningExecSessionGuidance(sessionId: number): string {
  return `Session ${sessionId} still running. Resume near completion with tools.write_stdin and an appropriate yield_time_ms; do not use wait`;
}

function numericSessionId(value: BoundaryValue): number | undefined {
  if (value && isObjectValue(value) && "session_id" in value && isNumberValue(value.session_id))
    return value.session_id;
  return undefined;
}

function toPiContent(
  item: RuntimeContentItem,
): { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } | undefined {
  if (item.type === "input_text" && isStringValue(item.text))
    return { type: "text", text: item.text };
  if (item.type === "input_image" && isStringValue(item.image_url)) {
    const match = item.image_url.match(/^data:([^;,]+);base64,(.+)$/s);
    if (match) return { type: "image", mimeType: match[1]!, data: match[2]! };
  }
  return undefined;
}

function truncateTextContent<T extends { type: string; text?: string }>(
  content: T[],
  maxChars: number,
): T[] {
  let remaining = maxChars;
  let truncated = false;
  const output: T[] = [];
  for (const item of content) {
    if (item.type !== "text" || !isStringValue(item.text)) {
      output.push(item);
      continue;
    }
    if (remaining <= 0) {
      if (!truncated) output.push({ ...item, text: "[Output truncated]" });
      truncated = true;
      continue;
    }
    if (item.text.length <= remaining) {
      remaining -= item.text.length;
      output.push(item);
      continue;
    }
    const text = `${item.text.slice(0, remaining)}\n[Output truncated]`;
    remaining = 0;
    truncated = true;
    output.push({ ...item, text });
  }
  return output;
}
