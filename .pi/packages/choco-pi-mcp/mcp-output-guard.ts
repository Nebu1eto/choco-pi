import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock, McpSettings } from "./types.ts";
import {
  isBigIntValue,
  isBooleanValue,
  isNumberValue,
  isObjectValue,
  isStringValue,
  mergeObjectParts,
  parseMcpObject,
  runtimeTypeOf,
  type McpObject,
} from "./protocol-values.js";

export const DEFAULT_MCP_OUTPUT_MAX_BYTES = 50 * 1024;
export const DEFAULT_MCP_OUTPUT_MAX_LINES = 2000;
export const DEFAULT_MCP_DETAILS_MAX_BYTES = 16 * 1024;

const CONTENT_SUMMARY_LIMIT = 20;
const KEY_PREVIEW_LIMIT = 20;
const KEY_MAX_CHARS = 120;

type Recordish = McpObject;

export interface McpOutputGuardDetails {
  truncated: true;
  originalBytes: number;
  returnedBytes: number;
  originalLines: number;
  returnedLines: number;
  /** Number of image content blocks returned untouched alongside the truncated text. */
  imageBlocksPassedThrough?: number;
  fullOutputPath?: string;
  writeError?: string;
}

export interface McpResultSummary {
  omitted: true;
  reason: string;
  isError: boolean;
  contentBlocks: number;

  contentSummary: Array<McpObject>;

  structuredContent?: McpObject;

  meta?: McpObject;

  extraFields?: Array<McpObject>;
  rawResultBytes: number;
  fullResultPath?: string;
  resultWriteError?: string;
}

export interface McpOutputGuardOptions {
  enabled?: boolean;
  prefix?: string;
  suffix?: string;
  emptyTextFallback?: string;
  maxBytes?: number;
  maxLines?: number;
  detailsMaxBytes?: number;
  /**
   * Raw MCP result to expose as details.mcpResult. Kept raw when its JSON
   * fits detailsMaxBytes (or when the guard is disabled); otherwise replaced
   * with a compact summary and spilled to a temp file. Omit for call sites
   * whose details never carried the raw result (e.g. direct tools).
   */
  rawMcpResult?: unknown;
}

export interface GuardedMcpOutput {
  content: ContentBlock[];
  outputGuard?: McpOutputGuardDetails;
  mcpResult?: unknown;
}

export function resolveMcpOutputGuardOptions(
  settings?: McpSettings,
): Pick<McpOutputGuardOptions, "enabled" | "maxBytes" | "maxLines" | "detailsMaxBytes"> {
  const configured = settings?.outputGuard;

  const tuning = isObjectValue(configured) && configured !== null ? configured : undefined;
  return {
    enabled: envKillSwitch("MCP_OUTPUT_GUARD") ?? configured !== false,
    maxBytes: positiveInt(tuning?.maxBytes) ?? DEFAULT_MCP_OUTPUT_MAX_BYTES,
    maxLines: positiveInt(tuning?.maxLines) ?? DEFAULT_MCP_OUTPUT_MAX_LINES,
    detailsMaxBytes: positiveInt(tuning?.detailsMaxBytes) ?? DEFAULT_MCP_DETAILS_MAX_BYTES,
  };
}

/** Spread helper for tool-result details: includes mcpResult/outputGuard only when present. */

export function guardedMcpDetails(guarded: GuardedMcpOutput): McpObject {
  return parseMcpObject(
    mergeObjectParts(
      guarded.mcpResult !== undefined ? { mcpResult: guarded.mcpResult } : undefined,
      guarded.outputGuard ? { outputGuard: guarded.outputGuard } : undefined,
    ),
  );
}

/**
 * Bound model-facing MCP output. Text output is capped at maxBytes/maxLines and
 * spilled to a temp file when oversized. Image blocks pass through untouched —
 * they are delivered to the provider as native image content, not text context.
 */
