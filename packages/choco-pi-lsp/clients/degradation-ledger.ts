import { finite } from "./runtime-guards.ts";
import { arr, compile, obj, str } from "@earendil-works/pi-schema";
import { logExtension } from "./extension-log.ts";

export type DegradationKind =
  | "trust-refusal"
  | "mode-suppression"
  | "ts-idle-eviction"
  | "spawn-failure"
  | "formatter-skip"
  | "grammar-blocked"
  | "lsp-breaker"
  | "lsp-client-skipped-broken"
  | "lsp-client-skipped-unavailable-command"
  | "formatter-failure"
  | "wasm-abort"
  | "lsp-diagnostics-timeout"
  | "bus-stale"
  | "query-predicates-invalid"
  | "install-retry-exhausted"
  | "ast-grep-napi-unavailable"
  | "web-tree-sitter-load-failed"
  | "instance-registry-corrupt"
  | "cascade-budget-override-disarmed"
  | "lsp-pull-unconfirmed"
  | "tool-call-handler-throw"
  | "path-variant-unresolved"
  | "path-attribution-orphan-unresolved"
  | "lsp-pull-late-answer"
  | "managed-tool-refresh"
  | "lsp-nav-request-timeout"
  | "lsp-nav-late-answer"
  | "lsp-pull-late-rejection"
  | "lsp-pull-diagnostic-timeout"
  | "lsp-pull-skipped-budget-exhausted"
  | "generation-guard-stale-write"
  | "runner-empty-result";

export interface DegradationRecord {
  kind: unknown;
  subject: unknown;
  reason: unknown;
}

export interface DegradationGroup {
  kind: string;
  count: number;
  droppedCount: number;
  latestReasons: Array<{ subject: string; reason: string }>;
}

const ENTRIES_PER_KIND = 20;
const MAX_DISTINCT_KINDS = 32;
const OVERFLOW_KIND = "other";
const groups = new Map<
  string,
  { count: number; entries: Array<{ subject: string; reason: string }> }
>();
const onceKeys = new Set<string>();
const tallies = new Map<string, number>();
let ledgerGeneration = 0;

export function getDegradationLedgerGeneration(): number {
  return ledgerGeneration;
}

export function recordDegradation(record: DegradationRecord): void {
  try {
    const kind = boundedKind(record.kind);
    const subject = truncateForLedger(record.subject);
    const reason = truncateForLedger(record.reason);
    let group = groups.get(kind);
    if (!group) {
      group = { count: 0, entries: [] };
      groups.set(kind, group);
    }
    group.count += 1;
    group.entries.push({ subject, reason });
    if (group.entries.length > ENTRIES_PER_KIND) group.entries.shift();
  } catch (error) {
    debugLedgerFailure("record", error);
  }
}

export function recordDegradationOnce(record: DegradationRecord): void {
  try {
    const kind = boundedKind(record.kind);
    const subject = truncateForLedger(record.subject);
    const key = `${kind}\0${subject}`;
    if (onceKeys.has(key)) return;
    onceKeys.add(key);
    recordDegradation({ kind, subject, reason: record.reason });
  } catch (error) {
    debugLedgerFailure("record-once", error);
  }
}

export function incrementDegradationCount(record: DegradationRecord): boolean {
  try {
    const kind = boundedKind(record.kind);
    const subject = truncateForLedger(record.subject);
    const reason = truncateForLedger(record.reason);
    const key = `${kind}\0${subject}`;
    const count = (tallies.get(key) ?? 0) + 1;
    tallies.set(key, count);
    let group = groups.get(kind);
    if (!group) {
      group = { count: 0, entries: [] };
      groups.set(kind, group);
    }
    group.count += 1;
    const entry = {
      subject,
      reason: truncateForLedger(`${reason} (count: ${count})`),
    };
    const existing = group.entries.findIndex((candidate) => candidate.subject === subject);
    if (existing >= 0) group.entries.splice(existing, 1);
    group.entries.push(entry);
    if (group.entries.length > ENTRIES_PER_KIND) group.entries.shift();
    return count === 1;
  } catch (error) {
    debugLedgerFailure("increment", error);
    return false;
  }
}

const LEDGER_FIELD_MAX = 200;
const DegradationSummarySchema = arr(
  obj(
    {
      kind: str(),
      count: finite(),
      latestReasons: arr(obj({ subject: str(), reason: str() }, { open: true })),
    },
    { open: true },
  ),
);
const isDegradationSummary = compile(DegradationSummarySchema).check;

function normalizeForLedger<T>(value: T): string {
  return String(value ?? "unknown");
}

function boundedKind<T>(value: T): string {
  const kind = truncateForLedger(value);
  if (groups.has(kind) || kind === OVERFLOW_KIND) return kind;
  return groups.size < MAX_DISTINCT_KINDS - 1 ? kind : OVERFLOW_KIND;
}

function truncateForLedger<T>(value: T): string {
  const text = normalizeForLedger(value);
  return text.length > LEDGER_FIELD_MAX ? `${text.slice(0, LEDGER_FIELD_MAX)}…` : text;
}

export function getDegradationSummary(): DegradationGroup[] {
  return [...groups.entries()].map(([kind, group]) => ({
    kind,
    count: group.count,
    droppedCount: group.count - group.entries.length,
    latestReasons: group.entries.map((entry) => ({ ...entry })),
  }));
}

interface RenderableDegradationGroup {
  kind: string;
  count: number;
  latestReasons: Array<{ subject: string; reason: string }>;
}

function parseRenderableSummary<T>(value: T): RenderableDegradationGroup[] | undefined {
  return isDegradationSummary(value) ? value : undefined;
}

export function renderDegradationLines<T>(summary?: T): string[] {
  const candidate = summary === undefined ? getDegradationSummary() : summary;
  const parsed = parseRenderableSummary(candidate);
  if (!parsed || parsed.length === 0) return [];
  return [
    "Degradations:",
    ...parsed.map((group) => {
      const latest = group.latestReasons.at(-1);
      return `  ⚠ ${group.kind}: ${group.count}${latest ? ` — ${latest.subject}: ${latest.reason}` : ""}`;
    }),
  ];
}

function debugLedgerFailure<T>(operation: string, error: T): void {
  try {
    logExtension({
      subsystem: "degradation-ledger",
      level: "debug",
      message: `${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  } catch {}
}

export function resetDegradationLedger(): void {
  groups.clear();
  onceKeys.clear();
  tallies.clear();
  ledgerGeneration++;
}

export const DEGRADATION_ENTRIES_PER_KIND = ENTRIES_PER_KIND;
export const DEGRADATION_MAX_DISTINCT_KINDS = MAX_DISTINCT_KINDS;
