import type { RuntimeValue } from "./runtime-values.ts";
import { isRuntimeFunction } from "./runtime-values.ts";

export type ToolUpdate = (update: {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}) => void;

export function scanningSummaryLine(details: RuntimeValue, text: string): string | null {
  // SAFETY: The tool schema or typed LSP producer establishes this shape; consumers validate optional response fields before use.
  const d = details as { phase?: string; completed?: number; total?: number } | undefined;
  if (d?.phase !== "scanning") return null;
  return text || `Scanning… ${d.completed ?? 0}/${d.total ?? 0}`;
}

export function renderScanProgress(
  completed: number,
  total: number,
  label = "Scanning project diagnostics",
): string {
  const pct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  const width = 20;
  const filled = Math.round((pct / 100) * width);
  const bar = "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
  return `${label}… [${bar}] ${completed}/${total} (${pct}%)`;
}

export function makeProgressReporter(
  onUpdate: RuntimeValue,
  label?: string,
  throttleMs = 250,
): ((completed: number, total: number) => void) | undefined {
  // SAFETY: The tool schema or typed LSP producer establishes this shape; consumers validate optional response fields before use.
  const emit = onUpdate as ToolUpdate | undefined;
  if (!isRuntimeFunction(emit)) return undefined;
  let lastEmit = 0;
  return (completed: number, total: number) => {
    const now = Date.now();
    if (completed < total && now - lastEmit < throttleMs) return;
    lastEmit = now;
    emit({
      content: [{ type: "text", text: renderScanProgress(completed, total, label) }],
      details: { phase: "scanning", completed, total },
    });
  };
}
