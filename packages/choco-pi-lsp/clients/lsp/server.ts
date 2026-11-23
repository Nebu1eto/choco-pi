import { existsSync, mkdirSync } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { obj, opt, str, compile } from "@earendil-works/pi-schema";
import { isRuntimeString } from "../../tools/runtime-values.ts";
import {
  getGlobalPiLensDir,
  getProjectIgnoreGlobs,
  isPathIgnoredByProject,
} from "../file-utils.ts";
import { STAGE_TMP_PATTERN } from "../atomic-write-staging.ts";
import {
  DOTNET_CSHARP_ROOT_MARKERS,
  DOTNET_FSHARP_ROOT_MARKERS,
  KIND_EXTENSIONS,
} from "../file-kinds.ts";
import {
  direntsHaveMarkerGlobMatch,
  isAtOrAboveHomeDir,
  isFullyQualified,
  isWindowsPath,
  normalizeMapKey,
  pathsEqual,
} from "../path-utils.ts";
import { ensureTool, getToolEnvironment, getToolPath } from "../installer/index.ts";
import { resolveOpengrepConfig } from "../opengrep-config.ts";
import { buildOpengrepInitialization } from "../opengrep-runtime.ts";
import { isZizmorAuditTarget, resolveZizmorGitHubToken } from "../zizmor-config.ts";
import { logLatency } from "../latency-logger.ts";
import { logSessionStart } from "../sessionstart-logger.ts";
import { findLocalSgconfig, resolveBaselineSgconfig } from "../sgconfig.ts";
import { findLocalTyposConfig } from "../typos-config.ts";
import { resolvePackagePath } from "../package-root.ts";
import { resolveAstGrepNativeExe } from "./wait-policy/index.ts";
import { hasSpawnFailureKind, isCommandAvailableAsync, safeSpawnAsync } from "../safe-spawn.ts";
import { type LSPProcess, launchLSP } from "./launch.ts";
import { createLombokJdtlsArgs } from "./lombok.ts";
import { resolveJavaRuntimeEnv } from "./jvm-runtime.ts";
import { getRubyVersionDirNamesSync } from "./ruby-drive-dirs.ts";
import { defaultTypeScriptInitialization } from "./typescript-config.ts";
import { isAutomaticTypeAcquisitionEnabledAsync } from "../lsp-config.ts";

export type RootFunction = (file: string) => Promise<string | undefined>;

const PackageVersionSchema = obj({ version: str() }, { open: true });
const isPackageVersion = compile(PackageVersionSchema).check;
const FsErrorSchema = obj({ code: opt(str()) }, { open: true });
const isFsError = compile(FsErrorSchema).check;

const FIXTURE_ROOT_SEGMENTS = new Set(["__fixtures__", "testdata"]);
const FALLBACK_PROJECT_MARKERS = [
  ".git",
  "package.json",
  "go.work",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "mix.exs",
  "pubspec.yaml",
  "Package.swift",
] as const;

const PROJECT_BOUNDARY_MARKERS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "go.work",
  "go.mod",
  "Cargo.toml",
  "Cargo.lock",
  "pyproject.toml",
  "uv.lock",
  "poetry.lock",
  "Pipfile",
  "Pipfile.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "mix.exs",
  "pubspec.yaml",
  "Package.swift",
] as const;

const loggedRootCeilingClamps = new Set<string>();

function isSameOrWithin(ancestor: string, candidate: string): boolean {
  const usesWindowsPaths = isWindowsPath(ancestor) || isWindowsPath(candidate);
  const pathApi = usesWindowsPaths ? path.win32 : path;
  const relative = pathApi.relative(pathApi.resolve(ancestor), pathApi.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !pathApi.isAbsolute(relative));
}

export function enforceLspRootCeiling(root: string, sessionCwd: string, filePath?: string): string {
  const usesWindowsPaths = isWindowsPath(root) || isWindowsPath(sessionCwd);
  const pathApi = usesWindowsPaths ? path.win32 : path;
  const resolvedRoot = pathApi.resolve(root);
  const resolvedCwd = pathApi.resolve(sessionCwd);
  if (filePath && !isSameOrWithin(resolvedCwd, pathApi.resolve(filePath))) {
    return resolvedRoot;
  }
  if (isSameOrWithin(resolvedCwd, resolvedRoot)) return resolvedRoot;

  const logKey = `${normalizeMapKey(resolvedCwd)}:${normalizeMapKey(resolvedRoot)}`;
  if (!loggedRootCeilingClamps.has(logKey)) {
    loggedRootCeilingClamps.add(logKey);
    logSessionStart(
      `lsp root clamped to session cwd: candidate=${resolvedRoot} cwd=${resolvedCwd}`,
    );
  }
  return resolvedCwd;
}

export async function hasProjectBoundaryMarker(dir: string): Promise<boolean> {
  if (await markerExists(dir, ".git")) return true;
  for (const marker of PROJECT_BOUNDARY_MARKERS) {
    if (await markerExists(dir, marker)) return true;
  }
  return false;
}

function pathSegments(dir: string): string[] {
  const parsed = path.parse(path.resolve(dir));
  return path
    .relative(parsed.root, path.resolve(dir))
    .split(path.sep)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
}

function hasFixtureConvention(dir: string): boolean {
  const segments = pathSegments(dir);
  if (segments.some((segment) => FIXTURE_ROOT_SEGMENTS.has(segment))) return true;
  return segments.some(
    (segment, index) => segment === "tests" && segments[index + 1] === "fixtures",
  );
}

function hasAtomicStageSegment(dir: string): boolean {
  return pathSegments(dir).some((segment) => STAGE_TMP_PATTERN.test(segment));
}

async function findGitBoundary(dir: string): Promise<string | undefined> {
  let current = path.resolve(dir);
  const fsRoot = path.parse(current).root;
  while (true) {
    if (await markerExists(current, ".git")) return current;
    if (current === fsRoot) return undefined;
    current = path.dirname(current);
  }
}

async function isExcludedLspRoot(dir: string): Promise<boolean> {
  const candidate = path.resolve(dir);
  if (hasFixtureConvention(candidate) || hasAtomicStageSegment(candidate)) return true;
  const gitRoot = await findGitBoundary(candidate);
  if (!gitRoot || gitRoot === candidate) return false;
  if (getProjectIgnoreGlobs(gitRoot).length === 0) return false;
  return isPathIgnoredByProject(candidate, gitRoot, true);
}

async function nearestNonExcludedFallbackRoot(candidate: string): Promise<string> {
  if (!(await isExcludedLspRoot(candidate))) return path.resolve(candidate);
  let current = path.dirname(path.resolve(candidate));
  const fsRoot = path.parse(current).root;
  let nearestAllowed: string | undefined;
  while (true) {
    if (!(await isExcludedLspRoot(current))) {
      nearestAllowed ??= current;
      for (const marker of FALLBACK_PROJECT_MARKERS) {
        if (await markerExists(current, marker)) return current;
      }
    }
    if (current === fsRoot) break;
    current = path.dirname(current);
  }
  return nearestAllowed ?? fsRoot;
}

export interface LSPSpawnOptions {
  allowInstall?: boolean;
}

export interface LSPServerInfo {
  id: string;
  name: string;
  extensions: readonly string[];
  root: RootFunction;
  role?: "language" | "auxiliary";
  availabilityKey?: string;
  pathFilter?: (filePath: string) => boolean;
  initializeTimeoutMs?: number;
  clientWaitTimeoutMs?: number;
  notifyInflightLimit?: number;
  autoPropagateDiagnostics?: boolean;
  spawn(
    root: string,
    options?: LSPSpawnOptions,
  ): Promise<
    | {
        process: LSPProcess;
        initialization?: InitializationConfig;
        source?: "direct" | "managed" | "package-manager" | "interactive";
        launchVariant?: "classic" | "native-ts7";
      }
    | undefined
  >;
  autoInstall?: () => Promise<boolean>;
}

function isLspInstallDisabled(): boolean {
  return process.env.CHOCO_PI_LSP_DISABLE_LSP_INSTALL === "1";
}

function canInstall(allowInstall?: boolean): boolean {
  return allowInstall !== false && !isLspInstallDisabled();
}

const DIRECT_LSP_NEGATIVE_TTL_MS = Math.max(
  30_000,
  Number.parseInt(process.env.CHOCO_PI_LSP_DIRECT_LSP_NEGATIVE_TTL_MS ?? "600000", 10) || 600_000,
);
const directLspCommandUnavailableUntil = new Map<string, number>();
const directLspCommandSkipLoggedUntil = new Map<string, number>();

function pruneExpiredDirectLspNegativeEntries(now = Date.now()): void {
  for (const [command, until] of directLspCommandUnavailableUntil) {
    if (until <= now) {
      directLspCommandUnavailableUntil.delete(command);
      directLspCommandSkipLoggedUntil.delete(command);
    }
  }
  for (const [command, until] of directLspCommandSkipLoggedUntil) {
    if (until <= now) directLspCommandSkipLoggedUntil.delete(command);
  }
}

function isSimpleCommand(command: string): boolean {
  return !isFullyQualified(command) && !command.includes("/") && !command.includes("\\");
}

export function isDirectLspCommandTemporarilyUnavailable(command: string): boolean {
  const now = Date.now();
  pruneExpiredDirectLspNegativeEntries(now);
  const until = directLspCommandUnavailableUntil.get(command);
  if (!until || until <= now) {
    directLspCommandUnavailableUntil.delete(command);
    return false;
  }
  const loggedUntil = directLspCommandSkipLoggedUntil.get(command) ?? 0;
  if (loggedUntil <= now) {
    logSessionStart(
      `lsp direct command ${command}: skipped by negative availability cache (${Math.max(0, until - now)}ms remaining)`,
    );
    directLspCommandSkipLoggedUntil.set(command, until);
  }
  return true;
}

function markDirectLspCommandUnavailable(command: string): void {
  if (!isSimpleCommand(command)) return;
  directLspCommandUnavailableUntil.set(command, Date.now() + DIRECT_LSP_NEGATIVE_TTL_MS);
  directLspCommandSkipLoggedUntil.delete(command);
}

const CHOCO_PI_LSP_BIN_DIR = path.join(getGlobalPiLensDir(), "bin");

