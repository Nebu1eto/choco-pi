import * as path from "node:path";
import type { LSPDiagnostic } from "./client.ts";
import {
  fetchTsserverProjectIdentity,
  type TsserverProjectIdentity,
  type TsserverSyncCapableService,
} from "./tsserver-sync.ts";
import { toProjectRelativePath } from "../path-utils.ts";
import { logLatency } from "../latency-logger.ts";

export const INFERRED_PROJECT_MARKER =
  "not in any tsconfig project — checked with inferred settings";

const TS_PROJECT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const TYPESCRIPT_DIAGNOSTIC_SOURCES = new Set(["typescript", "ts", "tsserver"]);

export function isTsProjectFile(filePath: string): boolean {
  return TS_PROJECT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function isTypeScriptSourcedDiagnostic(d: LSPDiagnostic): boolean {
  return TYPESCRIPT_DIAGNOSTIC_SOURCES.has((d.source ?? "").toLowerCase());
}

export function suggestTsconfigInclude(filePath: string, cwd: string): string {
  const relative = toProjectRelativePath(filePath, cwd);
  if (path.posix.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) {
    const dir = relative.slice(0, relative.lastIndexOf("/"));
    return dir ? `${dir}/**` : relative;
  }
  const segments = relative.split("/").filter(Boolean);
  return segments.length > 1 ? `${segments[0]}/**` : relative;
}

export function inferredProjectNotice(filePath: string, cwd: string): string {
  return `[${INFERRED_PROJECT_MARKER}; add ${suggestTsconfigInclude(filePath, cwd)} to a tsconfig for authoritative checking]`;
}

export function applyInferredProjectDemotion(
  diagnostics: LSPDiagnostic[],
  filePath: string,
  cwd: string,
): LSPDiagnostic[] {
  if (!diagnostics.some(isDemotableDiagnostic)) return diagnostics;
  const notice = inferredProjectNotice(filePath, cwd);
  return diagnostics.map((d) =>
    isDemotableDiagnostic(d)
      ? { ...d, severity: 2 as const, message: `${d.message} ${notice}` }
      : d,
  );
}

function isDemotableDiagnostic(d: LSPDiagnostic): boolean {
  return d.severity === 1 && isTypeScriptSourcedDiagnostic(d);
}

export interface InferredProjectDemotionOptions {
  filePath: string;
  cwd: string;
  service: TsserverSyncCapableService;
  identityCache?: Map<string, TsserverProjectIdentity | undefined>;
  signal?: AbortSignal;
  fetchIdentity?: typeof fetchTsserverProjectIdentity;
}

export async function demoteInferredProjectDiagnostics(
  diagnostics: LSPDiagnostic[],
  options: InferredProjectDemotionOptions,
): Promise<LSPDiagnostic[]> {
  const { filePath, cwd, service } = options;
  if (!isTsProjectFile(filePath)) return diagnostics;
  if (!diagnostics.some(isDemotableDiagnostic)) return diagnostics;
  if (options.signal?.aborted) return diagnostics;

  const fetchIdentity = options.fetchIdentity ?? fetchTsserverProjectIdentity;
  const cache = options.identityCache;
  let identity: TsserverProjectIdentity | undefined;
  if (cache?.has(filePath)) {
    identity = cache.get(filePath);
  } else {
    identity = await fetchIdentity(service, filePath);
    cache?.set(filePath, identity);
  }

  if (identity?.projectKind !== "inferred") return diagnostics;
  return applyInferredProjectDemotion(diagnostics, filePath, cwd);
}

export const INFERRED_PROJECT_PROBE_BUDGET = 300;

export async function demoteInferredProjectSweepResults<
  T extends { filePath: string; diagnostics?: LSPDiagnostic[] },
>(
  results: T[],
  cwd: string,
  service: TsserverSyncCapableService,
  signal?: AbortSignal,
): Promise<T[]> {
  if (!service?.executeReadOnlyCommandOnLiveClient) {
    return results;
  }
  const startedAt = Date.now();
  const identityCache = new Map<string, TsserverProjectIdentity | undefined>();
  const out: T[] = [];
  let demotedFiles = 0;
  let demotedDiagnostics = 0;
  let budgetExhausted = false;
  let aborted = false;
  for (const result of results) {
    const diagnostics = result.diagnostics ?? [];
    if (signal?.aborted) {
      aborted = true;
      out.push(result);
      continue;
    }
    if (
      identityCache.size >= INFERRED_PROJECT_PROBE_BUDGET &&
      !identityCache.has(result.filePath)
    ) {
      budgetExhausted = true;
      out.push(result);
      continue;
    }
    const demoted = await demoteInferredProjectDiagnostics(diagnostics, {
      filePath: result.filePath,
      cwd,
      service,
      identityCache,
      signal,
    });
    if (demoted === diagnostics) {
      out.push(result);
      continue;
    }
    demotedFiles += 1;
    demotedDiagnostics += demoted.filter((d, i) => d !== diagnostics[i]).length;
    out.push({ ...result, diagnostics: demoted });
  }
  if (demotedFiles > 0 || budgetExhausted || aborted) {
    logLatency({
      type: "phase",
      phase: "lsp_inferred_project_demote",
      filePath: cwd,
      durationMs: Date.now() - startedAt,
      metadata: {
        filesConsidered: results.length,
        filesProbed: identityCache.size,
        demotedFiles,
        demotedDiagnostics,
        budgetExhausted,
        aborted,
      },
    });
  }
  return out;
}
