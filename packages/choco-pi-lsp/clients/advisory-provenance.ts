import { arr, bool, compile, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { finite, hasErrorCode, isFiniteNumber } from "./runtime-guards.ts";
import type { RuntimeCoordinator } from "./runtime-coordinator.ts";
import { logLatency } from "./latency-logger.ts";
import { normalizeMapKey, toProjectRelativePath } from "./path-utils.ts";
import { resolveRunnerPath } from "./dispatch/runner-context.ts";
import { MTIME_DRIFT_TOLERANCE_MS } from "./blocker-freshness.ts";

export type AdvisoryFileRole = "source" | "test" | "affected";

const AdvisoryProvenanceSchema = obj(
  {
    revision: obj(
      {
        sessionId: str(),
        projectSeq: finite(),
        turnIndex: finite(),
        generation: finite(),
        capturedAt: finite(),
      },
      { open: true },
    ),
    files: arr(
      obj(
        {
          path: str(),
          role: oneOf(["source", "test", "affected"]),
          mtimeMs: finite(),
          size: finite(),
          sha256: str({ pattern: "^(?:[a-f0-9]{64}|missing|unreadable:.*)$" }),
        },
        { open: true },
      ),
      { minItems: 1 },
    ),
    truncated: opt(bool()),
  },
  { open: true },
);
const isAdvisoryProvenanceRecord = compile(AdvisoryProvenanceSchema).check;

export interface AdvisoryFileProvenance {
  path: string;
  role: AdvisoryFileRole;
  mtimeMs: number;
  size: number;
  sha256: string;
}

export interface AdvisoryProvenance {
  revision: {
    sessionId: string;
    projectSeq: number;
    turnIndex: number;
    generation: number;
    capturedAt: number;
  };
  files: AdvisoryFileProvenance[];
  truncated?: boolean;
}

export interface AdvisoryValidation {
  status: "current" | "superseded" | "unknown";
  reasons: string[];
  allFilesDeleted: boolean;
  changedPathCount: number;
}

export const MAX_ADVISORY_AFFECTED_FILES = 256;

export function advisoryPathKey(filePath: string, cwd: string): string {
  return normalizeMapKey(path.resolve(cwd, filePath));
}

export function advisoryFileHash(filePath: string): string {
  try {
    return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch (error) {
    const code = hasErrorCode(error) ? (error.code ?? "unknown") : "unknown";
    return code === "ENOENT" ? "missing" : `unreadable:${code}`;
  }
}

function snapshotOne(
  filePath: string,
  cwd: string,
  role: AdvisoryFileRole,
): AdvisoryFileProvenance {
  const resolved = path.resolve(cwd, filePath);
  try {
    const stat = fs.statSync(resolved);
    return {
      path: resolved,
      role,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sha256: advisoryFileHash(resolved),
    };
  } catch (error) {
    const code = hasErrorCode(error) ? (error.code ?? "unknown") : "unknown";
    return {
      path: resolved,
      role,
      mtimeMs: -1,
      size: -1,
      sha256: code === "ENOENT" ? "missing" : `unreadable:${code}`,
    };
  }
}

export function snapshotAdvisoryProvenance(args: {
  cwd: string;
  runtime: Pick<RuntimeCoordinator, "telemetrySessionId" | "projectSeq" | "turnIndex">;
  generation: number;
  files: Array<{ path: string; role: AdvisoryFileRole }>;
  capturedAt?: number;
  truncated?: boolean;
}): AdvisoryProvenance {
  const seen = new Set<string>();
  const files: AdvisoryFileProvenance[] = [];
  for (const file of args.files) {
    const key = advisoryPathKey(file.path, args.cwd);
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(snapshotOne(file.path, args.cwd, file.role));
  }
  const provenance: AdvisoryProvenance = {
    revision: {
      sessionId: args.runtime.telemetrySessionId,
      projectSeq: args.runtime.projectSeq,
      turnIndex: args.runtime.turnIndex,
      generation: args.generation,
      capturedAt: args.capturedAt ?? Date.now(),
    },
    files,
  };
  if (args.truncated) provenance.truncated = true;
  return provenance;
}

function parseAdvisoryProvenance<T>(value: T): AdvisoryProvenance | undefined {
  return isAdvisoryProvenanceRecord(value) ? value : undefined;
}

export function validateAdvisoryProvenance(
  record: { provenance?: unknown },
  cwd: string,
  runtime?: Pick<RuntimeCoordinator, "telemetrySessionId" | "projectSeq" | "turnIndex">,
): AdvisoryValidation {
  const provenance = parseAdvisoryProvenance(record.provenance);
  if (!provenance) {
    return {
      status: "unknown",
      reasons: ["malformed-or-legacy-provenance"],
      allFilesDeleted: false,
      changedPathCount: 0,
    };
  }
  const reasons: string[] = [];
  let unknown = provenance.truncated === true;
  if (unknown) reasons.push("truncated-provenance");
  if (runtime) {
    if (provenance.revision.sessionId !== runtime.telemetrySessionId)
      reasons.push("session-mismatch");
  }
  let deletedFiles = 0;
  const changedPaths = new Set<string>();
  for (const captured of provenance.files) {
    const resolved = path.resolve(cwd, captured.path);
    const reasonsBefore = reasons.length;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch (error) {
      const code = hasErrorCode(error) ? (error.code ?? "unknown") : "unknown";
      if (code === "ENOENT") {
        if (captured.sha256 !== "missing") {
          deletedFiles += 1;
          reasons.push(`missing:${advisoryPathKey(resolved, cwd)}`);
          changedPaths.add(advisoryPathKey(resolved, cwd));
        }
      } else {
        unknown = true;
        reasons.push(`unreadable:${advisoryPathKey(resolved, cwd)}:${code}`);
        changedPaths.add(advisoryPathKey(resolved, cwd));
      }
      continue;
    }
    if (captured.sha256.startsWith("unreadable:")) {
      unknown = true;
      reasons.push(`capture-unreadable:${advisoryPathKey(resolved, cwd)}`);
      changedPaths.add(advisoryPathKey(resolved, cwd));
      continue;
    }
    if (captured.sha256 === "missing") {
      reasons.push(`created:${advisoryPathKey(resolved, cwd)}`);
      changedPaths.add(advisoryPathKey(resolved, cwd));
      continue;
    }
    if (stat.mtimeMs !== captured.mtimeMs || stat.size !== captured.size) {
      reasons.push(`metadata-changed:${advisoryPathKey(resolved, cwd)}`);
    }
    const currentHash = advisoryFileHash(resolved);
    if (currentHash.startsWith("unreadable:")) {
      unknown = true;
      reasons.push(`${currentHash}:${advisoryPathKey(resolved, cwd)}`);
    } else if (currentHash !== captured.sha256) {
      reasons.push(`content-changed:${advisoryPathKey(resolved, cwd)}`);
    }
    if (reasons.length > reasonsBefore) changedPaths.add(advisoryPathKey(resolved, cwd));
  }
  const allFilesDeleted = deletedFiles === provenance.files.length;
  if (unknown)
    return { status: "unknown", reasons, allFilesDeleted, changedPathCount: changedPaths.size };
  return reasons.length > 0
    ? { status: "superseded", reasons, allFilesDeleted, changedPathCount: changedPaths.size }
    : { status: "current", reasons: [], allFilesDeleted, changedPathCount: 0 };
}

export const MAX_FINDING_PATH_STATS = MAX_ADVISORY_AFFECTED_FILES;

const MAX_LOGGED_DEAD_PATHS = 3;

export type FindingPathFreshness = "live" | "stale" | "missing" | "unknown";

export type FindingPathExistence = "live" | "missing" | "unknown";

export type FindingMissingPolicy = "drop" | "demote";

export function findingPathFreshness(
  resolvedPath: string,
  scannedAtMs?: number,
): FindingPathFreshness {
  try {
    const stat = fs.statSync(resolvedPath);
    if (scannedAtMs !== undefined && stat.mtimeMs > scannedAtMs + MTIME_DRIFT_TOLERANCE_MS) {
      return "stale";
    }
    return "live";
  } catch (error) {
    const code = hasErrorCode(error) ? (error.code ?? "unknown") : "unknown";
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unknown";
  }
}

export function findingPathExistence(resolvedPath: string): FindingPathExistence {
  // SAFETY: Omitting scannedAt disables the only branch that can return "stale".
  return findingPathFreshness(resolvedPath) as FindingPathExistence;
}

export function parseScannedAtMs(scannedAt: string | number | undefined): number | undefined {
  if (scannedAt === undefined || scannedAt === null || scannedAt === "") {
    return undefined;
  }
  const ms = isFiniteNumber(scannedAt) ? scannedAt : Date.parse(scannedAt);
  return Number.isFinite(ms) ? ms : undefined;
}

export interface FindingPathPartition<T> {
  live: T[];
  stale: T[];
  dropped: T[];
  deadPaths: string[];
  stalePaths: string[];
  statCount: number;
  truncated: boolean;
}

export function partitionFindingsByCitedPath<T>(args: {
  findings: readonly T[];
  cwd: string;
  citedPath: (finding: T) => string | undefined;
  maxUniquePaths?: number;
  scannedAt?: string | number;
  onMissing?: FindingMissingPolicy;
  existence?: (resolvedPath: string, scannedAtMs?: number) => FindingPathFreshness;
}): FindingPathPartition<T> {
  const limit = args.maxUniquePaths ?? MAX_FINDING_PATH_STATS;
  const probe = args.existence ?? findingPathFreshness;
  const scannedAtMs = parseScannedAtMs(args.scannedAt);
  const onMissing = args.onMissing ?? "drop";
  const rawVerdicts = new Map<string, FindingPathFreshness>();
  const verdicts = new Map<string, FindingPathFreshness>();
  const live: T[] = [];
  const stale: T[] = [];
  const dropped: T[] = [];
  const deadPaths: string[] = [];
  const stalePaths: string[] = [];
  let truncated = false;
  for (const finding of args.findings) {
    const cited = args.citedPath(finding);
    if (!cited) {
      live.push(finding);
      continue;
    }
    let verdict = rawVerdicts.get(cited);
    if (verdict === undefined) {
      const resolved = resolveRunnerPath(args.cwd, cited);
      const key = resolved;
      verdict = verdicts.get(key);
      if (verdict === undefined) {
        if (verdicts.size >= limit) {
          truncated = true;
          verdict = "live";
        } else {
          verdict = probe(resolved, scannedAtMs);
          if (verdict === "missing" && onMissing === "demote") {
            verdict = "stale";
          }
          verdicts.set(key, verdict);
          if (verdict === "missing") deadPaths.push(resolved);
          else if (verdict === "stale") stalePaths.push(resolved);
        }
      }
      rawVerdicts.set(cited, verdict);
    }
    if (verdict === "missing") dropped.push(finding);
    else if (verdict === "stale") stale.push(finding);
    else live.push(finding);
  }
  return {
    live,
    stale,
    dropped,
    deadPaths,
    stalePaths,
    statCount: verdicts.size,
    truncated,
  };
}

export function dropFindingsForMissingPaths<T>(args: {
  store: string;
  findings: readonly T[];
  cwd: string;
  citedPath: (finding: T) => string | undefined;
  maxUniquePaths?: number;
  existence?: (resolvedPath: string, scannedAtMs?: number) => FindingPathFreshness;
}): T[] {
  const partition = partitionFindingsByCitedPath(args);
  emitDeadPathDropRecord(args.store, args.cwd, partition);
  return partition.live;
}

export interface FindingFreshnessGate<T> {
  live: T[];
  stale: T[];
}

export function gateFindingsByPathFreshness<T>(args: {
  store: string;
  findings: readonly T[];
  cwd: string;
  scannedAt?: string | number;
  citedPath: (finding: T) => string | undefined;
  maxUniquePaths?: number;
  onMissing?: FindingMissingPolicy;
  existence?: (resolvedPath: string, scannedAtMs?: number) => FindingPathFreshness;
}): FindingFreshnessGate<T> {
  const partition = partitionFindingsByCitedPath(args);
  emitDeadPathDropRecord(args.store, args.cwd, partition);
  emitStaleLineDemoteRecord(args.store, args.cwd, args.scannedAt, partition);
  return { live: partition.live, stale: partition.stale };
}

interface DeadPathMetadata {
  store: string;
  droppedDeadPaths: number;
  deadPathCount: number;
  deliveredCount: number;
  statCount: number;
  samplePaths: string[];
  truncated?: boolean;
}

interface StalePathMetadata {
  store: string;
  demotedStalePaths: number;
  stalePathCount: number;
  deliveredCount: number;
  statCount: number;
  samplePaths: string[];
  scannedAt?: string;
  truncated?: boolean;
}

function emitDeadPathDropRecord<T>(
  store: string,
  cwd: string,
  partition: FindingPathPartition<T>,
): void {
  if (partition.dropped.length === 0) return;
  let metadata: DeadPathMetadata = {
    store,
    droppedDeadPaths: partition.dropped.length,
    deadPathCount: partition.deadPaths.length,
    deliveredCount: partition.live.length,
    statCount: partition.statCount,
    samplePaths: partition.deadPaths
      .slice(0, MAX_LOGGED_DEAD_PATHS)
      .map((deadPath) => toProjectRelativePath(deadPath, cwd)),
  };
  if (partition.truncated) metadata = { ...metadata, truncated: true };
  logLatency({
    type: "phase",
    phase: "finding_dead_path_drop",
    filePath: cwd,
    durationMs: 0,
    metadata: { ...metadata },
  });
}

function emitStaleLineDemoteRecord<T>(
  store: string,
  cwd: string,
  scannedAt: string | number | undefined,
  partition: FindingPathPartition<T>,
): void {
  if (partition.stale.length === 0) return;
  let metadata: StalePathMetadata = {
    store,
    demotedStalePaths: partition.stale.length,
    stalePathCount: partition.stalePaths.length,
    deliveredCount: partition.live.length,
    statCount: partition.statCount,
    samplePaths: partition.stalePaths
      .slice(0, MAX_LOGGED_DEAD_PATHS)
      .map((stalePath) => toProjectRelativePath(stalePath, cwd)),
  };
  if (scannedAt !== undefined) metadata = { ...metadata, scannedAt: String(scannedAt) };
  if (partition.truncated) metadata = { ...metadata, truncated: true };
  logLatency({
    type: "phase",
    phase: "finding_stale_line_demote",
    filePath: cwd,
    durationMs: 0,
    metadata: { ...metadata },
  });
}

export function provenanceStamp<T>(provenance: T): string {
  const parsed = parseAdvisoryProvenance(provenance);
  if (!parsed) return "session unknown / turn unknown / generation unknown";
  return `session ${parsed.revision.sessionId} / turn ${parsed.revision.turnIndex} / generation ${parsed.revision.generation}`;
}
