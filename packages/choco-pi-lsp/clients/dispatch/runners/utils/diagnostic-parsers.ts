import { getAutofixCapability } from "../../../tool-policy.ts";
import type { DefectClass, Diagnostic } from "../../types.ts";

const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export interface LineParserConfig {
  tool: string;
  regex: RegExp;
  extractMessage: (match: RegExpMatchArray) => string;
  extractRule?: (match: RegExpMatchArray) => string | undefined;
  generateId: (match: RegExpMatchArray) => string;
  getSeverity?: (line: string, match: RegExpMatchArray) => "error" | "warning" | "info";
  fixable?: boolean | ((match: RegExpMatchArray) => boolean);
  autoFixAvailable?: boolean | ((match: RegExpMatchArray) => boolean);
  fixKind?: Diagnostic["fixKind"] | ((match: RegExpMatchArray) => Diagnostic["fixKind"]);
  defectClass?: DefectClass;
  stripAnsi?: boolean;
}

export function createLineParser(config: LineParserConfig) {
  return (raw: string, filePath: string): Diagnostic[] => {
    const diagnostics: Diagnostic[] = [];

    const clean = config.stripAnsi !== false ? raw.replace(ANSI_ESCAPE_PATTERN, "") : raw;

    const lines = clean.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      const match = line.match(config.regex);
      if (!match) continue;

      const lineNum = parseInt(match[2], 10);
      const colNum = parseInt(match[3], 10);

      const severity = config.getSeverity ? config.getSeverity(line, match) : "warning";

      const fixable =
        config.fixable instanceof Function ? config.fixable(match) : (config.fixable ?? false);
      const autoFixAvailable =
        config.autoFixAvailable instanceof Function
          ? config.autoFixAvailable(match)
          : (config.autoFixAvailable ?? false);
      const fixKind = config.fixKind instanceof Function ? config.fixKind(match) : config.fixKind;

      diagnostics.push({
        id: config.generateId(match),
        message: config.extractMessage(match),
        filePath,
        line: lineNum,
        column: colNum,
        severity,
        semantic: severity === "error" ? "blocking" : "warning",
        tool: config.tool,
        rule: config.extractRule?.(match),
        defectClass: config.defectClass,
        fixable,
        autoFixAvailable,
        fixKind,
      });
    }

    return diagnostics;
  };
}

const ruffAutofix = getAutofixCapability("ruff");

export const parseRuffOutput = createLineParser({
  tool: "ruff",
  regex: /^(.+?):(\d+):(\d+):\s*(\w+)\s*(.+)/,
  extractMessage: (m) => `${m[4]}: ${m[5]}`,
  extractRule: (m) => m[4],
  generateId: (m) => `ruff-${m[4]}`,
  fixable: true,
  autoFixAvailable: ruffAutofix?.safePipelineAutofix ?? false,
  fixKind: ruffAutofix?.fixKind === "none" ? undefined : ruffAutofix?.fixKind,
});

export const parseGoVetOutput = createLineParser({
  tool: "go-vet",
  regex: /^(.+?):(\d+):(\d+):\s*(.+)/,
  extractMessage: (m) => m[4],
  generateId: (m) => `go-vet-${m[2]}`,
  defectClass: "correctness",
});

export function createBiomeParser(_autofix: boolean = false) {
  const biomeAutofix = getAutofixCapability("biome");
  return createLineParser({
    tool: "biome",
    regex: /^(.+?):(\d+):(\d+)\s+(.+?)\s*\((.+?)\)/,
    extractMessage: (m) => `${m[5]}: ${m[4]}`,
    extractRule: (m) => m[5],
    generateId: (m) => `biome-${m[2]}-${m[5]}`,
    getSeverity: (line) => (line.includes("error") ? "error" : "warning"),
    fixable: true,
    autoFixAvailable: biomeAutofix?.safePipelineAutofix ?? false,
    fixKind: biomeAutofix?.fixKind === "none" ? undefined : biomeAutofix?.fixKind,
  });
}

export const parseBiomeOutput = createBiomeParser(false);

export function createSimpleParser(
  tool: string,
  options: {
    separator?: ":" | " " | ",";
    includesFileName?: boolean;
    severity?: "error" | "warning" | "info";
    fixable?: boolean;
  } = {},
): (raw: string, filePath: string) => Diagnostic[] {
  const sep = options.separator ?? ":";
  const severity = options.severity ?? "warning";
  const fixable = options.fixable ?? false;

  const escapedSep = sep === " " ? "\\s+" : escapeRegExp(sep);
  const regex = options.includesFileName
    ? new RegExp(`^(.+?)${escapedSep}(\\d+)${escapedSep}(\\d+)${escapedSep}(.+)`)
    : new RegExp(`^(\\d+)${escapedSep}(\\d+)${escapedSep}(.+)`);

  return (raw: string, filePath: string): Diagnostic[] => {
    const diagnostics: Diagnostic[] = [];
    const lines = raw.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      const match = line.match(regex);
      if (!match) continue;

      const lineNum = options.includesFileName ? parseInt(match[2], 10) : parseInt(match[1], 10);
      const colNum = options.includesFileName ? parseInt(match[3], 10) : parseInt(match[2], 10);
      const message = options.includesFileName ? match[4] : match[3];

      diagnostics.push({
        id: `${tool}-${lineNum}`,
        message: message.trim(),
        filePath,
        line: lineNum,
        column: colNum,
        severity,
        semantic: severity === "error" ? "blocking" : "warning",
        tool,
        fixable,
      });
    }

    return diagnostics;
  };
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
