/**
 * installTool/ensureTool orchestration, tool environment, and catalog queries.
 */
import { nodeBinDirectory } from "@choco-pi/shared/node-runtime";
import fs from "node:fs/promises";
import path from "node:path";
import { isFullyQualified } from "../path-utils.ts";
import { assertInstallAllowed, projectTrustDenialReason } from "../project-trust.ts";
import { logSessionStart } from "../sessionstart-logger.ts";
import { resetSafeSpawnWindowsCommandCache } from "../safe-spawn.ts";
import { lastManagedInstallVersion, parsePinnedVersion } from "./command-probe.ts";
import { installArchiveTool } from "./install-archive.ts";
import {
  ensureInFlight,
  installAttempts,
  installFailureReasons,
  lastEnsureResolutionSource,
  noteInstallAttempt,
  noteInstallAttemptIfUnrecorded,
} from "./install-attempts.ts";
import { installGitHubTool } from "./install-github.ts";
import { TOOLS_DIR, acquireInstallLock } from "./install-lock.ts";
import { installMavenTool } from "./install-maven.ts";
import { installGemTool, installNpmTool, installPipTool } from "./install-packages.ts";
import { GITHUB_BIN_DIR } from "./installer-env.ts";
import {
  checkProbeCache,
  markProbeCacheChange,
  readProbeCache,
  resolvedPathCache,
  updateProbeCache,
} from "./probe-cache.ts";
import { TOOLS, type ToolDefinition } from "./tool-catalog.ts";
import { getToolPath, wasLastResolveTransient } from "./tool-resolution.ts";

async function finishInstallAttempt(
  toolId: string,
  ok: boolean,
  startedAt: number,
): Promise<boolean> {
  logSessionStart(
    `auto-install ${toolId}: ${ok ? "success" : "failed"} (${Date.now() - startedAt}ms)`,
  );
  // Every install strategy funnels its outcome through here, so this one write
  // records attempt-ness for all of them (#1500).
  noteInstallAttempt(
    toolId,
    ok ? "succeeded" : "failed",
    ok ? undefined : (installFailureReasons.get(toolId) ?? "install failed"),
  );
  if (ok) {
    // A prior availability probe may have cached ENOENT for this exact child
    // PATH. Make a successful mutation visible immediately rather than waiting
    // for the bounded negative-cache TTL or the next session reset (#1199).
    resetSafeSpawnWindowsCommandCache();
    // choco-pi fork: the madge managed-path memo reset is removed with
    // the dependency-checker (madge) client — see VENDORED.md.
  }
  return ok;
}

/**
 * Install a tool by ID
 */
