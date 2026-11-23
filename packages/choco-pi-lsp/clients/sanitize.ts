import { isString } from "./runtime-guards.ts";

const ANSI_ESCAPE_PREFIX = `${String.fromCharCode(27)}\\[`;
const ANSI_ESCAPE = new RegExp(`${ANSI_ESCAPE_PREFIX}[0-9;]*m`, "g");

const ANSI_ESCAPE_EXTENDED = new RegExp(`${ANSI_ESCAPE_PREFIX}[0-9;]*[A-Za-z]`, "g");

const ERROR_INDICATORS = [
  /\berror\b/i,
  /\bfailed\b/i,
  /\bfatal\b/i,
  /\binvalid\b/i,
  /\bunexpected\b/i,
  /\bexpected\b/i,
  /\bsyntax\b/i,
  /\bcannot find\b/i,
  /\bnot found\b/i,
  /\bno such\b/i,
];

const DETAIL_PATTERNS = [/^help wanted/i, /^note:/i, /^hint:/i, /^→/, /^\s*at\s+/, /^ {4}/];

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "").replace(ANSI_ESCAPE_EXTENDED, "");
}

export function normalizeWhitespace(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function isErrorLine(line: string): boolean {
  const cleanLine = stripAnsi(line).trim();
  return ERROR_INDICATORS.some((pattern) => pattern.test(cleanLine));
}

function isDetailLine(line: string): boolean {
  const cleanLine = stripAnsi(line).trim();
  return DETAIL_PATTERNS.some((pattern) => pattern.test(cleanLine));
}

export function sanitizeLine(line: string): string {
  return stripAnsi(line)
    .replace(/^\s*\[error\]\s*/i, "")
    .replace(/^\s*error:\s*/i, "")
    .replace(/^\s*[×✖✘✗]\s*/u, "")
    .replace(/^\s*[✓✔]\s*/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeOutput(output: string): string {
  if (!output || !isString(output)) {
    return "";
  }

  const lines = output.split(/\r?\n/);

  const sanitized = lines
    .map((line) => sanitizeLine(line))
    .filter((line) => line.length > 0)
    .filter((line) => !isDetailLine(line));

  return sanitized.join("\n");
}

export function extractErrorMessage(output: string): string | undefined {
  if (!output || !isString(output)) {
    return undefined;
  }

  const lines = output
    .split(/\r?\n/)
    .map((line) => sanitizeLine(line))
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return undefined;
  }

  const errorLine = lines.find((line) => isErrorLine(line));
  if (errorLine) {
    return errorLine;
  }

  const firstMain = lines.find((line) => !isDetailLine(line));
  return firstMain;
}

export function truncateMessage(message: string, maxLength: number = 140): string {
  if (message.length <= maxLength) {
    return message;
  }
  return `${message.slice(0, maxLength - 1)}…`;
}

export function sanitizeTsDiagnostic(output: string): string {
  if (!output) return "";

  const lines = output
    .split(/\r?\n/)
    .map((line) => stripAnsi(line))
    .filter((line) => line.length > 0)
    .filter((line) => line.includes("error TS") || line.includes("warning TS"));

  const fileErrors = lines
    .filter((line) => /^.+?\([\d,]+\):/.test(line))
    .map((line) => {
      const match = line.match(/^(.+?\([\d,]+\):)\s*(.+)/);
      if (match) {
        return `${match[1]} ${match[2].trim()}`;
      }
      return line.trim();
    });

  if (fileErrors.length > 0) {
    return fileErrors.slice(0, 10).join("\n");
  }

  return lines.slice(0, 5).join("\n");
}

function extractDiagnosticLines(
  output: string,
  predicate: (line: string) => boolean,
  maxLines: number = 10,
): string {
  if (!output) return "";

  return output
    .split(/\r?\n/)
    .map((line) => stripAnsi(line))
    .filter((line) => line.length > 0)
    .filter(predicate)
    .slice(0, maxLines)
    .join("\n");
}

function formatJsonDiagnostics(diags: any[], formatter: (d: any) => string): string {
  return diags.slice(0, 10).map(formatter).join("\n");
}

export function sanitizeRustOutput(output: string): string {
  if (!output) return "";

  return extractDiagnosticLines(output, (line) => {
    const clean = stripAnsi(line);
    return isErrorLine(clean) || /^\s*-->\s+/.test(clean);
  });
}

export function sanitizeGoOutput(output: string): string {
  if (!output) return "";

  return extractDiagnosticLines(output, (line) => {
    const clean = stripAnsi(line);
    return /(?:^\.\/)|(?:\.go:)/.test(clean) || isErrorLine(clean);
  });
}

export function sanitizeBiomeOutput(output: string): string {
  if (!output) return "";

  try {
    const data = JSON.parse(output);
    if (data.diagnostics && Array.isArray(data.diagnostics)) {
      return formatJsonDiagnostics(data.diagnostics, (d: any) => {
        const loc = d.location;
        const file = loc?.path ? `${loc.path}` : "";
        const line = loc?.span?.start?.line ?? 0;
        const msg = d.message || "";
        return file ? `${file}:${line + 1} ${msg}` : msg;
      });
    }
  } catch (err) {
    void err;
  }

  return extractDiagnosticLines(output, (line) => {
    const clean = stripAnsi(line);
    return isErrorLine(clean) || clean.includes("hint");
  });
}

export function sanitizeRuffOutput(output: string): string {
  if (!output) return "";

  try {
    const data = JSON.parse(output);
    if (Array.isArray(data)) {
      return formatJsonDiagnostics(data, (d: any) => {
        const row = d.location?.row ?? 0;
        const col = d.location?.column ?? 0;
        const code = d.code || "";
        const msg = d.message || "";
        return `${row}:${col} [${code}] ${msg}`;
      });
    }
  } catch (err) {
    void err;
  }

  return extractDiagnosticLines(output, (line) => {
    const clean = stripAnsi(line);
    return isErrorLine(clean) || /\[(E|W)\d+\]/.test(clean);
  });
}

export interface SanitizedResult {
  summary: string | undefined;
  details: string | undefined;
  truncated: boolean;
}

export function sanitizeToolOutput(
  output: string,
  maxSummaryLength: number = 140,
): SanitizedResult {
  if (!output || !isString(output)) {
    return { summary: undefined, details: undefined, truncated: false };
  }

  const sanitized = sanitizeOutput(output);
  const lines = sanitized.split("\n").filter((l) => l.length > 0);

  if (lines.length === 0) {
    return { summary: undefined, details: undefined, truncated: false };
  }

  const summary = extractErrorMessage(output);
  const truncatedSummary = truncateMessage(summary ?? lines[0], maxSummaryLength);

  const MAX_DETAIL_LINES = 20;
  const detailsLines = lines.slice(0, MAX_DETAIL_LINES);
  const details = detailsLines.join("\n");
  const truncated = lines.length > MAX_DETAIL_LINES;

  return {
    summary: truncatedSummary,
    details: truncated
      ? `${details}\n... and ${lines.length - MAX_DETAIL_LINES} more lines`
      : details,
    truncated,
  };
}
