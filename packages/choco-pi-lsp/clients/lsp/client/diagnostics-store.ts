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

const PULL_SOURCE_KEY_SEPARATOR = "\u0000";
const BARE_PULL_SOURCE = "";

export function pullSourceKey(normalizedPath: string, identifier: string | undefined): string {
  return identifier === undefined
    ? normalizedPath
    : `${normalizedPath}${PULL_SOURCE_KEY_SEPARATOR}${identifier}`;
}

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

export function pullGenerationFor(state: LSPClientState, normalizedPath: string): number {
  return state.pullGenerations?.get(normalizedPath) ?? 0;
}

function bumpPullGeneration(state: LSPClientState, normalizedPath: string): void {
  if (!state.pullGenerations) state.pullGenerations = new Map();
  state.pullGenerations.set(normalizedPath, (state.pullGenerations.get(normalizedPath) ?? 0) + 1);
}

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

export function pullDiagnosticSources(state: LSPClientState): (string | undefined)[] {
  const identifiers = new Set<string>();
  for (const registration of state.dynamicRegistrations?.values() ?? []) {
    if (registration.method !== "textDocument/diagnostic") continue;
    if (registration.identifier) identifiers.add(registration.identifier);
  }
  return [undefined, ...[...identifiers].sort((a, b) => a.localeCompare(b))];
}

export function bumpDiagnosticsVersion(state: LSPClientState, normalizedPath: string): void {
  state.diagnosticsVersion += 1;
  state.diagnosticsVersionsByPath?.set(normalizedPath, state.diagnosticsVersion);
}

export function diagnosticsVersionForPath(state: LSPClientState, normalizedPath: string): number {
  return state.diagnosticsVersionsByPath?.get(normalizedPath) ?? 0;
}

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
  state.diagnosticBindings?.delete(normalizedPath);
  state.diagnosticsVersionsByPath?.delete(normalizedPath);
  for (const key of pullSourceKeysForPath(state, normalizedPath)) {
    state.pullResultIds?.delete(key);
  }
  state.documentPullDiagnosticsBySource?.delete(normalizedPath);
  bumpPullGeneration(state, normalizedPath);
  state.workspacePullResultCache?.delete(normalizedPath);
  legacy.diagnostics?.delete(normalizedPath);
  legacy.diagnosticTimestamps?.delete(normalizedPath);
}

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
