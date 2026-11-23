import { normalizeMapKey } from "./path-utils.ts";

export type TurnSummaryEventKind = "diagnostic" | "autofix" | "format";

export interface TurnSummaryEvent {
  kind: TurnSummaryEventKind;
  tool: string;
  ruleId?: string;
  severity?: "error" | "warning" | "info" | "hint";
  line?: number;
  description?: string;
}

export interface TurnSummaryFileEntry {
  filePath: string;
  displayPath: string;
  events: TurnSummaryEvent[];
}

export interface TurnSummaryCounts {
  diagnostics: number;
  autofixes: number;
  formats: number;
  byTool: {
    diagnostic: Record<string, number>;
    autofix: Record<string, number>;
    format: Record<string, number>;
  };
}

export interface TurnSummaryDetails {
  version: 1;
  turnIndex: number;
  files: TurnSummaryFileEntry[];
  counts: TurnSummaryCounts;
}

export class TurnSummaryCollector {
  private readonly filesByKey = new Map<string, TurnSummaryFileEntry>();

  private getOrCreate(filePath: string): TurnSummaryFileEntry {
    const key = normalizeMapKey(filePath);
    let entry = this.filesByKey.get(key);
    if (!entry) {
      entry = { filePath, displayPath: filePath, events: [] };
      this.filesByKey.set(key, entry);
    }
    return entry;
  }

  record(filePath: string, event: TurnSummaryEvent): void {
    this.getOrCreate(filePath).events.push(event);
  }

  recordDiagnostic(
    filePath: string,
    args: {
      tool: string;
      ruleId?: string;
      severity?: "error" | "warning" | "info" | "hint";
      line?: number;
      description?: string;
    },
  ): void {
    this.record(filePath, { kind: "diagnostic", ...args });
  }

  recordAutofix(
    filePath: string,
    args: { tool: string; description?: string; line?: number },
  ): void {
    this.record(filePath, { kind: "autofix", ...args });
  }

  recordFormat(filePath: string, args: { tool: string }): void {
    this.record(filePath, { kind: "format", ...args });
  }

  isEmpty(): boolean {
    return this.filesByKey.size === 0;
  }

  peek(): TurnSummaryFileEntry[] {
    return [...this.filesByKey.values()];
  }

  clear(): void {
    this.filesByKey.clear();
  }

  consume(turnIndex: number, toDisplayPath?: (filePath: string) => string): TurnSummaryDetails {
    const files = [...this.filesByKey.values()].map((entry) => ({
      ...entry,
      displayPath: toDisplayPath ? toDisplayPath(entry.filePath) : entry.filePath,
    }));
    this.filesByKey.clear();

    const counts: TurnSummaryCounts = {
      diagnostics: 0,
      autofixes: 0,
      formats: 0,
      byTool: { diagnostic: {}, autofix: {}, format: {} },
    };
    for (const file of files) {
      for (const event of file.events) {
        if (event.kind === "diagnostic") counts.diagnostics++;
        else if (event.kind === "autofix") counts.autofixes++;
        else counts.formats++;
        const bucket = counts.byTool[event.kind];
        bucket[event.tool] = (bucket[event.tool] ?? 0) + 1;
      }
    }

    return { version: 1, turnIndex, files, counts };
  }
}

function formatToolCounts(byTool: Record<string, number>): string {
  return Object.entries(byTool)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tool, count]) => `${tool} ${count}`)
    .join(", ");
}

export function formatTurnSummaryLine(details: TurnSummaryDetails): string {
  const parts: string[] = [];
  const { counts } = details;
  if (counts.diagnostics > 0) {
    const byTool = formatToolCounts(counts.byTool.diagnostic);
    parts.push(
      `${counts.diagnostics} diagnostic${counts.diagnostics === 1 ? "" : "s"}${byTool ? ` (${byTool})` : ""}`,
    );
  }
  if (counts.autofixes > 0) {
    const byTool = formatToolCounts(counts.byTool.autofix);
    parts.push(`${counts.autofixes} autofixed${byTool ? ` (${byTool})` : ""}`);
  }
  if (counts.formats > 0) {
    const byTool = formatToolCounts(counts.byTool.format);
    parts.push(`${counts.formats} reformatted${byTool ? ` (${byTool})` : ""}`);
  }
  if (parts.length === 0) return "choco-pi-lsp: turn summary (empty)";
  return `choco-pi-lsp: ${parts.join(" · ")}`;
}

export const TURN_SUMMARY_CUSTOM_TYPE = "pilens:turn-summary";