export async function guardMcpOutput(
  content: ContentBlock[],
  options: McpOutputGuardOptions = {},
): Promise<GuardedMcpOutput> {
  const maxBytes = options.maxBytes ?? DEFAULT_MCP_OUTPUT_MAX_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_MCP_OUTPUT_MAX_LINES;
  const detailsMaxBytes = options.detailsMaxBytes ?? DEFAULT_MCP_DETAILS_MAX_BYTES;
  const prefix = options.prefix ?? "";
  const suffix = options.suffix ?? "";

  const normalizedContent = withEmptyTextFallback(
    content.length > 0
      ? sanitizeContent(content)
      : [{ type: "text" as const, text: options.emptyTextFallback ?? "(empty result)" }],
    options.emptyTextFallback,
  );

  if (options.enabled === false) {
    return mergeObjectParts(
      { content: addAffixes(normalizedContent, prefix, suffix) },
      options.rawMcpResult !== undefined ? { mcpResult: options.rawMcpResult } : undefined,
    );
  }

  const imageBlocks = normalizedContent.filter((block) => block.type === "image");
  // SAFETY: The preceding type filter guarantees every mapped block has text content.
  const textOutput = normalizedContent
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("\n");
  const composedOutput = `${prefix}${textOutput}${suffix}`;
  const stats = textStats(composedOutput);

  let guardedContent: ContentBlock[] = addAffixes(normalizedContent, prefix, suffix);
  let outputGuard: McpOutputGuardDetails | undefined;

  if (stats.bytes > maxBytes || stats.lines > maxLines) {
    const { path: fullOutputPath, error: writeError } = await saveArtifact(
      "output",
      composedOutput,
    );
    const notice = formatTruncationNotice(stats, fullOutputPath, writeError);
    const previewBudget = reserveBudget(maxBytes, maxLines, notice);
    const preview = truncateHead(composedOutput, previewBudget.maxBytes, previewBudget.maxLines);
    const finalText = `${preview.content}\n\n${notice}`;
    const finalStats = textStats(finalText);

    guardedContent = [{ type: "text" as const, text: finalText }, ...imageBlocks];
    outputGuard = mergeObjectParts(
      {
        truncated: true,
        originalBytes: stats.bytes,
        returnedBytes: finalStats.bytes,
        originalLines: stats.lines,
        returnedLines: finalStats.lines,
      },
      imageBlocks.length > 0 ? { imageBlocksPassedThrough: imageBlocks.length } : undefined,
      fullOutputPath !== undefined ? { fullOutputPath } : undefined,
      writeError !== undefined ? { writeError } : undefined,
    );
  }

  const mcpResult =
    options.rawMcpResult === undefined
      ? undefined
      : await boundMcpResult(options.rawMcpResult, detailsMaxBytes);

  return mergeObjectParts(
    { content: guardedContent },
    outputGuard ? { outputGuard } : undefined,
    mcpResult !== undefined ? { mcpResult } : undefined,
  );
}

function sanitizeContent(content: ContentBlock[]): ContentBlock[] {
  return content.map((block) => {
    if (block.type !== "image") return block;
    const mimeType =
      isStringValue(block.mimeType) && block.mimeType.trim()
        ? block.mimeType.trim().slice(0, 100)
        : "image/png";
    return { ...block, mimeType };
  });
}

function withEmptyTextFallback(
  content: ContentBlock[],
  fallback: string | undefined,
): ContentBlock[] {
  if (!fallback) return content;
  // SAFETY: The preceding type filter guarantees every mapped block has text content.
  const textOutput = content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("\n");
  if (textOutput) return content;
  return [{ type: "text", text: fallback }, ...content.filter((block) => block.type === "image")];
}

function addAffixes(content: ContentBlock[], prefix: string, suffix: string): ContentBlock[] {
  if (!prefix && !suffix) return content;
  const next: ContentBlock[] = [...content];

  if (prefix) {
    const index = next.findIndex((block) => block.type === "text");
    const block = next[index];
    if (block?.type === "text") {
      next[index] = { ...block, text: `${prefix}${block.text}` };
    } else {
      next.unshift({ type: "text", text: prefix });
    }
  }

  if (suffix) {
    let index = -1;
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i]?.type === "text") {
        index = i;
        break;
      }
    }
    const block = next[index];
    if (block?.type === "text") {
      next[index] = { ...block, text: `${block.text}${suffix}` };
    } else {
      next.push({ type: "text", text: suffix });
    }
  }

  return next;
}

