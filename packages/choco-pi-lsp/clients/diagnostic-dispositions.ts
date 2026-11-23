import { compile, map, nullable, obj, opt, unknown } from "@earendil-works/pi-schema";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { commitDurableStore } from "./durable-store.ts";
import { logDispositionEvent } from "./disposition-logger.ts";
import { publishDisposition } from "./disposition-publish.ts";
import { getProjectDataDir } from "./file-utils.ts";
import { normalizeMapKey } from "./path-utils.ts";
import { lineContentHash } from "./read-guard.ts";

export interface DispositionCandidate {
  tool?: string;
  rule?: string;
  message: string;
  line?: number;
  semantic?: string;
}

export type Disposition = "false-positive" | "suppress" | "defer" | "flagged";
export type PersistedDisposition = Exclude<Disposition, "defer">;

export interface DispositionEntry {
  disposition: PersistedDisposition;
  reason?: string;
  createdAt: string;
  lastSeenAt: string;
  line?: number;
  lineText?: string;
}

interface DispositionStateFile {
  dispositions?: Record<string, DispositionEntry>;
}

const DispositionStateFileSchema = obj(
  { dispositions: opt(nullable(map(unknown()))) },
  { open: true },
);
const isDispositionStateFile = compile(DispositionStateFileSchema).check;

const deferredThisSession = new Set<string>();

function deferredKey(cwd: string, anchor: string): string {
  return `${normalizeMapKey(cwd)}::${anchor}`;
}

export function normalizeMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim().toLowerCase();
}

function relativeFile(filePath: string, cwd: string): string {
  const canonicalCwd = normalizeMapKey(cwd);
  const canonicalFile = normalizeMapKey(filePath);
  const rel = path.relative(canonicalCwd, canonicalFile).replace(/\\/g, "/");
  return rel && !rel.startsWith("..") ? rel : canonicalFile;
}

export interface DispositionAnchorArgs {
  cwd: string;
  filePath: string;
  tool?: string;
  rule?: string;
  message: string;
  line?: number;
  content?: string;
}

export function computeStrictAnchor(args: DispositionAnchorArgs): string {
  const lines = args.content?.split(/\r?\n/);
  const lineText = args.line !== undefined && lines ? (lines[args.line - 1] ?? "") : "";
  const parts = [
    relativeFile(args.filePath, args.cwd),
    args.tool ?? "",
    args.rule ?? "",
    normalizeMessage(args.message),
    lineContentHash(lineText),
  ];
  return `dd:${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 12)}`;
}

export function computeWeakAnchor(args: DispositionAnchorArgs): string {
  const parts = [
    relativeFile(args.filePath, args.cwd),
    args.tool ?? "",
    args.rule ?? "",
    normalizeMessage(args.message),
  ];
  return `ddw:${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 12)}`;
}

export function anchorsForDiagnostic(
  cwd: string,
  filePath: string,
  diagnostic: DispositionCandidate,
  content: string,
) {
  const args: DispositionAnchorArgs = {
    cwd,
    filePath,
    tool: diagnostic.tool,
    rule: diagnostic.rule,
    message: diagnostic.message,
    line: diagnostic.line,
    content,
  };
  return { strict: computeStrictAnchor(args), weak: computeWeakAnchor(args) };
}

function statePath(cwd: string): string {
  return path.join(getProjectDataDir(cwd), "cache", "diagnostic-dispositions.json");
}

interface StateCache {
  path: string;
  missing: boolean;
  mtimeMs: number;
  size: number;
  state: DispositionStateFile;
}
let stateCache: StateCache | null = null;

const DISPOSITION_LOCK_WAIT_MS = 2_000;
const DISPOSITION_LOCK_RETRY_MS = 10;

let beforeDispositionCommitForTests: (() => void) | null = null;
let beforeDispositionCacheRefreshForTests: (() => void) | null = null;
let dispositionStatSync: typeof fs.statSync = fs.statSync;

export function _setBeforeDispositionCommitForTests(hook: (() => void) | null): void {
  beforeDispositionCommitForTests = hook;
}