export async function installTool(toolId: string): Promise<boolean> {
  if (process.env.CHOCO_PI_LSP_DISABLE_TOOL_INSTALL === "1") {
    installFailureReasons.set(
      toolId,
      "installation disabled by CHOCO_PI_LSP_DISABLE_TOOL_INSTALL=1",
    );
    noteInstallAttempt(
      toolId,
      "declined",
      "installation disabled by CHOCO_PI_LSP_DISABLE_TOOL_INSTALL=1",
    );
    logSessionStart(`auto-install ${toolId}: refused — CHOCO_PI_LSP_DISABLE_TOOL_INSTALL=1`);
    return false;
  }
  const tool = TOOLS.find((t) => t.id === toolId);
  if (!tool) {
    noteInstallAttempt(toolId, "declined", "unknown tool id");
    logSessionStart(`auto-install ${toolId}: unknown tool id`);
    return false;
  }

  const startedAt = Date.now();
  logSessionStart(
    `auto-install ${tool.id}: start strategy=${tool.installStrategy} package=${tool.packageName ?? "n/a"}`,
  );

  try {
    switch (tool.installStrategy) {
      case "npm": {
        if (!tool.packageName || !tool.binaryName) return false;
        const npmPath = await installNpmTool(tool.packageName, tool.binaryName);
        if (npmPath !== undefined) {
          // #1746 review F4: an install just resolved this package's range
          // against the registry, so record it as freshly checked. Otherwise a
          // new machine that installs 22 tools today has 22 unstamped tools,
          // and spends the next 22 sessions running `npm update` on packages
          // it installed minutes ago.
          //
          // Dynamic import, not a static one: managed-tool-refresh.ts imports
          // THIS module for the tool registry, and a static import back would
          // be a cycle. By the time this line runs the module graph is long
          // since evaluated, so the lazy import is safe and also keeps the
          // refresh module off the startup path.
          // SAFETY: The npm strategy guard above establishes packageName before this asynchronous callback is created.
          await import("./managed-tool-refresh.ts")
            .then((m) => m.stampManagedToolInstalled(tool.id, tool.packageName as string))
            .catch(() => {
              // Best-effort telemetry: a missing stamp costs one wasted
              // update later, never a wrong version, and must not fail the
              // install that just succeeded.
            });
        }
        return finishInstallAttempt(tool.id, npmPath !== undefined, startedAt);
      }

      case "pip": {
        if (!tool.packageName) return false;
        const pipPath = await installPipTool(tool.packageName);
        return finishInstallAttempt(tool.id, pipPath !== undefined, startedAt);
      }

      case "gem": {
        if (!tool.packageName) return false;
        const gemPath = await installGemTool(tool.packageName);
        return finishInstallAttempt(tool.id, gemPath !== undefined, startedAt);
      }

      case "github": {
        if (!tool.github) return false;
        const ghPath = await installGitHubTool(tool);
        return finishInstallAttempt(tool.id, ghPath !== undefined, startedAt);
      }

      case "maven": {
        if (!tool.maven) return false;
        const mavenPath = await installMavenTool(tool);
        return finishInstallAttempt(tool.id, mavenPath !== undefined, startedAt);
      }

      case "archive": {
        if (!tool.archive) return false;
        const archivePath = await installArchiveTool(tool);
        return finishInstallAttempt(tool.id, archivePath !== undefined, startedAt);
      }

      default:
        logSessionStart(`auto-install ${tool.id}: unsupported strategy`);
        return false;
    }
  } catch (err) {
    logSessionStart(
      // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
      `auto-install ${tool.id}: exception ${(err as Error).message} (${Date.now() - startedAt}ms)`,
    );
    return false;
  }
}

/**
 * Ensure a tool is installed (check first, install if missing).
 *
 * #1334 S5: when the pi host has actively denied project trust, the INSTALL
 * half is switched off here — the request degrades to the existing
 * `allowInstall:false` discovery-only path rather than failing outright, so an
 * already-present binary keeps working while nothing is downloaded or executed
 * on behalf of an untrusted project. A host with no trust surface at all
 * (`"unknown"`) is unaffected.
 */
export async function ensureTool(
  toolId: string,
  opts?: { forceReinstall?: boolean; allowInstall?: boolean },
): Promise<string | undefined> {
  if (opts?.allowInstall !== false && !assertInstallAllowed(`managed tool ensure: ${toolId}`)) {
    logSessionStart(
      `auto-install ensure ${toolId}: install gated — ${projectTrustDenialReason()}; discovery only`,
    );
    const denialReason = projectTrustDenialReason();
    const discovered = await ensureToolResolved(toolId, {
      ...opts,
      allowInstall: false,
    });
    // AFTER the discovery pass, which clears the per-attempt record on entry.
    noteInstallAttempt(toolId, "declined", `project trust: ${denialReason}`);
    return discovered;
  }
  return ensureToolResolved(toolId, opts);
}