export interface ResolveAndLaunchSpec {
  candidates: string[];
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  managedToolId?: string;
  runtimeInstall?: {
    runtimeCommand: string;
    install: () => Promise<boolean>;
    retryCandidates?: string[];
  };
}

export async function resolveAndLaunch(
  spec: ResolveAndLaunchSpec,
  allowInstall: boolean | undefined,
): Promise<{ process: LSPProcess; source: "direct" | "managed" | "package-manager" } | undefined> {
  const toolLabel = spec.managedToolId ?? spec.candidates[spec.candidates.length - 1] ?? "unknown";
  let lastRuntimeFailure: Error | undefined;
  const trackRuntimeFailure = <T>(err: T): void => {
    const message = err instanceof Error ? err.message : String(err);
    if (!hasSpawnFailureKind(err, "tool-not-found")) {
      lastRuntimeFailure = err instanceof Error ? err : new Error(message);
    }
  };

  const candidateFailures: Array<{
    index: number;
    command: string;
    message: string;
    err: unknown;
  }> = [];

  for (const [index, command] of spec.candidates.entries()) {
    logLatency({
      type: "phase",
      phase: "lsp_launch_candidate_attempt",
      filePath: spec.cwd,
      durationMs: 0,
      metadata: {
        tool: toolLabel,
        command,
        index,
        totalCandidates: spec.candidates.length,
        allowInstall: canInstall(allowInstall),
      },
    });
    logSessionStart(
      `lsp launch candidate attempt tool=${toolLabel} idx=${index}/${spec.candidates.length - 1} command=${command} cwd=${spec.cwd}`,
    );
    try {
      const proc = await launchLSP(command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
      });
      logLatency({
        type: "phase",
        phase: "lsp_launch_candidate_success",
        filePath: spec.cwd,
        durationMs: 0,
        metadata: {
          tool: toolLabel,
          command,
          index,
          source: "direct",
        },
      });
      logSessionStart(
        `lsp launch candidate success tool=${toolLabel} idx=${index} command=${command} source=direct`,
      );
      return { process: proc, source: "direct" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      candidateFailures.push({ index, command, message, err });
    }
  }

  for (const failure of candidateFailures) {
    logLatency({
      type: "phase",
      phase: "lsp_launch_candidate_failed",
      filePath: spec.cwd,
      durationMs: 0,
      metadata: {
        tool: toolLabel,
        command: failure.command,
        index: failure.index,
        error: failure.message,
      },
    });
    logSessionStart(
      `lsp launch candidate failed tool=${toolLabel} idx=${failure.index} command=${failure.command} error=${failure.message}`,
    );
    trackRuntimeFailure(failure.err);
  }
  const hasOnlyRepairableCandidateFailures = candidateFailures.every((failure) =>
    hasSpawnFailureKind(failure.err, "tool-not-found"),
  );
  if (!hasOnlyRepairableCandidateFailures) {
    if (lastRuntimeFailure) throw lastRuntimeFailure;
    return undefined;
  }

  if (!canInstall(allowInstall)) {
    logSessionStart(
      `lsp launch install blocked tool=${toolLabel} cwd=${spec.cwd} allowInstall=${allowInstall !== false} globalDisabled=${isLspInstallDisabled()}`,
    );
    logLatency({
      type: "phase",
      phase: "lsp_launch_install_blocked",
      filePath: spec.cwd,
      durationMs: 0,
      metadata: {
        tool: toolLabel,
        allowInstall,
        globalInstallDisabled: isLspInstallDisabled(),
      },
    });
    return undefined;
  }

  if (spec.managedToolId) {
    logSessionStart(`lsp launch ensure-tool start tool=${spec.managedToolId} cwd=${spec.cwd}`);
    const installed = await ensureTool(spec.managedToolId);
    logSessionStart(
      `lsp launch ensure-tool result tool=${spec.managedToolId} installed=${installed ? "yes" : "no"} path=${installed ?? ""}`,
    );
    logLatency({
      type: "phase",
      phase: "lsp_launch_ensure_tool_result",
      filePath: spec.cwd,
      durationMs: 0,
      metadata: {
        tool: spec.managedToolId,
        installed: Boolean(installed),
        path: installed,
      },
    });
    if (installed) {
      try {
        const proc = await launchLSP(installed, spec.args, {
          cwd: spec.cwd,
          env: spec.env,
        });
        logSessionStart(
          `lsp launch managed success tool=${spec.managedToolId} command=${installed} source=managed`,
        );
        logLatency({
          type: "phase",
          phase: "lsp_launch_managed_success",
          filePath: spec.cwd,
          durationMs: 0,
          metadata: {
            tool: spec.managedToolId,
            command: installed,
          },
        });
        return { process: proc, source: "managed" };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSessionStart(
          `lsp launch managed failed tool=${spec.managedToolId} command=${installed} error=${message}`,
        );
        logLatency({
          type: "phase",
          phase: "lsp_launch_managed_failed",
          filePath: spec.cwd,
          durationMs: 0,
          metadata: {
            tool: spec.managedToolId,
            command: installed,
            error: message,
          },
        });
        trackRuntimeFailure(err);

        const looksPathResolved = !installed.includes("/") && !installed.includes("\\");
        if (looksPathResolved && hasSpawnFailureKind(err, "tool-not-found")) {
          logSessionStart(`lsp launch managed retry force-reinstall tool=${spec.managedToolId}`);
          const reinstalled = await ensureTool(spec.managedToolId, {
            forceReinstall: true,
          });
          if (reinstalled) {
            try {
              const proc = await launchLSP(reinstalled, spec.args, {
                cwd: spec.cwd,
                env: spec.env,
              });
              logSessionStart(
                `lsp launch managed force-reinstall success tool=${spec.managedToolId} command=${reinstalled}`,
              );
              logLatency({
                type: "phase",
                phase: "lsp_launch_managed_force_reinstall_success",
                filePath: spec.cwd,
                durationMs: 0,
                metadata: {
                  tool: spec.managedToolId,
                  command: reinstalled,
                },
              });
              return { process: proc, source: "managed" };
            } catch (retryErr) {
              logSessionStart(
                `lsp launch managed force-reinstall failed tool=${spec.managedToolId} error=${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
              );
            }
          }
        }
      }
    }
  }

  if (spec.runtimeInstall && (await isOnPath(spec.runtimeInstall.runtimeCommand))) {
    const ok = await spec.runtimeInstall.install();
    if (ok) {
      const retry = spec.runtimeInstall.retryCandidates ?? spec.candidates;
      for (const command of retry) {
        try {
          const proc = await launchLSP(command, spec.args, {
            cwd: spec.cwd,
            env: spec.env,
          });
          return { process: proc, source: "managed" };
        } catch (err) {
          trackRuntimeFailure(err);
        }
      }
    }
  }

  if (lastRuntimeFailure) {
    throw lastRuntimeFailure;
  }

  return undefined;
}

interface BundledServerLaunchSpec {
  runtimeCandidates: string[];
  bundleToolId: string;
  cwd: string;
  args: (bundleDir: string) => string[];
  env?: Record<string, string>;
}

async function resolveAndLaunchBundle(
  spec: BundledServerLaunchSpec,
  allowInstall: boolean | undefined,
): Promise<{ process: LSPProcess; source: "managed" } | undefined> {
  let runtime: string | undefined;
  for (const candidate of spec.runtimeCandidates) {
    if (await isOnPath(candidate)) {
      runtime = candidate;
      break;
    }
  }
  if (!runtime) {
    logSessionStart(
      `lsp launch bundle skip tool=${spec.bundleToolId}: no runtime on PATH (tried ${spec.runtimeCandidates.join(", ")})`,
    );
    return undefined;
  }

  let bundleDir = await getToolPath(spec.bundleToolId);
  if (!bundleDir && canInstall(allowInstall)) {
    bundleDir = await ensureTool(spec.bundleToolId);
  }
  if (!bundleDir) {
    logSessionStart(
      `lsp launch bundle skip tool=${spec.bundleToolId}: bundle not installed (allowInstall=${allowInstall !== false})`,
    );
    return undefined;
  }

  try {
    const proc = await launchLSP(runtime, spec.args(bundleDir), {
      cwd: spec.cwd,
      env: spec.env,
    });
    logSessionStart(
      `lsp launch bundle success tool=${spec.bundleToolId} runtime=${runtime} bundle=${bundleDir}`,
    );
    return { process: proc, source: "managed" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logSessionStart(
      `lsp launch bundle failed tool=${spec.bundleToolId} runtime=${runtime} error=${message}`,
    );
    return undefined;
  }
}

interface TreeBinaryLaunchSpec {
  candidates: string[];
  bundleToolId: string;
  binRelPath: string;
  cwd: string;
  args: string[];
  env?: Record<string, string>;
}

async function resolveAndLaunchTreeBinary(
  spec: TreeBinaryLaunchSpec,
  allowInstall: boolean | undefined,
): Promise<{ process: LSPProcess; source: "direct" | "managed" } | undefined> {
  for (const command of spec.candidates) {
    try {
      const proc = await launchLSP(command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
      });
      return { process: proc, source: "direct" };
    } catch {}
  }

  let bundleDir = await getToolPath(spec.bundleToolId);
  if (!bundleDir && canInstall(allowInstall)) {
    bundleDir = await ensureTool(spec.bundleToolId);
  }
  if (!bundleDir) {
    logSessionStart(
      `lsp launch tree-bin skip tool=${spec.bundleToolId}: not on PATH and bundle not installed (allowInstall=${allowInstall !== false})`,
    );
    return undefined;
  }

  const suffix = process.platform === "win32" ? ".exe" : "";
  const binPath = path.join(bundleDir, ...spec.binRelPath.split("/")) + suffix;
  try {
    const proc = await launchLSP(binPath, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
    });
    logSessionStart(`lsp launch tree-bin success tool=${spec.bundleToolId} bin=${binPath}`);
    return { process: proc, source: "managed" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logSessionStart(
      `lsp launch tree-bin failed tool=${spec.bundleToolId} bin=${binPath} error=${message}`,
    );
    return undefined;
  }
}

function nodeBinCandidates(root: string, baseName: string): string[] {
  const localBase = path.join(root, "node_modules", ".bin", baseName);
  if (process.platform === "win32") {
    return [`${localBase}.cmd`, `${localBase}.exe`, baseName];
  }
  return [localBase, baseName];
}

function normalizeSlashKey(value: string): string {
  const normalized = path.resolve(value).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function piAgentExtensionsRootKey(file: string): string | undefined {
  const dirKey = normalizeSlashKey(path.dirname(path.resolve(file)));
  const marker = "/.pi/agent/extensions";
  const index = dirKey.indexOf(marker);
  if (index === -1) return undefined;
  return dirKey.slice(0, index + marker.length);
}

function normalizeRootKey(root: string): string {
  return process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root);
}

function IgnoreHomeRoot(primary: RootFunction): RootFunction {
  const homeKey = normalizeRootKey(os.homedir());
  return async (file: string): Promise<string | undefined> => {
    const root = await primary(file);
    if (!root) return undefined;
    return normalizeRootKey(root) === homeKey ? undefined : root;
  };
}

function rubyBinCandidates(baseName: string): string[] {
  const candidates: string[] = [];
  const home = os.homedir();
  const isWin = process.platform === "win32";
  const ext = isWin ? ".bat" : "";

  candidates.push(
    path.join(home, ".local", "share", "mise", "installs", "ruby", "bin", `${baseName}${ext}`),
  );
  candidates.push(path.join(home, ".asdf", "installs", "ruby", "bin", `${baseName}${ext}`));

  if (isWin) {
    const driveRoot = path.parse(home).root;
    for (const entry of getRubyVersionDirNamesSync(driveRoot)) {
      candidates.push(path.join(driveRoot, entry, "bin", `${baseName}.bat`));
      candidates.push(path.join(driveRoot, entry, "bin", baseName));
    }
  }

  return candidates;
}

interface InitializationConfig {
  [key: string]: InitializationValue;
}

type InitializationValue =
  | string
  | number
  | boolean
  | null
  | InitializationConfig
  | InitializationValue[];

interface InteractiveLaunchOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

interface InteractiveServerSpec {
  id: string;
  name: string;
  extensions: readonly string[];
  root: RootFunction;
  language: string;
  command: string | ((root: string) => string);
  args?: string[] | ((root: string) => string[]);
  initialization?: InitializationConfig | ((root: string) => InitializationConfig);
  runtime?: "java";
}

function createInteractiveServer(spec: InteractiveServerSpec): LSPServerInfo {
  return {
    id: spec.id,
    name: spec.name,
    extensions: spec.extensions,
    root: spec.root,
    availabilityKey:
      isRuntimeString(spec.command) && isSimpleCommand(spec.command) ? spec.command : undefined,
    async spawn(root) {
      const command = isRuntimeString(spec.command) ? spec.command : spec.command(root);
      const args =
        spec.args === undefined ? [] : Array.isArray(spec.args) ? spec.args : spec.args(root);
      if (isSimpleCommand(command) && isDirectLspCommandTemporarilyUnavailable(command)) {
        return undefined;
      }
      const runtimeEnv = spec.runtime === "java" ? await resolveJavaRuntimeEnv() : undefined;
      try {
        const launchOptions: InteractiveLaunchOptions = { cwd: root };
        if (runtimeEnv) launchOptions.env = runtimeEnv;
        const proc = await launchLSP(command, args, launchOptions);
        const initialization =
          spec.initialization instanceof Function ? spec.initialization(root) : spec.initialization;
        return { process: proc, source: "direct", initialization };
      } catch (err) {
        if (hasSpawnFailureKind(err, "tool-not-found")) {
          markDirectLspCommandUnavailable(command);
        }
        return undefined;
      }
    },
  };
}

export function PriorityRoot(
  markerGroups: string[][],
  excludePatterns?: string[],
  stopDir?: string,
): RootFunction {
  const resolvers = markerGroups.map((markers) => NearestRoot(markers, excludePatterns, stopDir));
  return async (file: string) => {
    for (const resolve of resolvers) {
      const root = await resolve(file);
      if (root) return root;
    }
    return undefined;
  };
}

export const FileDirRoot: RootFunction = async (file: string) => {
  const candidate = path.resolve(path.dirname(file));
  return nearestNonExcludedFallbackRoot(candidate);
};

export function RootWithFallback(
  primary: RootFunction,
  fallback: RootFunction = FileDirRoot,
): RootFunction {
  return async (file: string): Promise<string | undefined> => {
    const primaryRoot = await primary(file);
    if (primaryRoot) return primaryRoot;
    return fallback(file);
  };
}

export function WorkspacePriorityRoot(
  markerGroups: string[][],
  excludePatterns?: string[],
): RootFunction {
  return async (file: string) => PriorityRoot(markerGroups, excludePatterns, process.cwd())(file);
}

function isPermissionFsError<T>(err: T): boolean {
  if (!isFsError(err)) return false;
  return err.code === "EACCES" || err.code === "EPERM";
}

async function markerExists(dir: string, pattern: string): Promise<boolean> {
  if (!pattern.includes("*")) {
    try {
      await stat(path.join(dir, pattern));
      return true;
    } catch (err) {
      if (isPermissionFsError(err)) {
        logSessionStart(
          `lsp root marker skipped: permission error stat ${path.join(dir, pattern)}`,
        );
      }
      return false;
    }
  }

  const normalized = pattern.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const parentPattern = slash >= 0 ? normalized.slice(0, slash) : "";
  const basenamePattern = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  if (!basenamePattern) return false;
  const targetDir = parentPattern
    ? path.join(dir, ...parentPattern.split("/").filter(Boolean))
    : dir;
  try {
    const entries = await readdir(targetDir, { withFileTypes: true });
    return direntsHaveMarkerGlobMatch(entries, basenamePattern);
  } catch (err) {
    if (isPermissionFsError(err)) {
      logSessionStart(`lsp root marker skipped: permission error read ${targetDir}`);
    }
    return false;
  }
}

export function NearestRoot(
  includePatterns: string[],
  excludePatterns?: string[],
  stopDir?: string,
): RootFunction {
  const cache = new Map<string, string>();
  const inFlight = new Map<string, Promise<string | undefined>>();

  return async (file: string): Promise<string | undefined> => {
    const startDir = path.resolve(path.dirname(file));
    const dirKey = normalizeMapKey(startDir);

    const cached = cache.get(dirKey);
    if (cached !== undefined) return cached;

    const flying = inFlight.get(dirKey);
    if (flying) return flying;

    const promise = (async (): Promise<string | undefined> => {
      let currentDir = startDir;
      const fsRoot = path.parse(currentDir).root;
      const stop = stopDir ? path.resolve(stopDir) : fsRoot;

      while (true) {
        if (
          stop !== fsRoot &&
          currentDir.startsWith(stop + path.sep) === false &&
          currentDir !== stop
        ) {
          break;
        }

        if (excludePatterns) {
          let excluded = false;
          for (const pattern of excludePatterns) {
            if (await markerExists(currentDir, pattern)) {
              excluded = true;
              break;
            }
          }
          if (excluded) {
            currentDir = path.dirname(currentDir);
            continue;
          }
        }

        for (const pattern of includePatterns) {
          if ((await markerExists(currentDir, pattern)) && !(await isExcludedLspRoot(currentDir))) {
            return enforceLspRootCeiling(currentDir, process.cwd(), file);
          }
        }

        if (currentDir === stop || currentDir === fsRoot) {
          break;
        }

        currentDir = path.dirname(currentDir);
      }

      return undefined;
    })();

    inFlight.set(dirKey, promise);
    try {
      const result = await promise;
      if (result !== undefined) cache.set(dirKey, result);
      return result;
    } finally {
      inFlight.delete(dirKey);
    }
  };
}

export const createRootDetector = NearestRoot;

function isOnPath(command: string): Promise<boolean> {
  return isCommandAvailableAsync(command);
}

export async function tryGoInstallGopls(): Promise<boolean> {
  const isWindows = process.platform === "win32";
  const result = await safeSpawnAsync(
    isWindows ? "go.exe" : "go",
    ["install", "golang.org/x/tools/gopls@latest"],
    { timeout: 180000, ignoreAmbientSignal: true },
  );
  return !result.error && result.status === 0;
}

export async function tryDotnetToolInstall(tool: string): Promise<boolean> {
  mkdirSync(CHOCO_PI_LSP_BIN_DIR, { recursive: true });
  const result = await safeSpawnAsync(
    "dotnet",
    ["tool", "install", "--tool-path", CHOCO_PI_LSP_BIN_DIR, tool],
    { timeout: 180000, ignoreAmbientSignal: true },
  );
  if (!result.error && result.status === 0) return true;

  const stderr = result.stderr ?? "";
  if (stderr.includes("No NuGet sources are defined or enabled")) {
    logSessionStart(
      `lsp dotnet-install: NuGet sources missing — cannot install ${tool}. ` +
        `Run: dotnet nuget add source https://api.nuget.org/v3/index.json -n nuget.org`,
    );
    return false;
  }

  const updateResult = await safeSpawnAsync(
    "dotnet",
    ["tool", "update", "--tool-path", CHOCO_PI_LSP_BIN_DIR, tool],
    { timeout: 180000, ignoreAmbientSignal: true },
  );
  return !updateResult.error && updateResult.status === 0;
}

async function findAncestorFile(
  startDir: string,
  ...relativeSegments: string[]
): Promise<string | undefined> {
  return findAncestorFileAmong(startDir, [relativeSegments]);
}

async function findAncestorFileAmong(
  startDir: string,
  candidateSegmentLists: string[][],
): Promise<string | undefined> {
  const fs = await import("node:fs/promises");
  let currentDir = path.resolve(startDir);
  while (!isAtOrAboveHomeDir(currentDir)) {
    for (const segments of candidateSegmentLists) {
      const candidate = path.join(currentDir, ...segments);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {}
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }
  return undefined;
}

let classicTsRepairAttempted = false;

export function resetClassicTsRepairGuard(): void {
  classicTsRepairAttempted = false;
}

export function _resetClassicTsRepairForTests(): void {
  resetClassicTsRepairGuard();
}

function typescriptDirsForTsc(tscPath: string): string[] {
  const binDir = path.dirname(tscPath);
  return [path.join(binDir, "..", "typescript"), path.join(binDir, "..", "..", "typescript")];
}

async function typescriptVersionForTsc(
  tscPath: string,
): Promise<{ version: string; major: number } | undefined> {
  if (!path.isAbsolute(tscPath)) return undefined;
  for (const dir of typescriptDirsForTsc(tscPath)) {
    let manifest: string;
    try {
      manifest = await readFile(path.join(dir, "package.json"), "utf8");
    } catch {
      continue;
    }
    let version: string;
    try {
      const parsed = JSON.parse(manifest);
      if (!isPackageVersion(parsed)) return undefined;
      version = parsed.version;
    } catch {
      return undefined;
    }
    const majorText = version.split(".", 1)[0] ?? "";
    const major = /^\d+$/.test(majorText) ? Number(majorText) : Number.NaN;
    if (!Number.isFinite(major)) return undefined;
    return { version, major };
  }
  return undefined;
}

async function findTsserverPath(
  root: string,
  allowInstall: boolean | undefined,
): Promise<string | undefined> {
  const fs = await import("node:fs/promises");
  const ancestorHit = await findAncestorFile(
    root,
    "node_modules",
    "typescript",
    "lib",
    "tsserver.js",
  );
  if (ancestorHit) return ancestorHit;
  const cwdCandidate = path.join(process.cwd(), "node_modules", "typescript", "lib", "tsserver.js");
  try {
    await fs.access(cwdCandidate);
    return cwdCandidate;
  } catch {}
  const tsserverForTsc = async (tscPath: string | undefined): Promise<string | undefined> => {
    if (!tscPath) return undefined;
    for (const dir of typescriptDirsForTsc(tscPath)) {
      const candidate = path.join(dir, "lib", "tsserver.js");
      try {
        await fs.access(candidate);
        return candidate;
      } catch {}
    }
    return undefined;
  };

  const installAllowed = canInstall(allowInstall);
  const discoveredTsc = await ensureTool("typescript", {
    allowInstall: installAllowed,
  });
  const discoveredTsserver = await tsserverForTsc(discoveredTsc);
  if (discoveredTsserver || !discoveredTsc || !installAllowed || classicTsRepairAttempted) {
    return discoveredTsserver;
  }

  const discoveredVersion = await typescriptVersionForTsc(discoveredTsc);
  if (!discoveredVersion || discoveredVersion.major < 7) return undefined;

  classicTsRepairAttempted = true;
  logSessionStart(
    `lsp typescript: managed compiler resolved to TypeScript ${discoveredVersion.version}, which ships no tsserver.js; reinstalling pinned classic fallback`,
  );
  const repairedTsc = await ensureTool("typescript", {
    allowInstall: true,
    forceReinstall: true,
  });
  return tsserverForTsc(repairedTsc);
}

interface NativeTypeScriptLsp {
  command: string;
  version: string;
}

async function findNativeTypeScriptLsp(root: string): Promise<NativeTypeScriptLsp | undefined> {
  let currentDir = path.resolve(root);

  while (!isAtOrAboveHomeDir(currentDir)) {
    const typescriptDir = path.join(currentDir, "node_modules", "typescript");
    const packageJsonPath = path.join(typescriptDir, "package.json");

    let packageJsonText: string;
    try {
      packageJsonText = await readFile(packageJsonPath, "utf8");
    } catch (error) {
      if (!isFsError(error) || error.code !== "ENOENT") {
        return undefined;
      }
      try {
        const dirStat = await stat(typescriptDir);
        if (dirStat.isDirectory()) return undefined;
      } catch {}
      const parent = path.dirname(currentDir);
      if (parent === currentDir) return undefined;
      currentDir = parent;
      continue;
    }

    let version: string;
    try {
      const parsed = JSON.parse(packageJsonText);
      if (!isPackageVersion(parsed)) return undefined;
      version = parsed.version;
    } catch {
      return undefined;
    }

    const majorText = version.split(".", 1)[0] ?? "";
    const major = /^\d+$/.test(majorText) ? Number(majorText) : Number.NaN;
    if (!Number.isFinite(major) || major < 7) return undefined;

    const localTsc = path.join(currentDir, "node_modules", ".bin", "tsc");
    const candidates =
      process.platform === "win32" ? [`${localTsc}.cmd`, `${localTsc}.exe`, localTsc] : [localTsc];

    for (const command of candidates) {
      try {
        await access(command);
        return { command, version };
      } catch {}
    }
    return undefined;
  }
  return undefined;
}

function dotnetToolCandidates(tool: string): string[] {
  const home = os.homedir();
  return [
    path.join(CHOCO_PI_LSP_BIN_DIR, `${tool}.exe`),
    path.join(CHOCO_PI_LSP_BIN_DIR, tool),
    path.join(home, ".dotnet", "tools", `${tool}.exe`),
    path.join(home, ".dotnet", "tools", tool),
    tool,
  ].filter(Boolean);
}

function binExeVariants(dir: string, tool: string): string[] {
  return process.platform === "win32"
    ? [path.join(dir, `${tool}.exe`), path.join(dir, tool)]
    : [path.join(dir, tool)];
}

export function goBinCandidates(tool: string): string[] {
  const gopath = process.env.GOPATH?.split(path.delimiter)[0] || path.join(os.homedir(), "go");
  return [tool, ...binExeVariants(path.join(gopath, "bin"), tool)];
}

export function cargoBinCandidates(tool: string): string[] {
  const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), ".cargo");
  return [tool, ...binExeVariants(path.join(cargoHome, "bin"), tool)];
}

export async function tryGemInstall(gem: string): Promise<boolean> {
  const { join } = await import("node:path");
  const binDir = join(getGlobalPiLensDir(), "bin");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(binDir, { recursive: true });

  const result = await safeSpawnAsync(
    "gem",
    ["install", gem, "--bindir", binDir, "--no-document"],
    { timeout: 180000, ignoreAmbientSignal: true },
  );
  const ok = !result.error && result.status === 0;
  if (ok) {
    const sep = process.platform === "win32" ? ";" : ":";
    if (!process.env.PATH?.includes(binDir)) {
      process.env.PATH = `${binDir}${sep}${process.env.PATH ?? ""}`;
    }
  }
  return ok;
}

export function DenoExcludeRoot(primary: RootFunction): RootFunction {
  const denoDetector = createRootDetector(["deno.json", "deno.jsonc"]);
  return async (file: string): Promise<string | undefined> => {
    const denoRoot = await denoDetector(file);
    if (denoRoot) return undefined;
    return primary(file);
  };
}

export async function detectPythonVenv(root: string): Promise<string | undefined> {
  const isWin = process.platform === "win32";
  const candidates = [
    process.env.VIRTUAL_ENV,
    process.env.CONDA_PREFIX,
    path.join(root, ".venv"),
    path.join(root, "venv"),
  ].filter((v): v is string => Boolean(v));

  for (const venv of candidates) {
    const pythonPath = isWin
      ? path.join(venv, "Scripts", "python.exe")
      : path.join(venv, "bin", "python");
    try {
      await access(pythonPath);
      return pythonPath;
    } catch {}
  }
  return undefined;
}

const JS_TS_LSP_EXTENSIONS = KIND_EXTENSIONS["jsts"].filter(
  (ext) => ext !== ".svelte" && ext !== ".vue",
);

const TS_CONFIG_MARKERS = ["tsconfig.json", "jsconfig.json"] as const;
const TS_TOOLING_MARKERS = [
  "package-lock.json",
  "bun.lockb",
  "bun.lock",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package.json",
] as const;

const TS_FAMILY_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

function isTsFamilyFile(file: string): boolean {
  return TS_FAMILY_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function tsConfigMarkersForFile(file: string): readonly string[] {
  return isTsFamilyFile(file) ? (["tsconfig.json"] as const) : TS_CONFIG_MARKERS;
}

const TypeScriptConfigRootTsOnly = IgnoreHomeRoot(createRootDetector(["tsconfig.json"]));
const TypeScriptConfigRootEither = IgnoreHomeRoot(createRootDetector([...TS_CONFIG_MARKERS]));
const TypeScriptToolingRoot = IgnoreHomeRoot(createRootDetector([...TS_TOOLING_MARKERS]));

async function findTypeScriptProjectRoot(file: string): Promise<string | undefined> {
  const configDetector = isTsFamilyFile(file)
    ? TypeScriptConfigRootTsOnly
    : TypeScriptConfigRootEither;
  const [configRoot, toolingRoot] = await Promise.all([
    configDetector(file),
    TypeScriptToolingRoot(file),
  ]);
  if (!configRoot) return toolingRoot;
  if (!toolingRoot) return configRoot;
  return isSameOrWithin(toolingRoot, configRoot) ? configRoot : toolingRoot;
}

async function findExtensionBoundedRoot(
  file: string,
  extensionRootKey: string,
): Promise<string | undefined> {
  const startDir = path.resolve(path.dirname(file));
  let currentDir = startDir;
  const configMarkers = tsConfigMarkersForFile(file);
  while (true) {
    for (const pattern of configMarkers) {
      try {
        await stat(path.join(currentDir, pattern));
        return currentDir;
      } catch {}
    }
    for (const pattern of TS_TOOLING_MARKERS) {
      try {
        await stat(path.join(currentDir, pattern));
        return currentDir;
      } catch {}
    }
    const currentKey = normalizeSlashKey(currentDir);
    if (currentKey === extensionRootKey) return undefined;
    const parent = path.dirname(currentDir);
    if (parent === currentDir) return undefined;
    currentDir = parent;
  }
}

async function hasAgentLevelProjectMarker(extensionRootKey: string): Promise<boolean> {
  const agentDir = path.dirname(extensionRootKey);
  if (!agentDir || agentDir === extensionRootKey) return false;
  for (const pattern of [...TS_CONFIG_MARKERS, ...TS_TOOLING_MARKERS]) {
    try {
      await stat(path.join(agentDir, pattern));
      return true;
    } catch {}
  }
  return false;
}

const TypeScriptRoot: RootFunction = DenoExcludeRoot(async (file) => {
  const extensionRootKey = piAgentExtensionsRootKey(file);
  if (extensionRootKey) {
    const bounded = await findExtensionBoundedRoot(file, extensionRootKey);
    if (bounded) return bounded;
    if (await hasAgentLevelProjectMarker(extensionRootKey)) {
      return FileDirRoot(file);
    }
    return undefined;
  }
  const projectRoot = await findTypeScriptProjectRoot(file);
  if (projectRoot) return projectRoot;
  return FileDirRoot(file);
});

export const TypeScriptServer: LSPServerInfo = {
  id: "typescript",
  name: "TypeScript Language Server",
  extensions: JS_TS_LSP_EXTENSIONS,
  autoPropagateDiagnostics: true,
  root: TypeScriptRoot,
  async spawn(root, options) {
    const fs = await import("node:fs/promises");
    const ataInitialization = defaultTypeScriptInitialization(
      await isAutomaticTypeAcquisitionEnabledAsync(),
    );
    const nativeLsp = await findNativeTypeScriptLsp(root);
    if (nativeLsp) {
      const env = await getToolEnvironment();
      logSessionStart(
        `lsp typescript-native: version=${nativeLsp.version} command=${nativeLsp.command}`,
      );
      const proc = await launchLSP(nativeLsp.command, ["--lsp", "--stdio"], {
        cwd: root,
        env,
      });
      return {
        process: proc,
        source: "direct",
        initialization: ataInitialization,
        launchVariant: "native-ts7",
      };
    }

    let source: "direct" | "managed" = "direct";

    let lspPath: string | undefined = await findAncestorFileAmong(root, [
      ["node_modules", ".bin", "typescript-language-server.cmd"],
      ["node_modules", ".bin", "typescript-language-server"],
    ]);

    if (!lspPath) {
      lspPath = await ensureTool("typescript-language-server", {
        allowInstall: canInstall(options?.allowInstall),
      });
      if (lspPath) source = "managed";
      if (!lspPath) {
        return undefined;
      }
    }

    let tsserverPath = await findTsserverPath(root, options?.allowInstall);
    if (!tsserverPath) {
      const localCandidate = path.join(
        path.dirname(lspPath),
        "..",
        "typescript",
        "lib",
        "tsserver.js",
      );
      try {
        await fs.access(localCandidate);
        tsserverPath = localCandidate;
      } catch {}
    }
    if (tsserverPath) source = "managed";

    const env = await getToolEnvironment();
    const proc = await launchLSP(lspPath, ["--stdio"], {
      cwd: root,
      env: {
        ...env,
        TSSERVER_PATH: tsserverPath,
      },
    });
    const initialization: InitializationConfig = { ...ataInitialization };
    if (tsserverPath) initialization.tsserver = { path: tsserverPath };

    return {
      process: proc,
      source,
      initialization,
      launchVariant: "classic",
    };
  },
};

export const DenoServer: LSPServerInfo = {
  id: "deno",
  name: "Deno Language Server",
  extensions: JS_TS_LSP_EXTENSIONS,
  autoPropagateDiagnostics: true,
  root: createRootDetector(["deno.json", "deno.jsonc"]),
  async spawn(root, options) {
    return resolveAndLaunch(
      {
        candidates: ["deno"],
        args: ["lsp"],
        cwd: root,
        managedToolId: "deno",
      },
      options?.allowInstall,
    );
  },
};

export const PythonServer: LSPServerInfo = {
  id: "python",
  name: "Pyright Language Server",
  extensions: KIND_EXTENSIONS["python"],
  root: RootWithFallback(
    createRootDetector([
      ".git",
      "pyproject.toml",
      "setup.py",
      "setup.cfg",
      "requirements.txt",
      "Pipfile",
      "poetry.lock",
    ]),
  ),
  async spawn(root, options) {
    const env = await getToolEnvironment();
    let source: "direct" | "managed" | "package-manager" = "direct";

    const pyrightInit = (pythonPath?: string): InitializationConfig => {
      const initialization: InitializationConfig = { openFilesOnly: true };
      if (pythonPath) initialization.pythonPath = pythonPath;
      return initialization;
    };

    const localCandidates = [
      ...nodeBinCandidates(root, "pyright-langserver"),
      ...nodeBinCandidates(root, "basedpyright-langserver"),
    ];
    const direct = await resolveAndLaunch(
      { candidates: localCandidates, args: ["--stdio"], cwd: root, env },
      false,
    );
    if (direct) {
      const pythonPath = await detectPythonVenv(root);
      return {
        process: direct.process,
        source: direct.source,
        initialization: pyrightInit(pythonPath),
      };
    }

    const ty = await resolveAndLaunch(
      { candidates: ["ty"], args: ["server"], cwd: root, env },
      false,
    );
    if (ty) {
      return { process: ty.process, source: ty.source };
    }

    const pyrightPath = await ensureTool("pyright", {
      allowInstall: canInstall(options?.allowInstall),
    });
    if (!pyrightPath) return undefined;
    source = "managed";

    const binDir = path.dirname(pyrightPath);
    const isWindows = process.platform === "win32";
    const managedCandidates = isWindows
      ? [
          path.join(binDir, "pyright-langserver.cmd"),
          path.join(binDir, "pyright-langserver"),
          "pyright-langserver",
        ]
      : [path.join(binDir, "pyright-langserver"), "pyright-langserver"];

    const resolved = await resolveAndLaunch(
      { candidates: managedCandidates, args: ["--stdio"], cwd: root, env },
      false,
    );
    if (!resolved) return undefined;

    const pythonPath = await detectPythonVenv(root);
    return {
      process: resolved.process,
      source,
      initialization: pyrightInit(pythonPath),
    };
  },
};

export const PythonJediServer: LSPServerInfo = {
  id: "python-jedi",
  name: "Jedi Language Server",
  extensions: KIND_EXTENSIONS["python"],
  root: RootWithFallback(
    createRootDetector([
      ".git",
      "pyproject.toml",
      "setup.py",
      "setup.cfg",
      "requirements.txt",
      "Pipfile",
      "poetry.lock",
    ]),
  ),
  async spawn(root, options) {
    const launched = await resolveAndLaunch(
      {
        candidates: ["jedi-language-server"],
        args: [],
        cwd: root,
        managedToolId: "jedi-language-server",
      },
      options?.allowInstall,
    );
    if (!launched) return undefined;
    const pythonPath = await detectPythonVenv(root);
    const initialization: InitializationConfig = {};
    if (pythonPath) initialization.workspace = { environmentPath: pythonPath };
    return {
      ...launched,
      initialization,
    };
  },
};

export const GoServer: LSPServerInfo = {
  id: "go",
  name: "gopls",
  extensions: KIND_EXTENSIONS["go"],
  root: RootWithFallback(WorkspacePriorityRoot([["go.work"], ["go.mod", "go.sum"], [".git"]])),
  async spawn(root, options) {
    const result = await resolveAndLaunch(
      {
        candidates: goBinCandidates("gopls"),
        args: [],
        cwd: root,
        runtimeInstall: {
          runtimeCommand: "go",
          install: tryGoInstallGopls,
        },
      },
      options?.allowInstall,
    );
    if (!result) return undefined;
    return { ...result, initialization: { ui: { semanticTokens: true } } };
  },
};

async function readTextFileOrUndefined(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

function extractTomlTableSection(content: string, tableName: string): string {
  const heading = new RegExp(`^\\[${tableName}\\][ \\t]*(?:#.*)?$`, "m");
  const match = heading.exec(content);
  if (!match) return "";
  const rest = content.slice(match.index + match[0].length);
  const nextHeading = rest.match(/^\[{1,2}[^\]]+\]{1,2}[ \t]*(?:#.*)?$/m);
  return nextHeading?.index !== undefined ? rest.slice(0, nextHeading.index) : rest;
}

function parseTomlStringArray(content: string, key: string): string[] {
  const match = content.match(new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*\\[([\\s\\S]*?)\\]`, "m"));
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => (m[1] ?? m[2] ?? "").trim());
}

function segmentGlobToRegExpSource(segment: string): string {
  let out = "";
  for (const ch of segment) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

function matchesCargoWorkspacePattern(pattern: string, relativePath: string): boolean {
  const normalized = pattern.replace(/\/+$/, "");
  if (normalized.includes("**")) return false;
  const patternSegments = normalized.split("/");
  const pathSegments = relativePath.split("/");
  if (patternSegments.length !== pathSegments.length) return false;
  return patternSegments.every((segment, i) =>
    new RegExp(`^${segmentGlobToRegExpSource(segment)}$`).test(pathSegments[i]),
  );
}

function cargoWorkspaceDeclaresMember(
  workspaceContent: string,
  parentDir: string,
  childDir: string,
): boolean {
  const relativePath = path.relative(parentDir, childDir).split(path.sep).join("/");
  if (relativePath === "" || relativePath.startsWith("..")) return false;
  const workspaceSection = extractTomlTableSection(workspaceContent, "workspace");
  const excluded = parseTomlStringArray(workspaceSection, "exclude");
  if (excluded.some((pattern) => matchesCargoWorkspacePattern(pattern, relativePath))) {
    return false;
  }
  const members = parseTomlStringArray(workspaceSection, "members");
  return members.some((pattern) => matchesCargoWorkspacePattern(pattern, relativePath));
}

function sessionHoistCeiling(sessionCwd: string, file: string): string | undefined {
  return isSameOrWithin(path.resolve(sessionCwd), path.resolve(file))
    ? path.resolve(sessionCwd)
    : undefined;
}

function RustWorkspaceRoot(): RootFunction {
  const crateRoot = createRootDetector(["Cargo.toml", "Cargo.lock"]);
  return async (file: string): Promise<string | undefined> => {
    const root = await crateRoot(file);
    if (!root) return undefined;

    const sessionCwd = process.cwd();
    const stop = sessionHoistCeiling(sessionCwd, file);

    let current = root;
    const fsRoot = path.parse(current).root;
    while (true) {
      if (stop !== undefined && current === stop) break;
      const parent = path.dirname(current);
      if (parent === current || parent === fsRoot) break;
      const parentCargoPath = path.join(parent, "Cargo.toml");
      const parentCargoContent = await readTextFileOrUndefined(parentCargoPath);
      if (parentCargoContent !== undefined && /^\s*\[workspace\]/m.test(parentCargoContent)) {
        if (cargoWorkspaceDeclaresMember(parentCargoContent, parent, root)) {
          return enforceLspRootCeiling(parent, sessionCwd, file);
        }
        break;
      }
      current = parent;
    }
    return root;
  };
}

function stripXmlComments(content: string): string {
  let result = content;
  let previous: string;
  do {
    previous = result;
    result = result.replace(/<!--[\s\S]*?-->/g, "");
  } while (result !== previous);
  return result;
}

async function declaresMavenModule(
  parentDir: string,
  parentPomPath: string,
  childDir: string,
): Promise<boolean> {
  try {
    const content = stripXmlComments(await readFile(parentPomPath, "utf-8"));
    const modulesBlock = content.match(/<modules>([\s\S]*?)<\/modules>/);
    if (!modulesBlock) return false;
    const resolvedChild = path.resolve(childDir);
    for (const match of modulesBlock[1].matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)) {
      if (pathsEqual(path.resolve(parentDir, match[1]), resolvedChild)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function JavaWorkspaceRoot(): RootFunction {
  const moduleRoot = createRootDetector(["pom.xml", "build.gradle", ".classpath"]);
  return async (file: string): Promise<string | undefined> => {
    const root = await moduleRoot(file);
    if (!root) return undefined;
    if (!(await markerExists(root, "pom.xml"))) return root;

    const sessionCwd = process.cwd();
    const stop = sessionHoistCeiling(sessionCwd, file);

    let current = root;
    let lastHop = root;
    const fsRoot = path.parse(current).root;
    while (true) {
      if (stop !== undefined && current === stop) break;
      const parent = path.dirname(current);
      if (parent === current || parent === fsRoot) break;
      if (await markerExists(parent, "pom.xml")) {
        const parentPom = path.join(parent, "pom.xml");
        if (!(await declaresMavenModule(parent, parentPom, lastHop))) break;
        current = parent;
        lastHop = parent;
        continue;
      }
      current = parent;
    }
    return enforceLspRootCeiling(lastHop, sessionCwd, file);
  };
}

export const RustServer: LSPServerInfo = {
  id: "rust",
  name: "rust-analyzer",
  extensions: KIND_EXTENSIONS["rust"],
  root: RustWorkspaceRoot(),
  async spawn(root, options) {
    const result = await resolveAndLaunch(
      {
        candidates: cargoBinCandidates("rust-analyzer"),
        args: [],
        cwd: root,
        managedToolId: "rust-analyzer",
      },
      options?.allowInstall,
    );
    if (!result) return undefined;
    return {
      ...result,
      initialization: {
        cargo: { buildScripts: { enable: true } },
        procMacro: { enable: true },
        diagnostics: { enable: true },
      },
    };
  },
};

export const RubyServer: LSPServerInfo = {
  id: "ruby",
  name: "Ruby LSP",
  extensions: KIND_EXTENSIONS["ruby"],
  root: RootWithFallback(PriorityRoot([["Gemfile", ".ruby-version"], [".git"]])),
  initializeTimeoutMs: 30_000,
  clientWaitTimeoutMs: 30_000,
  async spawn(root, options) {
    const rubylsp = await resolveAndLaunch(
      {
        candidates: ["ruby-lsp", ...rubyBinCandidates("ruby-lsp")],
        args: [],
        cwd: root,
        runtimeInstall: {
          runtimeCommand: "gem",
          install: () => tryGemInstall("ruby-lsp"),
          retryCandidates: ["ruby-lsp", ...rubyBinCandidates("ruby-lsp")],
        },
      },
      options?.allowInstall,
    );
    if (rubylsp) return rubylsp;

    const solargraph = await resolveAndLaunch(
      {
        candidates: ["solargraph", ...rubyBinCandidates("solargraph")],
        args: ["stdio"],
        cwd: root,
      },
      false,
    );
    if (solargraph) return solargraph;

    return resolveAndLaunch(
      {
        candidates: ["rubocop", ...rubyBinCandidates("rubocop")],
        args: ["--lsp"],
        cwd: root,
      },
      false,
    );
  },
};

export const PHPServer: LSPServerInfo = {
  id: "php",
  name: "Intelephense",
  extensions: KIND_EXTENSIONS["php"],
  root: RootWithFallback(createRootDetector(["composer.json", "composer.lock"])),
  async spawn(root, options) {
    const result = await resolveAndLaunch(
      {
        candidates: nodeBinCandidates(root, "intelephense"),
        args: ["--stdio"],
        cwd: root,
        managedToolId: "intelephense",
      },
      options?.allowInstall,
    );
    if (!result) return undefined;
    return {
      ...result,
      initialization: {
        storagePath: path.join(getGlobalPiLensDir(), "intelephense"),
      },
    };
  },
};

function buildPsesArgs(bundleDir: string): string[] {
  const script = path.join(bundleDir, "PowerShellEditorServices", "Start-EditorServices.ps1");
  const sessionDir = path.join(getGlobalPiLensDir(), "pses", `${process.pid}-${Date.now()}`);
  mkdirSync(sessionDir, { recursive: true });
  const logPath = path.join(sessionDir, "pses.log");
  const sessionDetailsPath = path.join(sessionDir, "session.json");
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-HostName",
    "choco-pi-lsp",
    "-HostProfileId",
    "choco-pi-lsp",
    "-HostVersion",
    "1.0.0",
    "-BundledModulesPath",
    bundleDir,
    "-LogPath",
    logPath,
    "-LogLevel",
    "Warning",
    "-SessionDetailsPath",
    sessionDetailsPath,
    "-Stdio",
    "-LanguageServiceOnly",
  ];
}

export const PowerShellServer: LSPServerInfo = {
  id: "powershell",
  name: "PowerShell Editor Services",
  extensions: KIND_EXTENSIONS["powershell"],
  root: RootWithFallback(createRootDetector([".git"])),
  spawn(root, options) {
    return resolveAndLaunchBundle(
      {
        runtimeCandidates: ["pwsh", "powershell"],
        bundleToolId: "powershell-editor-services",
        cwd: root,
        args: buildPsesArgs,
      },
      options?.allowInstall,
    );
  },
};

export const CSharpServer: LSPServerInfo = {
  id: "csharp",
  name: "csharp-ls",
  extensions: KIND_EXTENSIONS["csharp"],
  root: createRootDetector([...DOTNET_CSHARP_ROOT_MARKERS]),
  async spawn(root, options) {
    const candidates = dotnetToolCandidates("csharp-ls");

    return resolveAndLaunch(
      {
        candidates,
        args: [],
        cwd: root,
        runtimeInstall: {
          runtimeCommand: "dotnet",
          install: () => tryDotnetToolInstall("csharp-ls"),
          retryCandidates: candidates,
        },
      },
      options?.allowInstall,
    );
  },
};

export const OmniSharpServer = createInteractiveServer({
  id: "omnisharp",
  name: "OmniSharp",
  extensions: KIND_EXTENSIONS["csharp"],
  root: createRootDetector([...DOTNET_CSHARP_ROOT_MARKERS]),
  language: "csharp",
  command: "OmniSharp",
  args: ["--languageserver"],
});

export const FSharpServer: LSPServerInfo = {
  id: "fsharp",
  name: "FSAutocomplete",
  extensions: KIND_EXTENSIONS["fsharp"],
  root: createRootDetector([...DOTNET_FSHARP_ROOT_MARKERS]),
  async spawn(root, options) {
    const candidates = dotnetToolCandidates("fsautocomplete");
    return resolveAndLaunch(
      {
        candidates,
        args: [],
        cwd: root,
        runtimeInstall: {
          runtimeCommand: "dotnet",
          install: () => tryDotnetToolInstall("fsautocomplete"),
          retryCandidates: candidates,
        },
      },
      options?.allowInstall,
    );
  },
};

export const JavaServer = createInteractiveServer({
  id: "java",
  name: "JDT Language Server",
  extensions: KIND_EXTENSIONS["java"],
  root: RootWithFallback(JavaWorkspaceRoot()),
  language: "java",
  command: () => process.env.JDTLS_PATH || "jdtls",
  args: (root) => createLombokJdtlsArgs(root),
  runtime: "java",
});

export const KotlinServer: LSPServerInfo = {
  id: "kotlin",
  name: "Kotlin Language Server",
  extensions: KIND_EXTENSIONS["kotlin"],
  root: RootWithFallback(createRootDetector(["build.gradle.kts", "build.gradle", "pom.xml"])),
  async spawn(root, options) {
    return resolveAndLaunch(
      {
        candidates: ["kotlin-lsp", "kotlin-language-server"],
        args: [],
        cwd: root,
      },
      options?.allowInstall,
    );
  },
};

export const SwiftServer = createInteractiveServer({
  id: "swift",
  name: "SourceKit-LSP",
  extensions: KIND_EXTENSIONS["swift"],
  root: createRootDetector(["Package.swift"]),
  language: "swift",
  command: "sourcekit-lsp",
});

export const DartServer = createInteractiveServer({
  id: "dart",
  name: "Dart Analysis Server",
  extensions: KIND_EXTENSIONS["dart"],
  root: RootWithFallback(createRootDetector(["pubspec.yaml"])),
  language: "dart",
  command: "dart",
  args: ["language-server", "--protocol=lsp"],
});

function createTreeBinaryServer(spec: {
  id: string;
  name: string;
  extensions: readonly string[];
  root: RootFunction;
  binaryName: string;
  binRelPath: string;
  args?: string[];
}): LSPServerInfo {
  return {
    id: spec.id,
    name: spec.name,
    extensions: spec.extensions,
    root: spec.root,
    spawn(root, options) {
      return resolveAndLaunchTreeBinary(
        {
          candidates: [spec.binaryName],
          bundleToolId: spec.binaryName,
          binRelPath: spec.binRelPath,
          cwd: root,
          args: spec.args ?? [],
        },
        options?.allowInstall,
      );
    },
  };
}

export const LuaServer: LSPServerInfo = createTreeBinaryServer({
  id: "lua",
  name: "Lua Language Server",
  extensions: KIND_EXTENSIONS["lua"],
  root: createRootDetector([".luarc.json", ".luacheckrc"]),
  binaryName: "lua-language-server",
  binRelPath: "bin/lua-language-server",
});

export const CppServer: LSPServerInfo = createTreeBinaryServer({
  id: "cpp",
  name: "clangd",
  extensions: KIND_EXTENSIONS["cxx"],
  root: RootWithFallback(
    createRootDetector(["compile_commands.json", ".clangd", "CMakeLists.txt", "Makefile"]),
  ),
  binaryName: "clangd",
  binRelPath: "bin/clangd",
  args: ["--background-index"],
});

export const ZigServer: LSPServerInfo = {
  id: "zig",
  name: "ZLS",
  extensions: KIND_EXTENSIONS["zig"],
  root: RootWithFallback(createRootDetector(["build.zig"])),
  spawn(root, options) {
    return resolveAndLaunch(
      {
        candidates: ["zls"],
        args: [],
        cwd: root,
        managedToolId: "zls",
      },
      options?.allowInstall,
    );
  },
};

export const HaskellServer = createInteractiveServer({
  id: "haskell",
  name: "Haskell Language Server",
  extensions: KIND_EXTENSIONS["haskell"],
  root: createRootDetector(["stack.yaml", "cabal.project", "*.cabal"]),
  language: "haskell",
  command: "haskell-language-server-wrapper",
  args: ["--lsp"],
});

export const ElixirServer = createInteractiveServer({
  id: "elixir",
  name: "ElixirLS",
  extensions: KIND_EXTENSIONS["elixir"],
  root: RootWithFallback(createRootDetector(["mix.exs"])),
  language: "elixir",
  command: "elixir-ls",
});

export const ElixirExpertServer: LSPServerInfo = {
  id: "expert",
  name: "Expert",
  extensions: KIND_EXTENSIONS["elixir"],
  root: RootWithFallback(createRootDetector(["mix.exs"])),
  availabilityKey: "expert",
  async spawn(root, options) {
    return resolveAndLaunch(
      {
        candidates: ["expert"],
        args: ["--stdio"],
        cwd: root,
        managedToolId: "expert",
      },
      options?.allowInstall,
    );
  },
  autoInstall: async () => Boolean(await ensureTool("expert")),
};

export const GleamServer: LSPServerInfo = {
  id: "gleam",
  name: "Gleam LSP",
  extensions: KIND_EXTENSIONS["gleam"],
  root: RootWithFallback(createRootDetector(["gleam.toml"])),
  async spawn(root, options) {
    return resolveAndLaunch(
      {
        candidates: ["gleam"],
        args: ["lsp"],
        cwd: root,
        managedToolId: "gleam",
      },
      options?.allowInstall,
    );
  },
};

export const MarksmanServer: LSPServerInfo = {
  id: "marksman",
  name: "Marksman",
  extensions: KIND_EXTENSIONS["markdown"],
  root: RootWithFallback(createRootDetector([".marksman.toml", ".git"])),
  spawn(root, options) {
    return resolveAndLaunch(
      {
        candidates: ["marksman"],
        args: ["server"],
        cwd: root,
        managedToolId: "marksman",
      },
      options?.allowInstall,
    );
  },
};

export const OCamlServer = createInteractiveServer({
  id: "ocaml",
  name: "ocamllsp",
  extensions: KIND_EXTENSIONS["ocaml"],
  root: createRootDetector(["dune-project", "opam"]),
  language: "ocaml",
  command: "ocamllsp",
});

export const ClojureServer: LSPServerInfo = {
  id: "clojure",
  name: "Clojure LSP",
  extensions: KIND_EXTENSIONS["clojure"],
  root: createRootDetector(["deps.edn", "project.clj"]),
  async spawn(root, options) {
    return resolveAndLaunch(
      {
        candidates: ["clojure-lsp"],
        args: [],
        cwd: root,
        managedToolId: "clojure-lsp",
      },
      options?.allowInstall,
    );
  },
};

export const CueServer: LSPServerInfo = {
  id: "cue",
  name: "CUE Language Server",
  extensions: KIND_EXTENSIONS["cue"],
  root: RootWithFallback(createRootDetector(["cue.mod", ".git"])),
  async spawn(root, options) {
    return resolveAndLaunch(
      {
        candidates: ["cue"],
        args: ["lsp", "serve"],
        cwd: root,
        managedToolId: "cue",
      },
      options?.allowInstall,
    );
  },
};

export const TerraformServer: LSPServerInfo = {
  id: "terraform",
  name: "Terraform LSP",
  extensions: KIND_EXTENSIONS["terraform"],
  root: RootWithFallback(createRootDetector([".terraform.lock.hcl", ".terraform"])),
  spawn(root, options) {
    return resolveAndLaunch(
      {
        candidates: ["terraform-ls"],
        args: ["serve"],
        cwd: root,
        managedToolId: "terraform-ls",
      },
      options?.allowInstall,
    );
  },
};

export const NixServer = createInteractiveServer({
  id: "nix",
  name: "nixd",
  extensions: KIND_EXTENSIONS["nix"],
  root: createRootDetector(["flake.nix"]),
  language: "nix",
  command: "nixd",
});

export const BashServer: LSPServerInfo = {
  id: "bash",
  name: "Bash Language Server",
  extensions: [".bash", ".sh", ".zsh"],
  root: FileDirRoot,
  spawn(root, options) {
    return resolveAndLaunch(
      {
        candidates: nodeBinCandidates(root, "bash-language-server"),
        args: ["start"],
        cwd: root,
        managedToolId: "bash-language-server",
      },
      options?.allowInstall,
    );
  },
};

export const FishServer: LSPServerInfo = {
  id: "fish",
  name: "Fish Language Server",
  extensions: KIND_EXTENSIONS["fish"],
  root: RootWithFallback(createRootDetector([".git"])),
  spawn(root, options) {
    return resolveAndLaunch(
      {
        candidates: nodeBinCandidates(root, "fish-lsp"),
        args: ["start"],
        cwd: root,
        managedToolId: "fish-lsp",
      },
      options?.allowInstall,
    );
  },
};

export const CMakeServer: LSPServerInfo = {
  id: "cmake",
  name: "CMake Language Server",
  extensions: [...KIND_EXTENSIONS["cmake"], "CMakeLists.txt"],
  root: RootWithFallback(createRootDetector(["CMakeLists.txt", ".git"])),
  spawn(root, options) {
    return resolveAndLaunch(
      {
        candidates: ["cmake-language-server"],
        args: [],
        cwd: root,
        managedToolId: "cmake-language-server",
      },
      options?.allowInstall,
    );
  },
};

export const DockerServer: LSPServerInfo = {
  id: "docker",
  name: "Dockerfile Language Server",
  extensions: [".dockerfile", "Dockerfile"],
  root: RootWithFallback(
    PriorityRoot([
      ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"],
      [".git"],
    ]),
  ),
  spawn(root, options) {
    return resolveAndLaunch(
      {
        candidates: nodeBinCandidates(root, "docker-langserver"),
        args: ["--stdio"],
        cwd: root,
        managedToolId: "dockerfile-language-server-nodejs",
      },
      options?.allowInstall,
    );
  },
};

export const YamlServer: LSPServerInfo = {
  id: "yaml",
  name: "YAML Language Server",
  extensions: KIND_EXTENSIONS["yaml"],
  root: RootWithFallback(
    PriorityRoot([[".yamllint", "yamllint.yml", "yamllint.yaml", "pyproject.toml"], [".git"]]),
  ),
  spawn(root, options) {
    return resolveAndLaunch(
      {
        candidates: nodeBinCandidates(root, "yaml-language-server"),
        args: ["--stdio"],
        cwd: root,
        managedToolId: "yaml-language-server",
      },
      options?.allowInstall,
    );
  },
};

export const JsonServer: LSPServerInfo = {
  id: "json",
  name: "VSCode JSON Language Server",
  extensions: KIND_EXTENSIONS["json"],
  root: RootWithFallback(
    WorkspacePriorityRoot([["package.json", "tsconfig.json", "jsconfig.json"], [".git"]]),
  ),
  spawn(root, options) {
    return resolveAndLaunch(
      {
        candidates: ["vscode-json-language-server"],
        args: ["--stdio"],
        cwd: root,
        managedToolId: "vscode-json-language-server",
      },
      options?.allowInstall,
    );
  },
};

export const HtmlServer: LSPServerInfo = {
  id: "html",
  name: "VSCode HTML Language Server",
  extensions: KIND_EXTENSIONS["html"],
  root: RootWithFallback(
    IgnoreHomeRoot(PriorityRoot([["package.json", "index.html", "vite.config.ts"]])),
  ),
  spawn(root, options) {
    return resolveAndLaunch(
      {
        candidates: nodeBinCandidates(root, "vscode-html-language-server"),
        args: ["--stdio"],
        cwd: root,
        managedToolId: "vscode-html-languageserver-bin",
      },
      options?.allowInstall,
    );
  },
};

export const TomlServer: LSPServerInfo = {
  id: "toml",
  name: "Taplo",
  extensions: KIND_EXTENSIONS["toml"],
  root: RootWithFallback(PriorityRoot([["pyproject.toml", "Cargo.toml", "taplo.toml"], [".git"]])),
  spawn(root, options) {
    return resolveAndLaunch(
      {
        candidates: ["taplo"],
        args: ["lsp", "stdio"],
        cwd: root,
        managedToolId: "taplo",
      },
      options?.allowInstall,
    );
  },
};

export const PrismaServer: LSPServerInfo = {
  id: "prisma",
  name: "Prisma Language Server",
  extensions: KIND_EXTENSIONS["prisma"],
  root: RootWithFallback(createRootDetector(["prisma/schema.prisma", "schema.prisma"])),
  spawn(root, options) {
    return resolveAndLaunch(
      {
        candidates: nodeBinCandidates(root, "prisma-language-server"),
        args: ["--stdio"],
        cwd: root,
        managedToolId: "@prisma/language-server",
      },
      options?.allowInstall,
    );
  },
};

export const VueServer: LSPServerInfo = {
  id: "vue",
  name: "Vue Language Server",
  extensions: [".vue"],
  root: RootWithFallback(
    IgnoreHomeRoot(
      createRootDetector([
        "package.json",
        "package-lock.json",
        "bun.lockb",
        "bun.lock",
        "pnpm-lock.yaml",
        "yarn.lock",
      ]),
    ),
  ),
  async spawn(root, options) {
    const tsserverPath = await findTsserverPath(root, options?.allowInstall);

    const hasPackageJson = existsSync(path.join(root, "package.json"));
    const hasNodeModules = existsSync(path.join(root, "node_modules"));
    if (hasPackageJson && !hasNodeModules) {
      logSessionStart(
        `lsp vue: node_modules missing in ${root} — Vue navigation may be limited. ` +
          `Run: npm install (or pnpm/yarn install) in this project.`,
      );
    }

    const proc = await resolveAndLaunch(
      {
        candidates: nodeBinCandidates(root, "vue-language-server"),
        args: ["--stdio"],
        cwd: root,
        managedToolId: "@vue/language-server",
      },
      options?.allowInstall,
    );
    if (!proc) return undefined;
    return {
      process: proc.process,
      source: proc.source,
      initialization: tsserverPath
        ? { typescript: { tsdk: path.dirname(tsserverPath) } }
        : undefined,
    };
  },
};

export const SvelteServer: LSPServerInfo = {
  id: "svelte",
  name: "Svelte Language Server",
  extensions: [".svelte"],
  root: RootWithFallback(
    IgnoreHomeRoot(
      createRootDetector([
        "package.json",
        "package-lock.json",
        "bun.lockb",
        "bun.lock",
        "pnpm-lock.yaml",
        "yarn.lock",
      ]),
    ),
  ),
  async spawn(root, options) {
    const tsserverPath = await findTsserverPath(root, options?.allowInstall);
    const proc = await resolveAndLaunch(
      {
        candidates: [
          ...nodeBinCandidates(root, "svelteserver"),
          ...nodeBinCandidates(root, "svelte-language-server"),
        ],
        args: ["--stdio"],
        cwd: root,
        managedToolId: "svelte-language-server",
      },
      options?.allowInstall,
    );
    if (!proc) return undefined;
    return {
      process: proc.process,
      source: proc.source,
      initialization: tsserverPath
        ? { typescript: { tsdk: path.dirname(tsserverPath) } }
        : undefined,
    };
  },
};

export const CssServer: LSPServerInfo = {
  id: "css",
  name: "CSS Language Server",
  extensions: KIND_EXTENSIONS["css"],
  root: RootWithFallback(
    IgnoreHomeRoot(
      PriorityRoot([["package.json", "postcss.config.js", "tailwind.config.js", "vite.config.ts"]]),
    ),
  ),
  spawn(root, options) {
    return resolveAndLaunch(
      {
        candidates: nodeBinCandidates(root, "vscode-css-language-server"),
        args: ["--stdio"],
        cwd: root,
        managedToolId: "vscode-css-languageserver",
      },
      options?.allowInstall,
    );
  },
};

const OPENGREP_KINDS = [
  "csharp",
  "css",
  "cxx",
  "dart",
  "docker",
  "go",
  "html",
  "java",
  "json",
  "jsts",
  "kotlin",
  "lua",
  "php",
  "python",
  "ruby",
  "rust",
  "shell",
  "swift",
  "terraform",
  "yaml",
] as const;
function extensionsForKind(kind: string): readonly string[] {
  return Object.entries(KIND_EXTENSIONS).find(([candidate]) => candidate === kind)?.[1] ?? [];
}

const OPENGREP_EXTENSIONS: readonly string[] = Array.from(
  new Set(OPENGREP_KINDS.flatMap(extensionsForKind)),
);

function opengrepInitialization(root: string): InitializationConfig {
  const resolved = resolveOpengrepConfig(root, { enabled: true });
  return buildOpengrepInitialization(resolved.configArg ?? "auto");
}

export const OpengrepServer: LSPServerInfo = {
  id: "opengrep",
  name: "Opengrep Security Scanner",
  role: "auxiliary",
  extensions: OPENGREP_EXTENSIONS,
  root: RootWithFallback(NearestRoot([".git"]), async () => process.cwd()),
  availabilityKey: "opengrep",
  initializeTimeoutMs: 15000,
  async spawn(root, options) {
    const launched = await resolveAndLaunch(
      {
        candidates: ["opengrep"],
        args: ["lsp", "--experimental"],
        cwd: root,
        managedToolId: "opengrep",
      },
      options?.allowInstall,
    );
    if (!launched) return undefined;
    return { ...launched, initialization: opengrepInitialization(root) };
  },
  autoInstall: async () => Boolean(await ensureTool("opengrep")),
};

const AST_GREP_KINDS = [
  "csharp",
  "cxx",
  "css",
  "elixir",
  "go",
  "haskell",
  "html",
  "java",
  "json",
  "jsts",
  "kotlin",
  "lua",
  "nix",
  "php",
  "python",
  "ruby",
  "rust",
  "scala",
  "shell",
  "solidity",
  "swift",
  "yaml",
] as const;
const AST_GREP_EXTENSIONS: readonly string[] = Array.from(
  new Set(AST_GREP_KINDS.flatMap(extensionsForKind)),
);

export const AstGrepServer: LSPServerInfo = {
  id: "ast-grep",
  name: "ast-grep structural linter",
  role: "auxiliary",
  extensions: AST_GREP_EXTENSIONS,
  root: RootWithFallback(
    createRootDetector(["sgconfig.yml", "sgconfig.yaml"]),
    RootWithFallback(NearestRoot([".git"]), async () => process.cwd()),
  ),
  availabilityKey: "ast-grep",
  notifyInflightLimit: 4,
  initializeTimeoutMs: 15000,
  async spawn(root, options) {
    const projectSgconfig = findLocalSgconfig(root);
    let args = ["lsp"];
    if (!projectSgconfig) {
      const baseline = resolveBaselineSgconfig(root);
      if (baseline) args = ["lsp", "--config", baseline];
    }
    const nativeExe = resolveAstGrepNativeExe();
    const candidates = nativeExe ? [nativeExe, "ast-grep"] : ["ast-grep"];
    return resolveAndLaunch(
      {
        candidates,
        args,
        cwd: root,
        managedToolId: "ast-grep",
      },
      options?.allowInstall,
    );
  },
  autoInstall: async () => Boolean(await ensureTool("ast-grep")),
};

const ZIZMOR_EXTENSIONS: readonly string[] = KIND_EXTENSIONS["yaml"];

export const ZizmorServer: LSPServerInfo = {
  id: "zizmor",
  name: "zizmor Actions Security Scanner",
  role: "auxiliary",
  extensions: ZIZMOR_EXTENSIONS,
  pathFilter: isZizmorAuditTarget,
  root: RootWithFallback(NearestRoot([".git"]), async () => process.cwd()),
  availabilityKey: "zizmor",
  async spawn(root, options) {
    const ghToken = await resolveZizmorGitHubToken();
    const launchSpec: ResolveAndLaunchSpec = {
      candidates: ["zizmor"],
      args: ["--lsp"],
      cwd: root,
      managedToolId: "zizmor",
    };
    if (ghToken) launchSpec.env = { GH_TOKEN: ghToken };
    return resolveAndLaunch(launchSpec, options?.allowInstall);
  },
  autoInstall: async () => Boolean(await ensureTool("zizmor")),
};

const TYPOS_EXTENSIONS: readonly string[] = Array.from(
  new Set([...OPENGREP_EXTENSIONS, ...KIND_EXTENSIONS["markdown"]]),
);

function typosInitialization(root: string): InitializationConfig | undefined {
  const localConfig = findLocalTyposConfig(root);
  if (localConfig) {
    logLatency({
      type: "phase",
      phase: "typos_config_resolved",
      filePath: root,
      durationMs: 0,
      metadata: { mode: "project_config", configPath: localConfig },
    });
    logSessionStart(`typos config resolved mode=project_config configPath=${localConfig}`);
    return undefined;
  }
  const configPath = resolvePackagePath(import.meta.url, "rules", "typos", "_typos.toml");
  logLatency({
    type: "phase",
    phase: "typos_config_resolved",
    filePath: root,
    durationMs: 0,
    metadata: { mode: "injected_default", configPath },
  });
  logSessionStart(`typos config resolved mode=injected_default configPath=${configPath}`);
  return { config: configPath };
}

export const TyposServer: LSPServerInfo = {
  id: "typos",
  name: "typos Spell Checker",
  role: "auxiliary",
  extensions: TYPOS_EXTENSIONS,
  root: RootWithFallback(NearestRoot([".git"]), async () => process.cwd()),
  availabilityKey: "typos-lsp",
  async spawn(root, options) {
    const launched = await resolveAndLaunch(
      {
        candidates: ["typos-lsp"],
        args: [],
        cwd: root,
        managedToolId: "typos-lsp",
      },
      options?.allowInstall,
    );
    if (!launched) return undefined;
    const initialization = typosInitialization(root);
    return initialization ? { ...launched, initialization } : launched;
  },
  autoInstall: async () => Boolean(await ensureTool("typos-lsp")),
};

export const LSP_SERVERS: LSPServerInfo[] = [
  TypeScriptServer,
  DenoServer,
  PythonServer,
  PythonJediServer,
  GoServer,
  RustServer,
  RubyServer,
  PHPServer,
  PowerShellServer,
  CSharpServer,
  OmniSharpServer,
  FSharpServer,
  JavaServer,
  KotlinServer,
  SwiftServer,
  DartServer,
  LuaServer,
  CppServer,
  ZigServer,
  HaskellServer,
  ElixirServer,
  ElixirExpertServer,
  GleamServer,
  MarksmanServer,
  OCamlServer,
  ClojureServer,
  CueServer,
  TerraformServer,
  NixServer,
  BashServer,
  FishServer,
  CMakeServer,
  DockerServer,
  YamlServer,
  JsonServer,
  HtmlServer,
  TomlServer,
  PrismaServer,
  VueServer,
  SvelteServer,
  CssServer,
  OpengrepServer,
  AstGrepServer,
  ZizmorServer,
  TyposServer,
];

export function getServerForExtension(ext: string): LSPServerInfo | undefined {
  return LSP_SERVERS.find((server) => server.extensions.includes(ext));
}

export function getServerById(id: string): LSPServerInfo | undefined {
  return LSP_SERVERS.find((server) => server.id === id);
}

export function getServersForFile(filePath: string): LSPServerInfo[] {
  const ext = path.extname(filePath).toLowerCase();
  return LSP_SERVERS.filter((server) => server.extensions.includes(ext));
}