export function _setBeforeDispositionCacheRefreshForTests(hook: (() => void) | null): void {
  beforeDispositionCacheRefreshForTests = hook;
}

export function _setDispositionStatForTests(statSync: typeof fs.statSync | null): void {
  dispositionStatSync = statSync ?? fs.statSync;
}

let multiFileReadFileSync: typeof fs.readFileSync = fs.readFileSync;

export function _setMultiFileReadForTests(readFileSync: typeof fs.readFileSync | null): void {
  multiFileReadFileSync = readFileSync ?? fs.readFileSync;
}
function readState(cwd: string): DispositionStateFile {
  const p = statePath(cwd);
  let stat: fs.Stats;
  try {
    stat = dispositionStatSync(p);
  } catch {
    if (stateCache && stateCache.path === p && stateCache.missing) {
      return stateCache.state;
    }
    const empty: DispositionStateFile = {};
    stateCache = { path: p, missing: true, mtimeMs: -1, size: -1, state: empty };
    return empty;
  }
  if (
    stateCache &&
    stateCache.path === p &&
    !stateCache.missing &&
    stateCache.mtimeMs === stat.mtimeMs &&
    stateCache.size === stat.size
  ) {
    return stateCache.state;
  }
  let state: DispositionStateFile;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    // SAFETY: The shallow schema matches the legacy loader; individual fields remain guarded at use sites.
    state = isDispositionStateFile(parsed) ? (parsed as DispositionStateFile) : {};
  } catch {
    state = {};
  }
  stateCache = {
    path: p,
    missing: false,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    state,
  };
  return state;
}

function deserializeState(contents: string | undefined): DispositionStateFile {
  try {
    const parsed = JSON.parse(contents ?? "");
    // SAFETY: The shallow schema matches the legacy loader; individual fields remain guarded at use sites.
    return isDispositionStateFile(parsed) ? (parsed as DispositionStateFile) : {};
  } catch {
    return {};
  }
}

function refreshStateCache(p: string, state: DispositionStateFile): void {
  const stat = fs.statSync(p);
  stateCache = {
    path: p,
    missing: false,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    state,
  };
}