function reserveBudget(maxBytes: number, maxLines: number, notice: string) {
  const noticeStats = textStats(`\n\n${notice}`);

  return {
    maxBytes: Math.max(0, maxBytes - noticeStats.bytes),
    maxLines: Math.max(0, maxLines - noticeStats.lines),
  };
}

function truncateHead(text: string, maxBytes: number, maxLines: number) {
  const lines = text.split("\n");
  const output: string[] = [];
  let bytes = 0;

  for (const line of lines) {
    if (output.length >= maxLines) break;
    const separatorBytes = output.length > 0 ? 1 : 0;
    const lineBytes = byteLength(line);
    if (bytes + separatorBytes + lineBytes > maxBytes) {
      const remaining = maxBytes - bytes - separatorBytes;
      if (remaining > 0) {
        output.push(truncateStringToBytes(line, remaining));
      }
      break;
    }
    output.push(line);
    bytes += separatorBytes + lineBytes;
  }

  const content = output.join("\n");
  const stats = textStats(content);

  return { content, bytes: stats.bytes, lines: stats.lines };
}

function truncateStringToBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  const buffer = Buffer.from(value, "utf8");
  let end = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
  while (end > 0 && (buffer.readUInt8(end) & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function formatTruncationNotice(
  stats: { bytes: number; lines: number },
  fullOutputPath: string | undefined,
  writeError: string | undefined,
): string {
  const base = `[MCP text output truncated: original ${stats.lines.toLocaleString()} lines / ${formatSize(stats.bytes)}.`;
  if (fullOutputPath) {
    return `${base} Full text saved to: ${fullOutputPath} — use read with offset/limit or grep to inspect.]`;
  }
  return `${base} Full output could not be saved: ${writeError ?? "unknown error"}]`;
}

/**
 * Bound details.mcpResult: keep the raw result when its JSON fits within
 * detailsMaxBytes; otherwise replace it with a compact summary and spill the
 * raw JSON to a temp file.
 */

async function boundMcpResult<BoundaryValue>(
  result: BoundaryValue,
  detailsMaxBytes: number,
): Promise<BoundaryValue | McpResultSummary> {
  const raw = safeStringify(result);
  const rawBytes = byteLength(raw);
  if (rawBytes <= detailsMaxBytes) return result;
  return summarizeMcpResult(result, raw, rawBytes);
}

async function summarizeMcpResult<BoundaryValue>(
  result: BoundaryValue,
  raw: string,
  rawBytes: number,
): Promise<McpResultSummary> {
  const { path: fullResultPath, error: resultWriteError } = await saveArtifact("mcp-result", raw);

  const record = asRecord(result);
  const content = Array.isArray(record?.content) ? record.content : [];
  const summary: McpResultSummary = mergeObjectParts(
    {
      omitted: true,
      reason:
        "Raw MCP result exceeded the details size limit and was replaced with this summary to keep session context bounded.",
      isError: record?.isError === true,
      contentBlocks: content.length,
      contentSummary: summarizeContent(content),
      rawResultBytes: rawBytes,
    },
    fullResultPath !== undefined ? { fullResultPath } : undefined,
    resultWriteError !== undefined ? { resultWriteError } : undefined,
  );

  if (record && "structuredContent" in record) {
    summary.structuredContent = summarizeValue(record.structuredContent);
  }
  if (record && "_meta" in record) {
    summary.meta = summarizeValue(record._meta);
  }
  if (record) {
    const standard = new Set(["content", "isError", "structuredContent", "_meta"]);
    const extraFields = Object.keys(record)
      .filter((key) => !standard.has(key))
      .slice(0, KEY_PREVIEW_LIMIT)
      .map((key) => ({
        key: truncateKey(key),

        type: runtimeTypeOf(record[key]),
        estimatedBytes: estimateValueBytes(record[key]),
        omitted: true,
      }));
    if (extraFields.length > 0) summary.extraFields = extraFields;
  }

  return summary;
}

function summarizeContent(content: unknown[]): Array<McpObject> {
  const summaries: Array<McpObject> = content.slice(0, CONTENT_SUMMARY_LIMIT).map((block) => {
    const record = asRecord(block);

    if (!record) return { type: runtimeTypeOf(block), omitted: true };
    if (record.type === "text") {
      const text = isStringValue(record.text) ? record.text : "";
      return {
        type: "text",
        bytes: byteLength(text),
        lines: textStats(text).lines,
        textOmitted: true,
      };
    }
    if (record.type === "image") {
      const data = isStringValue(record.data) ? record.data : "";
      return {
        type: "image",

        mimeType: isStringValue(record.mimeType) ? record.mimeType : undefined,
        dataBytes: byteLength(data),
        dataOmitted: true,
      };
    }
    return {
      type: isStringValue(record.type) ? record.type : "unknown",
      estimatedBytes: estimateValueBytes(record),
      omitted: true,
    };
  });
  if (content.length > CONTENT_SUMMARY_LIMIT) {
    summaries.push({ type: "omitted", count: content.length - CONTENT_SUMMARY_LIMIT });
  }
  return summaries;
}

function summarizeValue<BoundaryValue>(value: BoundaryValue): McpObject {
  const record = asRecord(value);
  if (!record) {
    return {
      type: value === null ? "null" : runtimeTypeOf(value),
      estimatedBytes: estimateValueBytes(value),
      omitted: true,
    };
  }
  const keys = Object.keys(record);

  return {
    type: Array.isArray(value) ? "array" : "object",
    estimatedBytes: estimateValueBytes(value),
    keyCount: keys.length,
    keysPreview: keys.slice(0, KEY_PREVIEW_LIMIT).map(truncateKey),
    omitted: true,
  };
}

function estimateValueBytes<BoundaryValue>(value: BoundaryValue, depth = 0): number {
  if (value === null || value === undefined) return 0;

  if (isStringValue(value)) return byteLength(value);

  if (isNumberValue(value) || isBooleanValue(value) || isBigIntValue(value))
    return byteLength(String(value));
  const record = asRecord(value);
  if (!record || depth >= 2) return 0;
  const values = Array.isArray(value)
    ? value.slice(0, KEY_PREVIEW_LIMIT)
    : Object.values(record).slice(0, KEY_PREVIEW_LIMIT);
  return values.reduce((total, item) => total + estimateValueBytes(item, depth + 1), 0);
}

function truncateKey(key: string): string {
  return key.length <= KEY_MAX_CHARS ? key : `${key.slice(0, KEY_MAX_CHARS - 1)}…`;
}

async function saveArtifact(
  kind: string,
  text: string,
): Promise<{ path?: string; error?: string }> {
  try {
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-output-"));
    const path = join(dir, `${kind}-${randomBytes(4).toString("hex")}.txt`);
    await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
    return { path };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function asRecord<BoundaryValue>(value: BoundaryValue): Recordish | undefined {
  if (!isObjectValue(value) || value === null) return undefined;
  // SAFETY: The runtime check establishes an object with string-accessible MCP fields.
  return value as Recordish;
}

function safeStringify<BoundaryValue>(value: BoundaryValue): string {
  try {
    // The output guard measures and spills raw MCP results; it does not render this JSON for the model.
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function textStats(text: string) {
  return { bytes: byteLength(text), lines: text.length === 0 ? 0 : text.split("\n").length };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function positiveInt<BoundaryValue>(value: BoundaryValue): number | undefined {
  if (!isNumberValue(value) || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function envKillSwitch(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return undefined;
  if (["0", "false", "no", "off"].includes(value)) return false;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  return undefined;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
