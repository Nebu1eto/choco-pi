import type { LSPDiagnostic } from "../../lsp/client.ts";
import type { Diagnostic } from "../types.ts";

interface LspSeverityMap {
  [severity: number]: "error" | "warning" | "hint";
}

export interface ConvertLspDiagnosticsOptions {
  tool?: string;
  scanOrigin?: string;
  fixSuggestionByIndex?: Map<number, string>;
}

export function convertLspDiagnostics(
  diags: LSPDiagnostic[],
  filePath: string,
  options: ConvertLspDiagnosticsOptions = {},
): Diagnostic[] {
  const tool = options.tool ?? "lsp";
  return diags
    .filter((d) => d.range?.start?.line !== undefined)
    .map((d, idx) => {
      const severityMap: LspSeverityMap = {
        1: "error",
        2: "warning",
        4: "hint",
      };
      const severity: "error" | "warning" | "info" | "hint" = severityMap[d.severity] ?? "info";
      const semantic = d.severity === 1 ? "blocking" : d.severity === 2 ? "warning" : "none";
      const code = String(d.code ?? "unknown");
      const source = d.source ?? tool;
      const hasSuggestion = options.fixSuggestionByIndex?.has(idx) ?? false;
      return {
        id: `${tool}:${code}:${d.range.start.line}`,
        message: d.message,
        filePath,
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        severity,
        semantic,
        tool,
        rule: `${source}:${code}`,
        fixable: hasSuggestion,
        autoFixAvailable: false,
        fixKind: hasSuggestion ? "suggestion" : undefined,
        fixSuggestion: options.fixSuggestionByIndex?.get(idx),
        scanOrigin: options.scanOrigin,
      } satisfies Diagnostic;
    });
}
