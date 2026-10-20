/**
 * Read-only views of the whole subagent tree for the root orchestrator.
 *
 * `get_subagent_result` stays direct-children-only because it consumes a
 * result. These helpers never touch read claims, consumption flags, status, or
 * steering: they only describe records the manager already holds, so a root
 * can see grandchild failures without reading transcript files.
 */

import type { AgentRecord } from "./types.ts";
import { getLifetimeTotal } from "./usage.ts";

export const SUBAGENT_TREE_TOOL_NAME = "subagent_tree";
export const SUBAGENT_STATUS_TOOL_NAME = "get_subagent_status";

export const TERMINAL_REASON_LIMIT = 200;

export type TreeStatusFilter = "all" | "active" | "terminal";

export interface SubagentTreeEntry {
  id: string;
  alias?: string;
  type: string;
  depth: number;
  parentId?: string;
  status: AgentRecord["status"];
  model?: string;
  tokens: number;
  toolUses: number;
  durationMs: number;
  terminalReason?: string;
}

const NON_TERMINAL_STATUSES: ReadonlySet<AgentRecord["status"]> = new Set([
  "queued",
  "running",
  "waiting_for_reset",
  "interrupted",
]);

const FAILURE_STATUSES: ReadonlySet<AgentRecord["status"]> = new Set([
  "error",
  "budget_exceeded",
  "watchdog_stopped",
]);

export function isTerminalStatus(status: AgentRecord["status"]): boolean {
  return !NON_TERMINAL_STATUSES.has(status);
}

/** Terminal outcomes that represent a failed run, not a user/parent stop or success. */
export function isTerminalFailureStatus(status: AgentRecord["status"]): boolean {
  return FAILURE_STATUSES.has(status);
}

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function recordModel(record: AgentRecord): string | undefined {
  const live = record.session?.model;
  if (live !== undefined) return `${live.provider}/${live.id}`;
  if (record.spawnModel !== undefined)
    return `${record.spawnModel.provider}/${record.spawnModel.id}`;
  return record.modelProvenance?.model;
}

function terminalReason(record: AgentRecord): string | undefined {
  if (!isTerminalStatus(record.status)) return undefined;
  const cancellation = record.cancellation;
  const currentCancellation =
    cancellation !== undefined && cancellation.generation === (record.resultGeneration ?? 1)
      ? cancellation.reason
      : undefined;
  const reason = record.error ?? currentCancellation;
  return reason === undefined || reason.trim() === ""
    ? undefined
    : truncate(reason, TERMINAL_REASON_LIMIT);
}

export function describeSubagent(record: AgentRecord, now = Date.now()): SubagentTreeEntry {
  const entry: SubagentTreeEntry = {
    id: record.id,
    type: record.type,
    depth: record.depth ?? 1,
    status: record.status,
    tokens: getLifetimeTotal(record.lifetimeUsage),
    toolUses: record.toolUses,
    durationMs: Math.max(0, (record.completedAt ?? now) - record.startedAt),
  };
  if (record.alias !== undefined) entry.alias = record.alias;
  if (record.parentAgentId !== undefined) entry.parentId = record.parentAgentId;
  const model = recordModel(record);
  if (model !== undefined) entry.model = model;
  const reason = terminalReason(record);
  if (reason !== undefined) entry.terminalReason = reason;
  return entry;
}

/** Resolve an id, assigned name, or handle across every record, nested included. */
export function resolveSubagentRecord(
  records: readonly AgentRecord[],
  ref: string,
): AgentRecord | undefined {
  return (
    records.find((record) => record.id === ref) ??
    records.find((record) => record.alias === ref) ??
    records.find((record) => record.handle === ref)
  );
}

export function formatSubagentStatusLine(entry: SubagentTreeEntry): string {
  const name = entry.alias === undefined ? entry.id : `${entry.alias} (${entry.id})`;
  const parts = [
    `${name} [${entry.type}]`,
    `status=${entry.status}`,
    `depth=${entry.depth}`,
    `parent=${entry.parentId ?? "root"}`,
    `model=${entry.model ?? "unknown"}`,
    `tokens=${entry.tokens}`,
    `tools=${entry.toolUses}`,
    `duration=${Math.round(entry.durationMs / 1000)}s`,
  ];
  if (entry.terminalReason !== undefined) parts.push(`reason=${entry.terminalReason}`);
  return parts.join(" | ");
}

function matchesFilter(record: AgentRecord, filter: TreeStatusFilter): boolean {
  if (filter === "all") return true;
  return filter === "terminal" ? isTerminalStatus(record.status) : !isTerminalStatus(record.status);
}

export type SubagentTreeView =
  | { kind: "ok"; text: string; entries: SubagentTreeEntry[] }
  | { kind: "unknown-root"; ref: string };

