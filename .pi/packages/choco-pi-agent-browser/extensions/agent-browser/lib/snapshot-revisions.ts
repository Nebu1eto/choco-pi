import { hasRuntimeType, isRecord, type RuntimeRecord, type RuntimeValue } from "./parsing.ts";

export interface SnapshotOptionsIdentity {
  compact?: boolean;
  cursor?: boolean;
  depth?: number;
  interactive?: boolean;
  selector?: string;
  urls?: boolean;
}

export interface SnapshotRevisionContext {
  document: string;
  namespace?: string;
  options: SnapshotOptionsIdentity;
  session: string;
  tab: string;
  url: string;
}

export interface NormalizedSnapshotData extends RuntimeRecord<RuntimeValue> {
  origin: string;
  refs: RuntimeRecord<RuntimeValue>;
  revision?: number;
  snapshot: string;
}

export type SnapshotRefreshReason =
  | "base-revision-mismatch"
  | "invalid-delta"
  | "missing-baseline"
  | "out-of-order"
  | "scope-mismatch";

export type SnapshotNormalizationOutcome =
  | {
      data: NormalizedSnapshotData;
      kind: "normalized";
      source: "delta" | "full" | "legacy" | "unchanged";
    }
  | {
      expectedBaseRevision?: number;
      kind: "refresh-required";
      reason: SnapshotRefreshReason;
      receivedBaseRevision?: number;
    }
  | { kind: "unrecognized"; reason: string };

interface SnapshotBaseline {
  contextKey: string;
  data: NormalizedSnapshotData;
  namespace: string;
  revision: number;
  sessionKey: string;
}

const DEFAULT_MAX_BASELINES = 32;

function isNonNegativeInteger(value: RuntimeValue): value is number {
  return hasRuntimeType(value, "number") && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: RuntimeValue): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function normalizeNamespace(namespace: string | undefined): string {
  return namespace ?? "";
}

function sessionKey(context: SnapshotRevisionContext): string {
  return JSON.stringify([normalizeNamespace(context.namespace), context.session]);
}

function contextKey(context: SnapshotRevisionContext): string {
  return JSON.stringify([
    normalizeNamespace(context.namespace),
    context.session,
    context.tab,
    context.document,
    context.url,
    context.options.selector ?? null,
    context.options.interactive ?? false,
    context.options.compact ?? false,
    context.options.cursor ?? false,
    context.options.depth ?? null,
    context.options.urls ?? false,
  ]);
}

function cloneRecord(record: RuntimeRecord<RuntimeValue>): RuntimeRecord<RuntimeValue> {
  return { ...record };
}

function getOrigin(data: RuntimeRecord<RuntimeValue>): string | undefined {
  return hasRuntimeType(data.origin, "string") ? data.origin : undefined;
}

function normalizedData(
  original: RuntimeRecord<RuntimeValue>,
  origin: string,
  snapshot: string,
  refs: RuntimeRecord<RuntimeValue>,
  revision?: number,
): NormalizedSnapshotData {
  const base = { ...original, origin, refs: cloneRecord(refs), snapshot };
  return revision === undefined ? base : { ...base, revision };
}

function stripRefPrefix(value: RuntimeValue): string | undefined {
  if (!hasRuntimeType(value, "string") || !/^@e\d+$/.test(value)) return undefined;
  return value.slice(1);
}

function getScopedBaseline(
  baselines: Map<string, SnapshotBaseline>,
  context: SnapshotRevisionContext,
): SnapshotBaseline | { reason: "missing-baseline" | "scope-mismatch" } {
  const exact = baselines.get(contextKey(context));
  if (exact) return exact;
  const sameSession = [...baselines.values()].some(
    (baseline) => baseline.sessionKey === sessionKey(context),
  );
  return { reason: sameSession ? "scope-mismatch" : "missing-baseline" };
}

function applyTreeChange(tree: string, change: RuntimeValue): string | undefined {
  if (!isRecord(change)) return undefined;
  const startLine = change.startLine;
  const deleteCount = change.deleteCount;
  if (!isNonNegativeInteger(startLine) || !isNonNegativeInteger(deleteCount)) return undefined;
  if (!Array.isArray(change.lines)) return undefined;
  const lines: string[] = [];
  for (const line of change.lines) {
    if (!hasRuntimeType(line, "string")) return undefined;
    lines.push(line);
  }
  const current = tree.split("\n");
  if (startLine > current.length || deleteCount > current.length - startLine) return undefined;
  current.splice(startLine, deleteCount, ...lines);
  return current.join("\n");
}

function applyRefChanges(
  refs: RuntimeRecord<RuntimeValue>,
  changes: RuntimeValue,
): RuntimeRecord<RuntimeValue> | undefined {
  if (!Array.isArray(changes)) return undefined;
  const next = cloneRecord(refs);
  for (const change of changes) {
    if (!isRecord(change) || !hasRuntimeType(change.op, "string")) return undefined;
    const ref = stripRefPrefix(change.ref);
    if (!ref) return undefined;
    if (change.op === "remove") {
      if (!(ref in next)) return undefined;
      delete next[ref];
      continue;
    }
    if (change.op === "add") {
      if (ref in next || !isRecord(change.node)) return undefined;
      next[ref] = cloneRecord(change.node);
      continue;
    }
    if (change.op !== "replace" || !isRecord(next[ref])) return undefined;
    if (change.field !== "role" && change.field !== "name") return undefined;
    if (change.value !== null && !hasRuntimeType(change.value, "string")) return undefined;
    const node = cloneRecord(next[ref]);
    if (change.value === null) delete node[change.field];
    else node[change.field] = change.value;
    next[ref] = node;
  }
  return next;
}

