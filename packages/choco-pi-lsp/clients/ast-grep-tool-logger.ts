import * as path from "node:path";
import { isTestMode } from "./env-utils.ts";
import { getGlobalPiLensDir } from "./file-utils.ts";
import { createNdjsonLogger } from "./ndjson-logger.ts";

const AG_LOG_DIR = getGlobalPiLensDir();
const AG_LOG_FILE = path.join(AG_LOG_DIR, "ast-grep-tools.log");
const AG_LOG_BACKUP_FILE = path.join(AG_LOG_DIR, "ast-grep-tools.log.1");
const MAX_LOG_BYTES = Math.max(
  128 * 1024,
  Number.parseInt(process.env.CHOCO_PI_LSP_AST_GREP_LOG_MAX_BYTES ?? "1048576", 10) || 1048576,
);
const writer = createNdjsonLogger({
  filePath: AG_LOG_FILE,
  maxBytes: MAX_LOG_BYTES,
  backupPath: AG_LOG_BACKUP_FILE,
});

export type AstGrepToolName = "ast_grep_search" | "ast_grep_replace";

export type AstGrepToolOutcome = "success" | "no_matches" | "error";

export type AstGrepErrorKind =
  | "multiple_ast_nodes"
  | "cannot_parse_query"
  | "tool_not_found"
  | "timeout"
  | "json_parse_failed"
  | "other";

export interface AstGrepToolEvent {
  tool: AstGrepToolName;
  sessionId?: string;
  lang: string;
  pattern: string;
  patternLineCount: number;
  rewrite?: string;
  rewriteLineCount?: number;
  pathsCount: number;
  applied?: boolean;
  outcome: AstGrepToolOutcome;
  errorKind?: AstGrepErrorKind;
  errorRaw?: string;
  matchCount: number;
  truncated: boolean;
  durationMs: number;
}

const PATTERN_TRUNCATE_AT = 500;
const ERROR_TRUNCATE_AT = 300;

function truncate(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[truncated ${value.length - max} chars]`;
}

function countLines(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) === 10) lines++;
  }
  return lines;
}

export function classifyAstGrepError(errorMessage: string | undefined): AstGrepErrorKind {
  if (!errorMessage) return "other";
  const lower = errorMessage.toLowerCase();
  if (
    lower.includes("multiple ast nodes are detected") ||
    lower.includes("the pattern appears to contain multiple ast nodes")
  ) {
    return "multiple_ast_nodes";
  }
  if (
    lower.includes("cannot parse query") ||
    lower.includes("pattern syntax error") ||
    lower.includes("could not be parsed as valid code")
  ) {
    return "cannot_parse_query";
  }
  if (
    lower.includes("cli not found") ||
    lower.includes("enoent") ||
    lower.includes("not installed")
  ) {
    return "tool_not_found";
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return "timeout";
  }
  if (lower.includes("failed to parse output")) {
    return "json_parse_failed";
  }
  return "other";
}

export function astGrepRemediationHint(kind: AstGrepErrorKind): string | null {
  switch (kind) {
    case "multiple_ast_nodes":
    case "cannot_parse_query":
      return null;
    case "tool_not_found":
      return "Hint: the ast-grep CLI is missing or not on PATH — install it with `npm i -D @ast-grep/cli`.";
    case "timeout":
      return "Hint: the operation timed out — scope `paths` to specific files/folders, or narrow the pattern.";
    case "json_parse_failed":
      return "Hint: ast-grep produced output that could not be parsed — retry with a simpler pattern; the installed CLI version may be incompatible.";
    default:
      return "Hint: verify the pattern is a single valid AST node for this `lang` (use ast_grep_dump to discover node kinds), or fall back to grep for plain-text search.";
  }
}

export function logAstGrepToolEvent(
  event: Omit<AstGrepToolEvent, "pattern" | "rewrite" | "errorRaw"> & {
    pattern: string;
    rewrite?: string;
    errorRaw?: string;
  },
): void {
  if (isTestMode()) return;
  const payload: AstGrepToolEvent = {
    ...event,
    pattern: truncate(event.pattern, PATTERN_TRUNCATE_AT) ?? "",
    patternLineCount: event.patternLineCount,
    rewrite: truncate(event.rewrite, PATTERN_TRUNCATE_AT),
    rewriteLineCount: event.rewriteLineCount,
    errorRaw: truncate(event.errorRaw, ERROR_TRUNCATE_AT),
  };
  writer.log({ ts: new Date().toISOString(), ...payload });
}

export function getAstGrepToolLogPath(): string {
  return AG_LOG_FILE;
}

export function flushAstGrepToolLog(): Promise<void> {
  return writer.flush();
}

export { countLines as _countLinesForTest };