/**
 * Indented tree of every record (or one subtree). A filtered-out ancestor is
 * still printed when it has matching descendants so their placement stays
 * readable; `entries` holds only the matching records.
 */
export function buildSubagentTree(
  records: readonly AgentRecord[],
  options: { status?: TreeStatusFilter; root?: string; now?: number } = {},
): SubagentTreeView {
  const filter = options.status ?? "all";
  const now = options.now ?? Date.now();
  const byId = new Map(records.map((record) => [record.id, record]));
  const children = new Map<string | undefined, AgentRecord[]>();
  for (const record of records) {
    const parent =
      record.parentAgentId !== undefined && byId.has(record.parentAgentId)
        ? record.parentAgentId
        : undefined;
    const list = children.get(parent) ?? [];
    list.push(record);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.startedAt - b.startedAt);

  let tops: AgentRecord[];
  if (options.root === undefined) {
    tops = children.get(undefined) ?? [];
  } else {
    const scoped = resolveSubagentRecord(records, options.root);
    if (scoped === undefined) return { kind: "unknown-root", ref: options.root };
    tops = [scoped];
  }

  interface Rendered {
    lines: string[];
    entries: SubagentTreeEntry[];
  }
  const seen = new Set<string>();
  const visit = (record: AgentRecord, level: number): Rendered => {
    if (seen.has(record.id)) return { lines: [], entries: [] };
    seen.add(record.id);
    const below: Rendered = { lines: [], entries: [] };
    for (const child of children.get(record.id) ?? []) {
      const rendered = visit(child, level + 1);
      below.lines.push(...rendered.lines);
      below.entries.push(...rendered.entries);
    }
    const matches = matchesFilter(record, filter);
    if (!matches && below.lines.length === 0) return below;
    const entry = describeSubagent(record, now);
    const marker = matches ? "-" : "·";
    return {
      lines: [`${"  ".repeat(level)}${marker} ${formatSubagentStatusLine(entry)}`, ...below.lines],
      entries: matches ? [entry, ...below.entries] : below.entries,
    };
  };
  const lines: string[] = [];
  const entries: SubagentTreeEntry[] = [];
  for (const top of tops) {
    const rendered = visit(top, 0);
    lines.push(...rendered.lines);
    entries.push(...rendered.entries);
  }

  const header = `Subagent tree: ${entries.length} matching record${entries.length === 1 ? "" : "s"} (filter: ${filter}${options.root === undefined ? "" : `, root: ${options.root}`})`;
  const text = lines.length === 0 ? `${header}\nNo agents.` : `${header}\n${lines.join("\n")}`;
  return { kind: "ok", text, entries };
}

export interface SubagentStatusBatch {
  text: string;
  entries: SubagentTreeEntry[];
  unknown: string[];
}

export function buildSubagentStatusBatch(
  records: readonly AgentRecord[],
  refs: readonly string[],
  now = Date.now(),
): SubagentStatusBatch {
  const lines: string[] = [];
  const entries: SubagentTreeEntry[] = [];
  const unknown: string[] = [];
  for (const ref of refs) {
    const record = resolveSubagentRecord(records, ref);
    if (record === undefined) {
      unknown.push(ref);
      lines.push(`${ref} | status=unknown`);
      continue;
    }
    const entry = describeSubagent(record, now);
    entries.push(entry);
    lines.push(formatSubagentStatusLine(entry));
  }
  return { text: lines.join("\n"), entries, unknown };
}

/** Failed nested records, for the fleet status line. */
export function countFailedDescendants(records: readonly AgentRecord[]): number {
  return records.filter(
    (record) => record.parentAgentId !== undefined && isTerminalFailureStatus(record.status),
  ).length;
}

function displayName(record: AgentRecord): string {
  return record.alias ?? record.handle ?? record.id;
}

export function formatDescendantFailure(
  record: AgentRecord,
  parent: AgentRecord | undefined,
): string {
  const owner = parent === undefined ? (record.parentAgentId ?? "unknown") : displayName(parent);
  const reason = terminalReason(record) ?? record.status;
  return `Descendant ${displayName(record)} (owner ${owner}, depth ${record.depth ?? 1}) failed: ${reason}`;
}

/**
 * Emits one root-visible line per failed nested generation. Returns undefined
 * for non-failures, top-level records, and repeats of an already reported
 * generation.
 */
export class DescendantFailureReporter {
  private readonly reported = new Set<string>();

  report(record: AgentRecord, parent: AgentRecord | undefined): string | undefined {
    if (record.parentAgentId === undefined || !isTerminalFailureStatus(record.status)) {
      return undefined;
    }
    const key = `${record.id}:${record.terminalResultGeneration ?? record.resultGeneration ?? 1}`;
    if (this.reported.has(key)) return undefined;
    this.reported.add(key);
    return formatDescendantFailure(record, parent);
  }
}