export class SnapshotRevisionStore {
  private readonly baselines = new Map<string, SnapshotBaseline>();
  private readonly maxEntries: number;

  constructor(maxEntries = DEFAULT_MAX_BASELINES) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("Snapshot revision cache size must be a positive integer.");
    }
    this.maxEntries = maxEntries;
  }

  normalize(data: RuntimeValue, context?: SnapshotRevisionContext): SnapshotNormalizationOutcome {
    if (!isRecord(data))
      return { kind: "unrecognized", reason: "Snapshot result is not an object." };
    const origin = getOrigin(data);
    if (!origin) return { kind: "unrecognized", reason: "Snapshot result has no string origin." };

    if (hasRuntimeType(data.snapshot, "string")) {
      if (!isRecord(data.refs)) {
        return { kind: "unrecognized", reason: "Legacy snapshot has no valid refs object." };
      }
      return {
        data: normalizedData(data, origin, data.snapshot, data.refs),
        kind: "normalized",
        source: "legacy",
      };
    }
    if (!isRecord(data.snapshot) || !hasRuntimeType(data.snapshot.kind, "string")) {
      return { kind: "unrecognized", reason: "Snapshot result has an unknown shape." };
    }

    const snapshot = data.snapshot;
    if (snapshot.kind === "full") {
      if (
        !isPositiveInteger(snapshot.revision) ||
        !hasRuntimeType(snapshot.tree, "string") ||
        !isRecord(snapshot.refs)
      ) {
        return { kind: "unrecognized", reason: "Full snapshot fields are invalid." };
      }
      const result = normalizedData(data, origin, snapshot.tree, snapshot.refs, snapshot.revision);
      if (context) this.setBaseline(context, result, snapshot.revision);
      return { data: result, kind: "normalized", source: "full" };
    }
    if (snapshot.kind !== "delta" && snapshot.kind !== "unchanged") {
      return { kind: "unrecognized", reason: `Unknown snapshot kind: ${String(snapshot.kind)}` };
    }
    if (!context) return { kind: "refresh-required", reason: "missing-baseline" };

    const baseline = getScopedBaseline(this.baselines, context);
    if ("reason" in baseline) {
      if (baseline.reason === "scope-mismatch")
        this.invalidateSession(context.namespace, context.session);
      return { kind: "refresh-required", reason: baseline.reason };
    }
    if (!isPositiveInteger(snapshot.baseRevision) || !isPositiveInteger(snapshot.revision)) {
      this.baselines.delete(baseline.contextKey);
      return { kind: "refresh-required", reason: "invalid-delta" };
    }
    if (snapshot.baseRevision !== baseline.revision) {
      this.baselines.delete(baseline.contextKey);
      return {
        expectedBaseRevision: baseline.revision,
        kind: "refresh-required",
        reason:
          snapshot.baseRevision < baseline.revision ? "out-of-order" : "base-revision-mismatch",
        receivedBaseRevision: snapshot.baseRevision,
      };
    }
    if (snapshot.revision !== snapshot.baseRevision + 1 || origin !== context.url) {
      this.baselines.delete(baseline.contextKey);
      return { kind: "refresh-required", reason: "out-of-order" };
    }

    if (snapshot.kind === "unchanged") {
      const result = normalizedData(
        data,
        origin,
        baseline.data.snapshot,
        baseline.data.refs,
        snapshot.revision,
      );
      this.setBaseline(context, result, snapshot.revision);
      return { data: result, kind: "normalized", source: "unchanged" };
    }

    const tree = applyTreeChange(baseline.data.snapshot, snapshot.treeChange);
    const refs = applyRefChanges(baseline.data.refs, snapshot.changes);
    if (tree === undefined || refs === undefined) {
      this.baselines.delete(baseline.contextKey);
      return { kind: "refresh-required", reason: "invalid-delta" };
    }
    const result = normalizedData(data, origin, tree, refs, snapshot.revision);
    this.setBaseline(context, result, snapshot.revision);
    return { data: result, kind: "normalized", source: "delta" };
  }

  invalidateSession(namespace: string | undefined, session: string): void {
    const key = JSON.stringify([normalizeNamespace(namespace), session]);
    for (const [cacheKey, baseline] of this.baselines) {
      if (baseline.sessionKey === key) this.baselines.delete(cacheKey);
    }
  }

  invalidateNamespace(namespace?: string): void {
    const normalized = normalizeNamespace(namespace);
    for (const [cacheKey, baseline] of this.baselines) {
      if (baseline.namespace === normalized) this.baselines.delete(cacheKey);
    }
  }

  clear(): void {
    this.baselines.clear();
  }

  private setBaseline(
    context: SnapshotRevisionContext,
    data: NormalizedSnapshotData,
    revision: number,
  ): void {
    const key = contextKey(context);
    this.baselines.delete(key);
    this.baselines.set(key, {
      contextKey: key,
      data,
      namespace: normalizeNamespace(context.namespace),
      revision,
      sessionKey: sessionKey(context),
    });
    while (this.baselines.size > this.maxEntries) {
      const oldest = this.baselines.keys().next().value;
      if (oldest === undefined) break;
      this.baselines.delete(oldest);
    }
  }
}

export function normalizeSnapshotResult(
  data: RuntimeValue,
  context?: SnapshotRevisionContext,
  store = new SnapshotRevisionStore(),
): SnapshotNormalizationOutcome {
  return store.normalize(data, context);
}
