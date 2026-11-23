import { type LspDictionaryValue } from "./runtime-guards.ts";
import { idleEvictionTimersSuspended, registerIdleTimerRelease } from "./idle-timer-release.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logLatency } from "./latency-logger.ts";
import { isAtOrAboveHomeDir, nameMatchesMarkerGlob, walkUpDirs } from "./path-utils.ts";

const MAX_WALK_DEPTH = 64;

const CHOCO_PI_LSP_CONFIG_BASENAMES = [".choco-pi-lsp.json", "choco-pi-lsp.json"] as const;

export interface DirectoryMarkers {
  dir: string;
  dirMtimeMs: number;
  entryNames: ReadonlySet<string>;
  entryFileNames: ReadonlySet<string>;
  piLensConfigPath: string | undefined;
  tsconfigPath: string | undefined;
  packageJsonPath: string | undefined;
  pnpmWorkspaceYamlPath: string | undefined;
  cargoTomlPath: string | undefined;
  goWorkPath: string | undefined;
  chartYamlPath: string | undefined;
}

interface DirCacheEntry {
  dirMtimeMs: number;
  markers: DirectoryMarkers;
  lastUsedAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

const dirMarkerCache = new Map<string, DirCacheEntry>();

type WalkCacheEntry = {
  dir: string | undefined;
  dirMtimes: Array<{ dir: string; mtimeMs: number }>;
  lastUsedAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
};
const walkCache = new Map<string, WalkCacheEntry>();
const TOPOLOGY_MAX_DIR_ENTRIES = 256;
const TOPOLOGY_MAX_WALK_ENTRIES = 512;
const TOPOLOGY_IDLE_EVICT_MS_DEFAULT = 20 * 60_000;

function topologyIdleEvictMs(): number {
  const value = Number.parseInt(
    process.env.CHOCO_PI_LSP_WORKSPACE_TOPOLOGY_IDLE_EVICT_MS ?? "",
    10,
  );
  return Number.isSafeInteger(value) && value > 0 ? value : TOPOLOGY_IDLE_EVICT_MS_DEFAULT;
}

function deleteDirMarker(key: string): void {
  const entry = dirMarkerCache.get(key);
  if (entry?.idleTimer) clearTimeout(entry.idleTimer);
  dirMarkerCache.delete(key);
}

function deleteWalk(key: string): void {
  const entry = walkCache.get(key);
  if (entry?.idleTimer) clearTimeout(entry.idleTimer);
  walkCache.delete(key);
}

function touchDirMarker(key: string, entry: DirCacheEntry): void {
  entry.lastUsedAt = Date.now();
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = undefined;
  if (idleEvictionTimersSuspended()) return;
  const stamp = entry.lastUsedAt;
  entry.idleTimer = setTimeout(() => {
    if (dirMarkerCache.get(key) === entry && entry.lastUsedAt === stamp) deleteDirMarker(key);
  }, topologyIdleEvictMs());
  entry.idleTimer.unref?.();
}

function touchWalk(key: string, entry: WalkCacheEntry): void {
  entry.lastUsedAt = Date.now();
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = undefined;
  if (idleEvictionTimersSuspended()) return;
  const stamp = entry.lastUsedAt;
  entry.idleTimer = setTimeout(() => {
    if (walkCache.get(key) === entry && entry.lastUsedAt === stamp) deleteWalk(key);
  }, topologyIdleEvictMs());
  entry.idleTimer.unref?.();
}

export function resetWorkspaceTopology(): void {
  for (const key of dirMarkerCache.keys()) deleteDirMarker(key);
  for (const key of walkCache.keys()) deleteWalk(key);
}

registerIdleTimerRelease(() => releaseWorkspaceTopologyIdleTimers());

export function releaseWorkspaceTopologyIdleTimers(): void {
  for (const entry of dirMarkerCache.values()) {
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
  for (const entry of walkCache.values()) {
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
}

function safeDirMtimeMs(dir: string): number {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return -1;
  }
}

function safeIsFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function getDirectoryMarkers(dir: string): DirectoryMarkers {
  const resolvedDir = path.resolve(dir);
  const dirMtimeMs = safeDirMtimeMs(resolvedDir);
  const cached = dirMarkerCache.get(resolvedDir);
  if (cached && cached.dirMtimeMs === dirMtimeMs) {
    touchDirMarker(resolvedDir, cached);
    return cached.markers;
  }

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const present = new Set(entries.map((e) => e.name));
  const fileNames = new Set(
    entries.filter((entry) => entry.isFile() || entry.isSymbolicLink()).map((entry) => entry.name),
  );

  const resolveMarker = (basename: string): string | undefined => {
    if (!present.has(basename)) return undefined;
    const candidate = path.join(resolvedDir, basename);
    return safeIsFile(candidate) ? candidate : undefined;
  };

  const piLensConfigPath =
    resolveMarker(CHOCO_PI_LSP_CONFIG_BASENAMES[0]) ??
    resolveMarker(CHOCO_PI_LSP_CONFIG_BASENAMES[1]);

  const markers: DirectoryMarkers = {
    dir: resolvedDir,
    dirMtimeMs,
    entryNames: present,
    entryFileNames: fileNames,
    piLensConfigPath,
    tsconfigPath: resolveMarker("tsconfig.json"),
    packageJsonPath: resolveMarker("package.json"),
    pnpmWorkspaceYamlPath: resolveMarker("pnpm-workspace.yaml"),
    cargoTomlPath: resolveMarker("Cargo.toml"),
    goWorkPath: resolveMarker("go.work"),
    chartYamlPath: resolveMarker("Chart.yaml"),
  };
  const entry: DirCacheEntry = { dirMtimeMs, markers, lastUsedAt: Date.now() };
  dirMarkerCache.set(resolvedDir, entry);
  touchDirMarker(resolvedDir, entry);
  while (dirMarkerCache.size > TOPOLOGY_MAX_DIR_ENTRIES) {
    const victim = [...dirMarkerCache.entries()].sort(
      ([, a], [, b]) => a.lastUsedAt - b.lastUsedAt,
    )[0];
    if (!victim) break;
    deleteDirMarker(victim[0]);
  }
  return markers;
}

function walkCacheKey(startDir: string, markerKey: string): string {
  return `${path.resolve(startDir)}\0${markerKey}`;
}

function walkStillFresh(dirMtimes: Array<{ dir: string; mtimeMs: number }>): boolean {
  return dirMtimes.every(({ dir, mtimeMs }) => safeDirMtimeMs(dir) === mtimeMs);
}

function walkToNearestMatch(
  startDir: string,
  cacheSuffix: string,
  matches: (markers: DirectoryMarkers) => boolean,

  capMetadata: Record<string, LspDictionaryValue>,
  homeDir: string,
): string | undefined {
  const key = walkCacheKey(startDir, cacheSuffix);
  const cached = walkCache.get(key);
  if (cached && walkStillFresh(cached.dirMtimes)) {
    touchWalk(key, cached);
    return cached.dir;
  }

  const dirMtimes: Array<{ dir: string; mtimeMs: number }> = [];
  let found: string | undefined;
  let depth = 0;
  for (const dir of walkUpDirs(startDir)) {
    if (isAtOrAboveHomeDir(dir, homeDir)) break;
    if (depth >= MAX_WALK_DEPTH) {
      logLatency({
        type: "phase",
        filePath: startDir,
        phase: "workspace-topology-walk-cap",
        durationMs: 0,
        metadata: { ...capMetadata, depth, homeDir },
      });
      break;
    }
    const markers = getDirectoryMarkers(dir);
    dirMtimes.push({ dir, mtimeMs: markers.dirMtimeMs });
    if (matches(markers)) {
      found = dir;
      break;
    }
    depth += 1;
  }

  const entry: WalkCacheEntry = { dir: found, dirMtimes, lastUsedAt: Date.now() };
  walkCache.set(key, entry);
  touchWalk(key, entry);
  while (walkCache.size > TOPOLOGY_MAX_WALK_ENTRIES) {
    const victim = [...walkCache.entries()].sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt)[0];
    if (!victim) break;
    deleteWalk(victim[0]);
  }
  return found;
}

export function findNearestDirWithMarker(
  startDir: string,
  markerKey: keyof Omit<DirectoryMarkers, "dir" | "dirMtimeMs" | "entryNames" | "entryFileNames">,
  homeDir: string = os.homedir(),
): string | undefined {
  return walkToNearestMatch(
    startDir,
    markerKey,
    (markers) => Boolean(markers[markerKey]),
    { markerKey },
    homeDir,
  );
}

function hasBasenameMarker(markers: DirectoryMarkers, basename: string): boolean {
  if (basename.includes("/") || basename.includes("\\")) {
    return fs.existsSync(path.join(markers.dir, basename));
  }
  if (basename.includes("*")) {
    return [...markers.entryFileNames].some((entryName) =>
      nameMatchesMarkerGlob(entryName, basename),
    );
  }
  return markers.entryNames.has(basename);
}

export function findNearestDirWithAnyBasename(
  startDir: string,
  basenames: readonly string[],
  homeDir: string = os.homedir(),
): string | undefined {
  if (basenames.length === 0) return undefined;
  return walkToNearestMatch(
    startDir,
    `any:${basenames.join(String.fromCodePoint(1))}`,
    (markers) => basenames.some((basename) => hasBasenameMarker(markers, basename)),
    { basenames },
    homeDir,
  );
}

export interface PiLensConfigMarker {
  path: string;
  dir: string;
  mtimeMs: number;
  size: number;
}

export function findPiLensConfigMarkerInDir(dir: string): PiLensConfigMarker | undefined {
  const markers = getDirectoryMarkers(dir);
  if (!markers.piLensConfigPath) return undefined;
  const stat = (() => {
    try {
      return fs.statSync(markers.piLensConfigPath!);
    } catch {
      return undefined;
    }
  })();
  if (!stat?.isFile()) return undefined;
  return {
    path: markers.piLensConfigPath,
    dir: markers.dir,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
}

export function findGoverningTsconfigDir(
  startDir: string,
  homeDir: string = os.homedir(),
): string | undefined {
  return findNearestDirWithMarker(startDir, "tsconfigPath", homeDir);
}

export interface WorkspaceManifestMarkers {
  hasPnpmWorkspaceYaml: boolean;
  hasGoWork: boolean;
  hasCargoToml: boolean;
  hasPackageJson: boolean;
}

export function getWorkspaceManifestMarkers(dir: string): WorkspaceManifestMarkers {
  const markers = getDirectoryMarkers(dir);
  return {
    hasPnpmWorkspaceYaml: markers.pnpmWorkspaceYamlPath !== undefined,
    hasGoWork: markers.goWorkPath !== undefined,
    hasCargoToml: markers.cargoTomlPath !== undefined,
    hasPackageJson: markers.packageJsonPath !== undefined,
  };
}
