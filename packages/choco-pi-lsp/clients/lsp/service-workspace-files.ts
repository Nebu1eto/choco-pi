import * as nodeFs from "node:fs";
import path from "node:path";
import { getProjectIgnoreMatcher, isExcludedDirName } from "../file-utils.ts";
import { isAtOrAboveHomeDir } from "../path-utils.ts";
import { getServersForFileWithConfig } from "./config.ts";
import { getMaxWorkspaceDiagnosticFiles } from "./service-tunables.ts";
import type { SweepIndexGate } from "./service-types.ts";

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

export async function collectWorkspaceDiagnosticFiles(
  root: string,
  maxFiles: number = getMaxWorkspaceDiagnosticFiles(),
  signal?: AbortSignal,
  homeDir?: string,
): Promise<string[]> {
  const files: string[] = [];
  if (isAtOrAboveHomeDir(root, homeDir)) return files;
  const ignoreMatcher = getProjectIgnoreMatcher(root);
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
