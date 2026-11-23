/**
 * Per-path diagnostics state: push/pull source merging, pull generations, diagnostics versions, and clearing.
 */
import { logLatency } from "../../latency-logger.ts";
import type { LegacyDiagnosticCacheState, LegacyDiagnosticsState } from "./schemas.ts";
import type { LSPClientState, LSPDiagnostic } from "./types.ts";

export function stripDiagnosticNoiseLines(message: string): string {
  const cleaned = message
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (/^for further information visit\b/i.test(trimmed)) return false;
      if (/^https?:\/\/\S+$/i.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .trim();
  return cleaned || message.trim() || message;
}

function normalizeLspDiagnostic(diagnostic: LSPDiagnostic): LSPDiagnostic {
  const message = stripDiagnosticNoiseLines(diagnostic.message);
  return message === diagnostic.message ? diagnostic : { ...diagnostic, message };
}

export function normalizeLspDiagnostics(diagnostics: LSPDiagnostic[]): LSPDiagnostic[] {
  return diagnostics.map(normalizeLspDiagnostic);
}

/**
 * Union of diagnostic lists, first occurrence wins, exact duplicates dropped.
 * Variadic since #1667 so the per-identifier pull sources merge through the
 * SAME key as the push/pull merge rather than growing a second dedupe rule.
 */
function mergeDiagnosticLists(...lists: (LSPDiagnostic[] | undefined)[]): LSPDiagnostic[] {
  const merged: LSPDiagnostic[] = [];
  const seen = new Set<string>();
  for (const diagnostic of lists.flatMap((list) => list ?? [])) {
    const key = [
      diagnostic.range.start.line,
      diagnostic.range.start.character,
      diagnostic.range.end.line,
      diagnostic.range.end.character,
      diagnostic.code ?? "",
      diagnostic.source ?? "",
      diagnostic.message,
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(diagnostic);
  }
  return merged;
}

export function getMergedDiagnosticsForPath(
  state: LSPClientState,
  normalizedPath: string,
): LSPDiagnostic[] {
  const legacy: LegacyDiagnosticsState = {
    diagnostics: undefined,
    ...state,
  };
  return mergeDiagnosticLists(
    state.pushDiagnostics?.get(normalizedPath) ?? legacy.diagnostics?.get(normalizedPath),
    state.documentPullDiagnostics?.get(normalizedPath),
  );
}

/**
 * #1667: per-source pull-diagnostic bookkeeping.
 *
 * A pull-mode server can expose several diagnostic SOURCES, each named by its
 * registration's `registerOptions.identifier` (Roslyn: syntax, semantic,
 * analyzers). Each source answers independently, with its own `resultId` and
 * its own findings, so per-path state that used to be a single slot has to
 * become one slot per (path, source):
 *
 *  - `pullResultIds` keys on `pullSourceKey(path, identifier)`, so an
 *    `unchanged` report is only ever answered against the id THAT source
 *    issued (#240/#1104 machinery, now per source).
 *  - `documentPullDiagnosticsBySource` holds each source's findings, and
 *    `documentPullDiagnostics` is their deduped union - recomputed whenever a
 *    source reports, so a fresh answer from one source never wipes another's.
 *
 * The bare (identifier-less) source keys on the plain path, so a single-source
 * server stores exactly what it stored before this change.
 */
// NUL is the one byte a filesystem path can never contain, so
// `path + SEP + identifier` is unambiguous: no path/identifier pair can
// produce the same key as a different pair, and the bare source's key (the
// plain path) can never collide with a named source's.
const PULL_SOURCE_KEY_SEPARATOR = "\u0000";
const BARE_PULL_SOURCE = "";

export function pullSourceKey(normalizedPath: string, identifier: string | undefined): string {
  return identifier === undefined
    ? normalizedPath
    : `${normalizedPath}${PULL_SOURCE_KEY_SEPARATOR}${identifier}`;
}

/** Every `pullResultIds` key belonging to a path - the bare key plus one per
 *  identifier. Used by the clear path so a resync drops EVERY source's basis. */
function pullSourceKeysForPath(state: LSPClientState, normalizedPath: string): string[] {
  const prefix = `${normalizedPath}${PULL_SOURCE_KEY_SEPARATOR}`;
  return [
    normalizedPath,
    ...[...(state.pullResultIds?.keys() ?? [])].filter((key) => key.startsWith(prefix)),
  ];
}

function pullSourcesFor(
  state: LSPClientState,
  normalizedPath: string,
): Map<string, LSPDiagnostic[]> {
  if (!state.documentPullDiagnosticsBySource) {
    state.documentPullDiagnosticsBySource = new Map();
  }
  let sources = state.documentPullDiagnosticsBySource.get(normalizedPath);
  if (!sources) {
    sources = new Map();
    state.documentPullDiagnosticsBySource.set(normalizedPath, sources);
  }
  return sources;
}

/** This source's currently stored findings for a path - what an `unchanged`
 *  report inherits. Falls back to the whole per-path list when the source map
 *  has no entry yet, so a state that pulled before this change (or a caller
 *  that seeded `documentPullDiagnostics` directly) still inherits correctly. */
export function pullSourceDiagnostics(
  state: LSPClientState,
  normalizedPath: string,
  identifier: string | undefined,
): LSPDiagnostic[] {
  const sources = state.documentPullDiagnosticsBySource?.get(normalizedPath);
  const stored = sources?.get(identifier ?? BARE_PULL_SOURCE);
  if (stored) return stored;
  return sources && sources.size > 0
    ? []
    : (state.documentPullDiagnostics.get(normalizedPath) ?? []);
}

/** Store one source's findings and republish the union to
 *  `documentPullDiagnostics`, which every reader outside this file uses. */
export function storePullSourceDiagnostics(
  state: LSPClientState,
  normalizedPath: string,
  identifier: string | undefined,
  diagnostics: LSPDiagnostic[],
): void {
  const sources = pullSourcesFor(state, normalizedPath);
  sources.set(identifier ?? BARE_PULL_SOURCE, diagnostics);
  state.documentPullDiagnostics.set(normalizedPath, mergeDiagnosticLists(...sources.values()));
}

/** #1667: the pull generation for a path. The fan-out deliberately lets losing
 *  pulls run to completion so their findings still reach the cache; a resync
 *  that lands first must win, so every late write re-checks this. */
export function pullGenerationFor(state: LSPClientState, normalizedPath: string): number {
  return state.pullGenerations?.get(normalizedPath) ?? 0;
}

function bumpPullGeneration(state: LSPClientState, normalizedPath: string): void {
  if (!state.pullGenerations) state.pullGenerations = new Map();
  state.pullGenerations.set(normalizedPath, (state.pullGenerations.get(normalizedPath) ?? 0) + 1);
}

/** #1667: claim the newest-request slot for a source and return the claim.
 *  Called at REQUEST time; `isNewestPullRequest` re-checks it at WRITE time so
 *  a slow answer from an earlier fan-out cannot overwrite a newer one's. */
export function claimPullRequestSequence(state: LSPClientState, sourceKey: string): number {
  if (!state.pullRequestSequences) state.pullRequestSequences = new Map();
  const next = (state.pullRequestSequences.get(sourceKey) ?? 0) + 1;
  state.pullRequestSequences.set(sourceKey, next);
  return next;
}

export function isNewestPullRequest(
  state: LSPClientState,
  sourceKey: string,
  sequence: number,
): boolean {
  return (state.pullRequestSequences?.get(sourceKey) ?? 0) === sequence;
}

/**
 * #1667: drop every trace of a diagnostic source the server just unregistered.
 *
 * `client/unregisterCapability` retires a source, but its findings sit in
 * `documentPullDiagnosticsBySource` and its resultId in `pullResultIds`, so
 * without this the union keeps serving a retired source's diagnostics until
 * something resyncs the file. Roslyn and vtsls re-register their sources on
 * solution reload, which is exactly when the old source's findings are stale.
 *
 * Purges the source's slice from every path and republishes each affected
 * path's union, so the removal is visible on the next read rather than only
 * after the next pull.
 */
export function retirePullSource(state: LSPClientState, identifier: string): void {
  const suffix = `${PULL_SOURCE_KEY_SEPARATOR}${identifier}`;
  for (const source of [state.pullResultIds, state.pullRequestSequences]) {
    if (!source) continue;
    for (const key of source.keys()) {
      if (key.endsWith(suffix)) source.delete(key);
    }
  }
  for (const [normalizedPath, sources] of state.documentPullDiagnosticsBySource ?? []) {
    if (!sources.delete(identifier)) continue;
    state.documentPullDiagnostics.set(normalizedPath, mergeDiagnosticLists(...sources.values()));
    bumpDiagnosticsVersion(state, normalizedPath);
    state.diagnosticEmitter.emit("diagnostics", normalizedPath);
  }
}

/**
 * #1667: the diagnostic sources to pull for a document - always the bare
 * request (a server may answer it even while registering named sources, and it
 * is the ONLY request a single-source server understands), plus one per
 * distinct `identifier` on a live `textDocument/diagnostic` registration.
 *
 * Derived from `dynamicRegistrations` on every call rather than cached in a
 * parallel list: the registration map is the single source of truth, and
 * `client/unregisterCapability` must be able to retire a source immediately.
 */
export function pullDiagnosticSources(state: LSPClientState): (string | undefined)[] {
  const identifiers = new Set<string>();
  for (const registration of state.dynamicRegistrations?.values() ?? []) {
    if (registration.method !== "textDocument/diagnostic") continue;
    if (registration.identifier) identifiers.add(registration.identifier);
  }
  // Sorted for a stable, reproducible request order in logs and tests; the
  // fan-out is parallel, so order carries no priority.
  return [undefined, ...[...identifiers].sort((a, b) => a.localeCompare(b))];
}

/** #1531: bump the client-global diagnostics counter and stamp the path it was
 * bumped FOR. The single seam every "fresh diagnostics stored" site goes
 * through, so the per-path stamp can never drift from the global counter. */
export function bumpDiagnosticsVersion(state: LSPClientState, normalizedPath: string): void {
  state.diagnosticsVersion += 1;
  state.diagnosticsVersionsByPath?.set(normalizedPath, state.diagnosticsVersion);
}

/** #1531: the global counter's value when diagnostics were last stored for
 * `normalizedPath`, or 0 when nothing is stored. 0 is a safe floor because the
 * counter starts at 0 and only ever increases, so any later publication for the
 * path compares greater than a baseline read while it was absent. */
export function diagnosticsVersionForPath(state: LSPClientState, normalizedPath: string): number {
  return state.diagnosticsVersionsByPath?.get(normalizedPath) ?? 0;
}

/** Exported for tests: the quiet-window timer cancel on clear/resync is the
 * headline #1412 safety property (a stale versionless publication must never
 * land after the document content changed). */
export function clearDiagnosticsForPath(state: LSPClientState, normalizedPath: string): void {
  const legacy: LegacyDiagnosticCacheState = {
    diagnostics: undefined,
    diagnosticTimestamps: undefined,
    ...state,
  };
  state.pushDiagnostics?.delete(normalizedPath);
  const pending = state.pendingDiagnostics?.get(normalizedPath);
  if (pending) clearTimeout(pending);
  state.pendingDiagnostics?.delete(normalizedPath);
  state.pushDiagnosticTimestamps?.delete(normalizedPath);
  state.documentPullDiagnostics?.delete(normalizedPath);
  state.documentPullDiagnosticTimestamps?.delete(normalizedPath);
  state.diagnosticDocVersions?.delete(normalizedPath);
  // #1095: a cleared path must never serve a stale content binding alongside a
  // later publish — drop it with the diagnostics it described. (The last-sent
  // `documentContentHashes` record is intentionally retained: it describes what
  // we sent, which the NEXT publish for that version still needs to bind to.)
  state.diagnosticBindings?.delete(normalizedPath);
  // #1531: the per-path publication stamp describes diagnostics that no longer
  // exist — drop it with them. Safe because the stamps hold the GLOBAL counter's
  // value: a baseline captured before this clear still compares less than any
  // later publication for the path, so dropping the entry cannot manufacture a
  // missed answer.
  state.diagnosticsVersionsByPath?.delete(normalizedPath);
  // #1104: a resync invalidates any `unchanged`-report basis too — the next
  // pull must not inherit a resultId/contentHash computed against the
  // content this resync just replaced.
  // #1667: every SOURCE's basis, not just the bare one - a multi-source server
  // holds one resultId per identifier, and leaving even one behind lets the
  // next pull inherit against content this resync replaced.
  for (const key of pullSourceKeysForPath(state, normalizedPath)) {
    state.pullResultIds?.delete(key);
  }
  // `pullRequestSequences` is deliberately NOT cleared here. It is a
  // monotonic per-source counter, and resetting it would let a request issued
  // BEFORE this resync claim the same number as one issued after, so the stale
  // answer would pass the newest-request check. The two guards cover different
  // cases and neither subsumes the other: the generation bump below invalidates
  // in-flight work when nothing newer was requested, and the sequence stamp
  // invalidates it when something newer was.
  state.documentPullDiagnosticsBySource?.delete(normalizedPath);
  // #1667: invalidate any pull still in flight for this path. The fan-out lets
  // losing pulls run to completion so their findings still reach the cache;
  // without this bump one of them could resurrect what this resync cleared.
  bumpPullGeneration(state, normalizedPath);
  state.workspacePullResultCache?.delete(normalizedPath);
  legacy.diagnostics?.delete(normalizedPath);
  legacy.diagnosticTimestamps?.delete(normalizedPath);
}

/**
 * #1639: `durationMs` measures the PULL SETTLE ITSELF — the caller passes how
 * long `clientRequestPullDiagnostics` (plus any retries) took to resolve
 * `found`/`clean` — never time-since-didOpen. Document age is a genuinely
 * useful signal but a DIFFERENT one; it stays under its own honest name in
 * `metadata.elapsedSinceDidOpenMs`, exactly like the push-path `logSequence`
 * above already does. Before this fix the top-level field carried the same
 * age value pull requests use for retry-budget bookkeeping, so a session's
 * latency percentiles for this phase read multi-second document lifetimes as
 * millisecond operation costs (147/239 records read >60s "durations" for
 * settles that took milliseconds).
 *
 * `version` reads the real tracked version from `diagnosticsVersionsByPath`
 * (bumped by `bumpDiagnosticsVersion` right after this pull's diagnostics
 * were stored — see the `documentPullDiagnostics.set` call above it) instead
 * of a hardcoded `null`, which made every pull settle look "unbound" to
 * staleness forensics even though this codebase already tracks a real
 * version for the path. Falls back to the explicit `"pull-unversioned"`
 * marker only when nothing has been stored yet, so "no data" is never
 * confused with "confirmed no version" (`null`).
 *
 * `pullSettleSource` distinguishes the two legitimate call paths that can
 * both settle a pull for the same file close together: a real
 * content-collecting touch ("pull") and `ensureWarmForSweep`'s warm-up-only
 * touch ("pull-warmup"), which runs a real round trip purely to prove the
 * server answers before the sweep's real touch immediately follows it.
 * Before this fix both logged identically as settleSource "pull", so a
 * session with warm-up sweeps double-counted: 239 records against 145
 * touches, with same-file pairs ~60ms apart and near-identical document
 * ages — the warm-up settle and the real touch's settle for the same file.
 */
export function logTypeScriptPullSettle(
  state: LSPClientState,
  normalizedPath: string,
  durationMs: number,
  pullSettleSource: "pull" | "pull-warmup",
): void {
  if (state.serverId !== "typescript") return;
  const diagnostics = state.documentPullDiagnostics.get(normalizedPath) ?? [];
  const elapsedSinceDidOpenMs = Math.max(
    0,
    Date.now() - (state.documentOpenedAt.get(normalizedPath) ?? Date.now()),
  );
  const diagnosticCodes = [
    ...new Set(
      diagnostics
        .map((diagnostic) => diagnostic.code)
        .filter((code): code is string | number => code !== undefined)
        .map(String),
    ),
  ].slice(0, 8);
  const trackedVersion = state.diagnosticsVersionsByPath?.get(normalizedPath);
  logLatency({
    type: "phase",
    phase: "lsp_typescript_diagnostic_sequence",
    filePath: normalizedPath,
    durationMs,
    metadata: {
      launchVariant: state.launchVariant ?? "unknown",
      publicationIndex: state.diagnosticPublicationCounts.get(normalizedPath) ?? 0,
      version: trackedVersion ?? "pull-unversioned",
      diagnosticCount: diagnostics.length,
      diagnosticCodes,
      elapsedSinceDidOpenMs,
      settledReturn: true,
      settleSource: pullSettleSource,
    },
  });
}