function commitDisposition(cwd: string, anchor: string, entry: DispositionEntry): void {
  const p = statePath(cwd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const hook = beforeDispositionCommitForTests;
  beforeDispositionCommitForTests = null;
  hook?.();
  commitDurableStore({
    path: p,
    deserialize: deserializeState,
    merge: (state) => {
      state.dispositions ??= {};
      state.dispositions[anchor] = entry;
      return state;
    },
    serialize: (state) => JSON.stringify(state, null, 2),
    waitMs: DISPOSITION_LOCK_WAIT_MS,
    retryMs: DISPOSITION_LOCK_RETRY_MS,
    timeoutMessage: "timed out acquiring diagnostic disposition store lock",
    onContention: "throw",
    afterWriteLocked: (state) => {
      const cacheHook = beforeDispositionCacheRefreshForTests;
      beforeDispositionCacheRefreshForTests = null;
      cacheHook?.();
      refreshStateCache(p, state);
    },
  });
}

export function _resetStateCacheForTests(): void {
  stateCache = null;
}

export type DispositionMarkTarget = DispositionAnchorArgs;

function emitMarkTelemetry(
  cwd: string,
  target: DispositionMarkTarget,
  disposition: Disposition,
  anchor: string,
  reason: string | undefined,
  existing: DispositionEntry | undefined,
  identity: { model?: string; provider?: string } | undefined,
): void {
  try {
    logDispositionEvent({
      event: "mark",
      disposition,
      tool: target.tool,
      rule: target.rule,
      filePath: relativeFile(target.filePath, cwd),
      line: target.line,
      reason,
      anchor,
      previousDisposition: existing?.disposition,
      model: identity?.model || undefined,
      provider: identity?.provider || undefined,
    });
    publishDisposition({
      cwd,
      filePath: target.filePath,
      disposition,
      tool: target.tool,
      rule: target.rule,
      line: target.line,
      anchor,
      reason,
    });
  } catch {}
}

export function markDisposition(
  cwd: string,
  target: DispositionMarkTarget,
  disposition: Disposition,
  reason?: string,
  identity?: { model?: string; provider?: string },
): string {
  const anchor =
    disposition === "false-positive" ? computeStrictAnchor(target) : computeWeakAnchor(target);
  const existing = readState(cwd).dispositions?.[anchor];
  if (disposition === "defer") {
    deferredThisSession.add(deferredKey(cwd, anchor));
    emitMarkTelemetry(cwd, target, disposition, anchor, reason, existing, identity);
    return anchor;
  }

  const now = new Date().toISOString();
  const capturesFixContext = disposition === "flagged";
  const lineText = capturesFixContext
    ? (
        target.content?.split(/\r?\n/)[target.line !== undefined ? target.line - 1 : -1] ??
        existing?.lineText
      )?.trim()
    : existing?.lineText;
  const entry: DispositionEntry = {
    disposition,
    reason: reason ?? existing?.reason,
    createdAt: existing?.createdAt ?? now,
    lastSeenAt: now,
    line: capturesFixContext ? (target.line ?? existing?.line) : existing?.line,
    lineText,
  };
  commitDisposition(cwd, anchor, entry);
  emitMarkTelemetry(cwd, target, disposition, anchor, reason, existing, identity);
  return anchor;
}

export function getDisposition(cwd: string, anchor: string): DispositionEntry | undefined {
  return readState(cwd).dispositions?.[anchor];
}

export function isDeferredThisSession(cwd: string, anchor: string): boolean {
  return deferredThisSession.has(deferredKey(cwd, anchor));
}

export function _resetDeferredForTests(): void {
  deferredThisSession.clear();
}

export function applyDispositions<T extends DispositionCandidate>(
  diagnostics: T[],
  cwd: string,
  filePath: string,
  content: string,
): T[] {
  if (!diagnostics.length) return diagnostics;
  const dispositions = readState(cwd).dispositions;
  if (!dispositions && deferredThisSession.size === 0) return diagnostics;
  return diagnostics.filter((d) => {
    const { strict, weak } = anchorsForDiagnostic(cwd, filePath, d, content);
    const isBlocking = d.semantic === "blocking";
    if (!isBlocking && deferredThisSession.has(deferredKey(cwd, weak))) {
      return false;
    }
    if (dispositions?.[strict]?.disposition === "false-positive") return false;
    if (!isBlocking && dispositions?.[weak]?.disposition === "suppress") {
      return false;
    }
    return true;
  });
}

export function applyWeakDispositions<T extends DispositionCandidate>(
  diagnostics: T[],
  cwd: string,
  filePath: string,
): T[] {
  if (!diagnostics.length) return diagnostics;
  const dispositions = readState(cwd).dispositions;
  if (!dispositions && deferredThisSession.size === 0) return diagnostics;
  return diagnostics.filter((d) => {
    if (d.semantic === "blocking") return true;
    const weak = computeWeakAnchor({
      cwd,
      filePath,
      tool: d.tool,
      rule: d.rule,
      message: d.message,
      line: d.line,
    });
    if (deferredThisSession.has(deferredKey(cwd, weak))) return false;
    if (dispositions?.[weak]?.disposition === "suppress") return false;
    return true;
  });
}

export function applyDispositionsMultiFile<T extends DispositionCandidate>(
  diagnostics: T[],
  cwd: string,
  filePathOf: (diagnostic: T) => string,
): T[] {
  if (!diagnostics.length) return diagnostics;
  const dispositions = readState(cwd).dispositions;
  if (!dispositions && deferredThisSession.size === 0) return diagnostics;
  const groups = new Map<string, T[]>();
  for (const d of diagnostics) {
    const filePath = filePathOf(d);
    const group = groups.get(filePath);
    if (group) group.push(d);
    else groups.set(filePath, [d]);
  }
  const kept = new Set<T>();
  for (const [filePath, group] of groups) {
    let content = "";
    try {
      content = multiFileReadFileSync(filePath, "utf-8");
    } catch {}
    for (const d of applyDispositions(group, cwd, filePath, content)) {
      kept.add(d);
    }
  }
  return diagnostics.filter((d) => kept.has(d));
}
