import type {
  AvailabilityCause,
  AvailabilityOutcome,
} from "../dispatch/runners/utils/availability-policy.ts";

export interface FailedProjectAnalyzer {
  id: string;
  summary: string;
}

interface AnalyzerWarmTriggers {
  [analyzerId: string]: string;
}

const WARM_TRIGGER: AnalyzerWarmTriggers = {
  opengrep: "runs at session-start",
  "test-runner":
    "fires per-edit at turn_end (only after a source file with a discoverable test companion is edited)",
};

export function warmTriggerFor(analyzerId: string): string {
  return WARM_TRIGGER[analyzerId] ?? "runs at session-start";
}

export function formatNotRunEntry(
  analyzerId: string,
  coldReasons: Record<string, string> | undefined,
): string {
  const reason = coldReasons?.[analyzerId];
  return reason
    ? `${analyzerId} — not run (${reason})`
    : `${analyzerId} — not run (${warmTriggerFor(analyzerId)})`;
}

export function formatCacheAge(ms: number): string {
  if (!Number.isFinite(ms)) return "age unknown";
  if (ms < 0) return "0m";
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 1) return "under 1m";
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
}

export interface AvailabilityVerdictLike {
  outcome: AvailabilityOutcome | null;
  cause: AvailabilityCause | null;
  retryAtMs: number;
}

export function reasonFromAvailabilityVerdict(
  tool: string,
  verdict: AvailabilityVerdictLike | undefined,
): string {
  if (!verdict || verdict.outcome === null) return `${tool} binary unavailable`;
  const { outcome, cause } = verdict;
  if (outcome === "transient") {
    if (cause === "install-retry-exhausted") {
      return `${tool} install kept timing out and hit its retry ceiling this session (not reported missing)`;
    }
    const remainingMs = verdict.retryAtMs - Date.now();
    const remainingS = remainingMs > 0 ? Math.round(remainingMs / 1000) : 0;
    return `${tool} availability probe — retry cooldown (${remainingS}s), not a missing install`;
  }
  if (outcome === "non-installable") {
    return `${tool} unavailable on this host (non-installable)`;
  }
  return `${tool} binary unavailable`;
}
