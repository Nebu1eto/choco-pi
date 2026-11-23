/**
 * Workspace sweep file collection, per-server grouping, and the sweep index gate.
 *
 * Extracted from `clients/lsp/index.ts`; behavior is unchanged.
 */

import * as nodeFs from "node:fs";
import path from "node:path";
import { getProjectIgnoreMatcher, isExcludedDirName } from "../file-utils.ts";
import { isAtOrAboveHomeDir } from "../path-utils.ts";
import { getServersForFileWithConfig } from "./config.ts";
import { getMaxWorkspaceDiagnosticFiles } from "./service-tunables.ts";
import type { SweepIndexGate } from "./service-types.ts";

/**
 * Group files by their primary language server id (#387/#631 — extracted
 * from `runWorkspaceDiagnostics`'s inline grouping so other callers, e.g.
 * `lsp_diagnostics`' batch/directory scan in tools/lsp-diagnostics.ts, can
 * share the exact same server-affinity key instead of hand-copying it).
 * `multiServer` flags a group containing at least one file with more than
 * one attached server (primary + auxiliary) — callers that care about that
 * distinction (the workspace-pull fast path below) can act on it; callers
 * that don't (a plain per-file touch) can ignore it.
 */
export function groupFilesByPrimaryServer(
  files: readonly string[],
): Array<{ files: string[]; multiServer: boolean }> {
  const byServer = new Map<string, { files: string[]; multiServer: boolean }>();
  for (const filePath of files) {
    const servers = getServersForFileWithConfig(filePath);
    const primary = servers[0]?.id ?? "none";
    const group = byServer.get(primary);
    if (group) {
      group.files.push(filePath);
      if (servers.length > 1) group.multiServer = true;
    } else {
      byServer.set(primary, {
        files: [filePath],
        multiServer: servers.length > 1,
      });
    }
  }
  return [...byServer.values()];
}

/** Create a fresh, empty {@link SweepIndexGate} for one `runWorkspaceDiagnostics` call. */
export function createSweepIndexGate(): SweepIndexGate {
  const seen = new Set<string>();
  return {
    consumeFirstTouch(serverId: string): boolean {
      if (seen.has(serverId)) return false;
      seen.add(serverId);
      return true;
    },
  };
}

/**
 * Run one worker per server group (#387/#631): at most one in-flight
 * `processGroup` call per group at a time — each group's own callback is
 * responsible for iterating its files serially, this scheduler never starts
 * a second concurrent call into the same group — parallelized ACROSS
 * distinct groups up to `concurrency` workers. This is the exact scheduling
 * shape `runWorkspaceDiagnostics` (the engine behind `diagnostics_report
 * mode=full`) has used since #387 to avoid flooding a single-threaded LSP
 * server with concurrent touches that only queue server-side instead of
 * parallelizing (observed: 51/123 files "timed out" purely from queue
 * position in a flat pool) — extracted here so `lsp_diagnostics`' batch/
 * directory scan (tools/lsp-diagnostics.ts, #631) can share the identical
 * property instead of running a flat, server-oblivious bounded pool.
 *
 * `concurrency` caps how many DISTINCT groups run at once, not how many
 * files run at once — a single-language batch (one group, the common case)
 * becomes effectively serial for that group regardless of `concurrency`.
 * That is the intended #387 behavior, not something to work around.
 *
 * `processGroup` receives the whole group (not just `.files`) so a caller
 * that cares about `multiServer` (e.g. the workspace-pull fast path below,
 * which only applies to a single-server group) can still act on it; a
 * caller that doesn't can just destructure `.files`.
 */
export async function runPerServerGroups<
  G extends { files: readonly string[]; multiServer?: boolean },
>(
  groups: readonly G[],
  concurrency: number,
  processGroup: (group: G) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let nextGroup = 0;
  const workers = Math.min(Math.max(1, concurrency), groups.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (!signal?.aborted) {
        const gi = nextGroup;
        nextGroup += 1;
        if (gi >= groups.length) break;
        await processGroup(groups[gi]!);
      }
      return true;
    }),
  );
}

/**
 * Async, event-loop-yielding walk of the workspace to find LSP-supported source
 * files. Uses `fs.promises.readdir` so each directory read hands control back to
 * the loop — a synchronous `readdirSync` recursion blocks the loop for the whole
 * O(N) enumeration (~44ms at 1.4k files, scaling linearly on monorepos).
 *
 * Directory/file exclusion goes through the SAME ignore matcher every other scan
 * surface uses: `isExcludedDirName` for default dependency/build dirs plus the
 * project's `.choco-pi-lsp.json` / `.gitignore` patterns via `getProjectIgnoreMatcher`.
 * Previously this walk used its own hardcoded skip-dir set, which silently
 * dropped user `"ignore": [...]` patterns and diverged from the canonical list
 * (#243). The walk is also hard-capped (#250).
 */
export async function collectWorkspaceDiagnosticFiles(
  root: string,
  maxFiles: number = getMaxWorkspaceDiagnosticFiles(),
  signal?: AbortSignal,
  homeDir?: string,
): Promise<string[]> {
  const files: string[] = [];
  // #747/#250: the 5000-file cap alone bounds total work, but from a cwd at or
  // above $HOME the walk still traverses (and pulls diagnostics for) 5000 files
  // spread across every unrelated repo under home. Refuse outright — walking
  // nothing is the honest result; the caller (runWorkspaceDiagnostics →
  // tools/diagnostics-report.ts) renders "unsafe root" so an empty sweep never
  // reads as a clean project. Same ceiling as fresh-fetch.ts / the cheap-tier
  // scanner.
  if (isAtOrAboveHomeDir(root, homeDir)) return files;
  const ignoreMatcher = getProjectIgnoreMatcher(root);
  // #703: prime the tracked-files set once before the walk so a tracked file
  // matching a `.gitignore`/global pattern still gets its workspace
  // diagnostics pulled. Fail-open on no-git/spawn failure.
  await ignoreMatcher.ensureTrackedIndex();
  async function walk(current: string): Promise<void> {
    if (signal?.aborted || files.length >= maxFiles) return;
    let entries: nodeFs.Dirent[];
    try {
      entries = await nodeFs.promises.readdir(current, {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (signal?.aborted || files.length >= maxFiles) return;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (isExcludedDirName(entry.name)) continue;
        if (ignoreMatcher.isIgnored(full, true)) continue;
        await walk(full);
      } else if (
        entry.isFile() &&
        !ignoreMatcher.isIgnored(full, false) &&
        getServersForFileWithConfig(full).length > 0
      ) {
        files.push(full);
      }
    }
  }
  await walk(root);
  return files;
}