async function ensureToolResolved(
  toolId: string,
  opts?: { forceReinstall?: boolean; allowInstall?: boolean },
): Promise<string | undefined> {
  installFailureReasons.delete(toolId);
  // A fresh ensure supersedes whatever the last one recorded, and the trust-gate
  // branch above deliberately keeps its `declined` record by never reaching here.
  installAttempts.delete(toolId);
  lastEnsureResolutionSource.delete(toolId);
  const cacheResolvedPath = (result: string | undefined): string | undefined => {
    if (result) {
      resolvedPathCache.set(toolId, result);
      void updateProbeCache(toolId, result, wasLastResolveTransient(toolId));
    }
    return result;
  };

  // forceReinstall: nuke caches, download from managed source, skip PATH entirely.
  // Used when a PATH-resolved tool proves broken at launch (e.g. broken symlink).
  // allowInstall:false wins over forceReinstall: caches are still cleared, but
  // the function falls back to discovery-only and never downloads.
  if (opts?.forceReinstall) {
    const ensureStartMs = Date.now();
    logSessionStart(`auto-install ensure ${toolId}: force reinstall — clearing caches`);

    // Clear in-memory session cache
    resolvedPathCache.delete(toolId);

    // Clear persistent probe cache entry so getToolPath won't return stale PATH result
    try {
      const probeCache = await readProbeCache();
      delete probeCache[toolId];
      markProbeCacheChange(toolId, null);
    } catch {
      // best-effort
    }

    if (opts.allowInstall === false) {
      noteInstallAttempt(toolId, "declined", "install disabled by caller");
      logSessionStart(
        `auto-install ensure ${toolId}: force reinstall blocked — install disabled, discovery only (${Date.now() - ensureStartMs}ms)`,
      );
      return cacheResolvedPath(await getToolPath(toolId));
    }
    if (process.env.CHOCO_PI_LSP_DISABLE_TOOL_INSTALL === "1") {
      installFailureReasons.set(
        toolId,
        "installation disabled by CHOCO_PI_LSP_DISABLE_TOOL_INSTALL=1",
      );
      noteInstallAttempt(
        toolId,
        "declined",
        "installation disabled by CHOCO_PI_LSP_DISABLE_TOOL_INSTALL=1",
      );
      logSessionStart(
        `auto-install ensure ${toolId}: refused — CHOCO_PI_LSP_DISABLE_TOOL_INSTALL=1`,
      );
      return undefined;
    }

    const lock = await acquireInstallLock();
    if (!lock.release) {
      noteInstallAttempt(toolId, "skipped", lock.reason ?? "install lock held");
      logSessionStart(`auto-install ensure ${toolId}: ${lock.reason}`);
      return undefined;
    }
    let installed: boolean;
    try {
      installed = await installTool(toolId);
    } finally {
      await lock.release();
    }
    if (!installed) {
      // installTool RAN. Whatever it recorded stands; otherwise this is a
      // genuine failure, which is what the caller needs to see (#1500).
      noteInstallAttemptIfUnrecorded(toolId, "failed", "install failed");
      logSessionStart(
        `auto-install ensure ${toolId}: force reinstall failed (${Date.now() - ensureStartMs}ms)`,
      );
      return undefined;
    }

    // Find the newly installed binary (github-local check now comes before PATH)
    const result = cacheResolvedPath(await getToolPath(toolId));
    if (result) {
      logSessionStart(
        `auto-install ensure ${toolId}: force reinstall success at ${result} (${Date.now() - ensureStartMs}ms)`,
      );
    }
    return result;
  }

  // Fast path 1: in-memory session cache — no I/O.
  const cached = resolvedPathCache.get(toolId);
  if (cached) {
    if (!isFullyQualified(cached)) {
      lastEnsureResolutionSource.set(toolId, "session-cache");
      return cached;
    }
    try {
      await fs.access(cached);
      lastEnsureResolutionSource.set(toolId, "session-cache");
      return cached;
    } catch {
      // The executor would report ENOENT for this cached positive. Evict it
      // before discovery so the failure heals on this call, not after restart.
    }
    resolvedPathCache.delete(toolId);
    const probeCache = await readProbeCache();
    delete probeCache[toolId];
    markProbeCacheChange(toolId, null);
    logSessionStart(`auto-install ensure ${toolId}: cached path disappeared; re-probing`);
  }

  // Fast path 2: persistent probe cache — fs.access + stat, no process spawn.
  const diskCached = await checkProbeCache(toolId);
  if (diskCached) {
    resolvedPathCache.set(toolId, diskCached);
    lastEnsureResolutionSource.set(toolId, "probe-cache");
    logSessionStart(`auto-install ensure ${toolId}: probe cache hit → ${diskCached}`);
    return diskCached;
  }

  // Coalesce the whole ensure operation, not just installation. Most startup
  // duplicates race while checking already-installed tools, before installTool()
  // would ever run. The key includes the install policy so a discovery-only
  // caller cannot accidentally inherit an install-allowed caller's download (or
  // vice versa).
  const inFlightKey = opts?.allowInstall === false ? `${toolId}:discovery-only` : toolId;
  const inFlight = ensureInFlight.get(inFlightKey);
  if (inFlight) {
    logSessionStart(`auto-install ensure ${toolId}: waiting for in-flight ensure (${inFlightKey})`);
    return inFlight;
  }

  const ensureStartMs = Date.now();
  const ensurePromise = (async () => {
    logSessionStart(`auto-install ensure ${toolId}: start`);

    // Check if already installed.
    const existingPath = await getToolPath(toolId);
    if (existingPath) {
      // Version-pin drift (#589): getToolPath() above just spawned
      // verifyToolBinary on the managed local install anyway (this is the
      // slow path — fast paths 1/2 above already returned before reaching
      // here), so lastManagedInstallVersion was populated for free if this
      // is a pinned npm tool. Compare it to the current pin and, on
      // mismatch, route through the EXISTING forceReinstall codepath rather
      // than resolving to a known-stale binary. Piggybacks entirely on the
      // probe-cache's ~once-per-24h/once-per-session cadence — no new spawn.
      const tool = TOOLS.find((t) => t.id === toolId);
      const pinnedVersion =
        tool?.installStrategy === "npm" && tool.packageName
          ? parsePinnedVersion(tool.packageName)
          : undefined;
      if (pinnedVersion) {
        const seenVersion = lastManagedInstallVersion.get(toolId);
        if (seenVersion && seenVersion !== pinnedVersion) {
          lastManagedInstallVersion.delete(toolId);
          logSessionStart(
            `auto-install ensure ${toolId}: version drift (installed ${seenVersion} != pinned ${pinnedVersion}) — forcing reinstall (${Date.now() - ensureStartMs}ms)`,
          );
          return ensureTool(toolId, {
            forceReinstall: true,
            allowInstall: opts?.allowInstall,
          });
        }
      }

      resolvedPathCache.set(toolId, existingPath);
      void updateProbeCache(toolId, existingPath, wasLastResolveTransient(toolId));
      lastEnsureResolutionSource.set(toolId, "path");
      logSessionStart(
        `auto-install ensure ${toolId}: already available at ${existingPath} (${Date.now() - ensureStartMs}ms)`,
      );
      return existingPath;
    }

    // Discovery and install are SEPARATE concerns. getToolPath() above already
    // probed PATH / npm-global / managed bin — offline-safe, no download. When the
    // caller forbids installs (allowInstall:false, e.g. CHOCO_PI_LSP_DISABLE_LSP_INSTALL=1)
    // we must still return a discovered binary and only skip the actual install.
    if (opts?.allowInstall === false) {
      noteInstallAttempt(toolId, "declined", "install disabled by caller");
      logSessionStart(
        `auto-install ensure ${toolId}: install disabled — discovery only, not found (${Date.now() - ensureStartMs}ms)`,
      );
      return undefined;
    }
    if (process.env.CHOCO_PI_LSP_DISABLE_TOOL_INSTALL === "1") {
      installFailureReasons.set(
        toolId,
        "installation disabled by CHOCO_PI_LSP_DISABLE_TOOL_INSTALL=1",
      );
      noteInstallAttempt(
        toolId,
        "declined",
        "installation disabled by CHOCO_PI_LSP_DISABLE_TOOL_INSTALL=1",
      );
      logSessionStart(
        `auto-install ensure ${toolId}: refused — CHOCO_PI_LSP_DISABLE_TOOL_INSTALL=1 (${Date.now() - ensureStartMs}ms)`,
      );
      return undefined;
    }

    const lock = await acquireInstallLock();
    if (!lock.release) {
      installFailureReasons.set(toolId, lock.reason ?? "install lock failed");
      noteInstallAttempt(toolId, "skipped", lock.reason ?? "install lock held");
      logSessionStart(`auto-install ensure ${toolId}: ${lock.reason}`);
      return undefined;
    }
    let installed: boolean;
    try {
      // Cross-process double-check: the lock waiter may now observe the tool
      // installed by its predecessor and must not run a second package manager.
      const installedByPeer = await getToolPath(toolId);
      if (installedByPeer) {
        noteInstallAttempt(toolId, "succeeded", "installed by a concurrent process");
        resolvedPathCache.set(toolId, installedByPeer);
        void updateProbeCache(toolId, installedByPeer, wasLastResolveTransient(toolId));
        return installedByPeer;
      }
      installed = await installTool(toolId);
    } finally {
      await lock.release();
    }
    if (!installed) {
      // installTool RAN and did not succeed. A genuine failure unless it
      // recorded a more specific outcome of its own (#1500).
      noteInstallAttemptIfUnrecorded(toolId, "failed", "install failed");
      logSessionStart(
        `auto-install ensure ${toolId}: unavailable (${Date.now() - ensureStartMs}ms)`,
      );
      return undefined;
    }

    const result = await getToolPath(toolId);
    if (result) {
      resolvedPathCache.set(toolId, result);
      void updateProbeCache(toolId, result, wasLastResolveTransient(toolId));
      logSessionStart(
        `auto-install ensure ${toolId}: success at ${result} (${Date.now() - ensureStartMs}ms)`,
      );
    } else {
      logSessionStart(
        `auto-install ensure ${toolId}: unavailable (${Date.now() - ensureStartMs}ms)`,
      );
    }
    return result;
  })();

  ensureInFlight.set(inFlightKey, ensurePromise);
  try {
    return await ensurePromise;
  } finally {
    ensureInFlight.delete(inFlightKey);
  }
}

