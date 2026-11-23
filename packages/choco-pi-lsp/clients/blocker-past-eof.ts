import {
  demotePastEofDiagnostics,
  resyncDocumentOnPastEof,
  type LineCountCache,
} from "./diagnostic-line-freshness.ts";
import type { RuntimeCoordinator } from "./runtime-coordinator.ts";

export interface BlockerPastEofCounts {
  total: number;
  checked: number;
  demoted: number;
  healed: number;
}

export interface BlockerPastEofOptions {
  lineCountCache?: LineCountCache;
  resync?: (filePath: string) => void;
}

export function sweepInlineBlockerPastEof(
  runtime: RuntimeCoordinator,
  cwd: string,
  options?: BlockerPastEofOptions,
): BlockerPastEofCounts {
  const counts: BlockerPastEofCounts = {
    total: 0,
    checked: 0,
    demoted: 0,
    healed: 0,
  };
  const resync = options?.resync ?? resyncDocumentOnPastEof;

  let entries: ReturnType<RuntimeCoordinator["getInlineBlockersSnapshot"]>;
  try {
    entries = runtime.getInlineBlockersSnapshot();
  } catch {
    return counts;
  }
  counts.total = entries.length;

  for (const entry of entries) {
    try {
      if (!entry.lines || entry.lines.length === 0) continue;
      if (entry.stale && entry.staleReason !== "past-eof") continue;
      counts.checked += 1;

      const probes = entry.lines.map((line) => ({
        line,
        stale: entry.stale,
        staleReason: entry.staleReason,
      }));
      const { diagnostics } = demotePastEofDiagnostics({
        store: "inline-blocker",
        cwd,
        filePath: entry.filePath,
        diagnostics: probes,
        lineCountCache: options?.lineCountCache,
        resync,
      });
      const isPastEof = diagnostics.some((d) => d.stale);
      const transitioned = runtime.setInlineBlockerPastEofStale(entry.filePath, isPastEof);
      if (!transitioned) continue;
      if (isPastEof) {
        counts.demoted += 1;
      } else {
        counts.healed += 1;
      }
    } catch {}
  }
  return counts;
}