// --- Integration Helpers ---

/**
 * Get environment with tool paths added
 */
export async function getToolEnvironment(): Promise<NodeJS.ProcessEnv> {
  const localBin = path.join(TOOLS_DIR, "node_modules", ".bin");
  const currentPath = process.env.PATH || process.env.Path || process.env.path || "";
  const separator = process.platform === "win32" ? ";" : ":";
  // Under Bun, execPath is bun: npm-installed shebang tools need the launcher's Node.
  const nodeDir = nodeBinDirectory();
  const withNode = nodeDir ? `${nodeDir}${separator}${currentPath}` : currentPath;
  const augmentedPath = `${GITHUB_BIN_DIR}${separator}${localBin}${separator}${withNode}`;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: augmentedPath,
  };

  if (process.platform === "win32") {
    env.Path = augmentedPath;
  }

  return env;
}

// --- Status Check ---

/**
 * Check status of all managed tools
 */
export async function checkAllTools(): Promise<
  Array<{ id: string; name: string; installed: boolean; path?: string }>
> {
  const results = [];
  for (const tool of TOOLS) {
    const path = await getToolPath(tool.id);
    results.push({
      id: tool.id,
      name: tool.name,
      installed: path !== undefined,
      path,
    });
  }
  return results;
}

export function isKnownToolId(toolId: string): boolean {
  return TOOLS.some((tool) => tool.id === toolId);
}

/**
 * The registry's own install strategy for `toolId`, or `undefined` for an
 * unknown id. Single source of truth for anything that needs to LABEL how a
 * tool gets installed (e.g. the availability-decision evidence's `source`
 * tag, #1612) — derived from the same `TOOLS` entry `ensureTool` dispatches
 * on, so the label can never drift out of sync with the actual installer.
 */
export function getToolInstallStrategy(
  toolId: string,
): ToolDefinition["installStrategy"] | undefined {
  return TOOLS.find((tool) => tool.id === toolId)?.installStrategy;
}
