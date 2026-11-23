export const STALE_HEARTBEAT_MS = 6 * 60 * 60 * 1000;

import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomicAsync } from "./atomic-write.ts";
import { type AtomicStageSweepResult, sweepOwnStagingFiles } from "./atomic-write-staging.ts";
import { spawnCollectStdout, unrefChildAndPipes } from "./child-unref.ts";
import { getGlobalPiLensDir } from "./file-utils.ts";
import {
  type InstanceEntry,
  isInstanceRegistryEnabled,
  readInstanceRegistry,
} from "./instance-registry.ts";
import { logLatency } from "./latency-logger.ts";

const isWindows = process.platform === "win32";

export interface ChildToKill {
  pid: number;
  serverId: string;
  command: string;
}

export interface MarkerSearch {
  marker: string;
  serverId: string;
}

export interface OrphanReapDecision {
  deadInstances: InstanceEntry[];
  staleInstances: InstanceEntry[];
  childrenToKill: ChildToKill[];
  markerSearches: MarkerSearch[];
}

function isInstanceKillEligible(
  instance: InstanceEntry,
  isPidAlive: (pid: number) => boolean,
): boolean {
  return !isPidAlive(instance.pid);
}

function isInstanceEntryStale(instance: InstanceEntry, now: number): boolean {
  const heartbeatMs = Date.parse(instance.heartbeatAt);
  if (Number.isNaN(heartbeatMs)) return true;
  return now - heartbeatMs > STALE_HEARTBEAT_MS;
}

function collectLiveMarkers(
  registry: InstanceEntry[],
  isPidAlive: (pid: number) => boolean,
): Set<string> {
  const liveMarkers = new Set<string>();
  for (const instance of registry) {
    if (!isPidAlive(instance.pid)) continue;
    for (const child of instance.lspChildren) {
      if (child.marker) liveMarkers.add(child.marker);
    }
  }
  return liveMarkers;
}

function classifyDeadInstanceChildren(
  instance: InstanceEntry,
  isPidAlive: (pid: number) => boolean,
  matchProcess:
    | ((pid: number, expected: { command: string; marker?: string }) => boolean)
    | undefined,
  liveMarkers: Set<string>,
  out: { childrenToKill: ChildToKill[]; markerSearches: MarkerSearch[] },
): void {
  for (const child of instance.lspChildren) {
    const childAlive = isPidAlive(child.pid);
    if (childAlive) {
      const identityOk = matchProcess
        ? matchProcess(child.pid, {
            command: child.command,
            marker: child.marker,
          })
        : true;
      if (identityOk) {
        out.childrenToKill.push({
          pid: child.pid,
          serverId: child.serverId,
          command: child.command,
        });
        continue;
      }
    }
    if (child.marker && !liveMarkers.has(child.marker)) {
      out.markerSearches.push({
        marker: child.marker,
        serverId: child.serverId,
      });
    }
  }
}

export function decideOrphanReaping(
  registry: InstanceEntry[],
  isPidAlive: (pid: number) => boolean,
  matchProcess?: (pid: number, expected: { command: string; marker?: string }) => boolean,
  now: number = Date.now(),
): OrphanReapDecision {
  const deadInstances: InstanceEntry[] = [];
  const staleInstances: InstanceEntry[] = [];
  const childrenToKill: ChildToKill[] = [];
  const markerSearches: MarkerSearch[] = [];

  const liveMarkers = collectLiveMarkers(registry, isPidAlive);

  for (const instance of registry) {
    if (isInstanceKillEligible(instance, isPidAlive)) {
      deadInstances.push(instance);
      classifyDeadInstanceChildren(instance, isPidAlive, matchProcess, liveMarkers, {
        childrenToKill,
        markerSearches,
      });
    } else if (isInstanceEntryStale(instance, now)) {
      staleInstances.push(instance);
    }
  }

  return { deadInstances, staleInstances, childrenToKill, markerSearches };
}

export function realIsPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = err instanceof Error && "code" in err ? err.code : undefined;
    if (code === "ESRCH") return false;
    return true;
  }
}

export const ATOMIC_STAGE_SWEEP_MAX_ENTRIES = 512;

export type { AtomicStageSweepResult } from "./atomic-write-staging.ts";

export interface AtomicStageSweepOptions {
  maxEntries?: number;
  isPidAlive?: (pid: number) => boolean;
}

export async function sweepAtomicWriteStages(
  directories: readonly string[],
  options: AtomicStageSweepOptions = {},
): Promise<AtomicStageSweepResult> {
  const requestedMax = options.maxEntries ?? ATOMIC_STAGE_SWEEP_MAX_ENTRIES;
  const maxEntries = Number.isFinite(requestedMax)
    ? Math.max(1, Math.floor(requestedMax))
    : ATOMIC_STAGE_SWEEP_MAX_ENTRIES;
  const isPidAlive = options.isPidAlive ?? realIsPidAlive;
  return sweepOwnStagingFiles(directories, { maxEntries, isPidAlive });
}

function windowsExe(name: string): string {
  return path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32", name);
}

function posixPsPath(): string {
  if (fs.existsSync("/bin/ps")) return "/bin/ps";
  if (fs.existsSync("/usr/bin/ps")) return "/usr/bin/ps";
  return "/bin/ps";
}

function escapeWqlLikeValue(value: string): string {
  return value.replaceAll("'", "''").replaceAll(/[%_]/g, (ch) => `[${ch}]`);
}

async function findPidsByMarkerWindows(marker: string): Promise<number[]> {
  if (!isWindows || !marker) return [];
  const escaped = escapeWqlLikeValue(marker);
  const psScript =
    `Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${escaped}%'" ` +
    `| Where-Object { $_.ProcessId -ne $PID } ` +
    `| Select-Object -ExpandProperty ProcessId`;
  const powershell = windowsExe("WindowsPowerShell\\v1.0\\powershell.exe");
  const out = await spawnCollectStdout(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", psScript],
    { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  return out
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

async function queryCommandLines(pids: number[]): Promise<Map<number, string>> {
  const valid = [...new Set(pids.filter((p) => Number.isFinite(p) && p > 0))];
  const map = new Map<number, string>();
  if (valid.length === 0) return map;
  if (isWindows) {
    const filter = valid.map((p) => `ProcessId=${p}`).join(" OR ");
    const psScript =
      `Get-CimInstance Win32_Process -Filter "${filter}" ` +
      `| ForEach-Object { "$($_.ProcessId)\t$($_.CommandLine)" }`;
    const powershell = windowsExe("WindowsPowerShell\\v1.0\\powershell.exe");
    const out = await spawnCollectStdout(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", psScript],
      { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    for (const line of out.split(/\r?\n/)) {
      const tab = line.indexOf("\t");
      if (tab <= 0) continue;
      const pid = Number(line.slice(0, tab).trim());
      if (Number.isFinite(pid) && pid > 0) map.set(pid, line.slice(tab + 1));
    }
    return map;
  }
  const out = await spawnCollectStdout(posixPsPath(), ["-p", valid.join(","), "-o", "pid=,args="], {
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
  });
  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed) continue;
    let i = 0;
    while (i < trimmed.length && trimmed[i] >= "0" && trimmed[i] <= "9") i++;
    if (i === 0) continue;
    const pidStr = trimmed.slice(0, i);
    let j = i;
    while (j < trimmed.length && (trimmed[j] === " " || trimmed[j] === "\t")) j++;
    const pid = Number(pidStr);
    if (Number.isFinite(pid) && pid > 0) map.set(pid, trimmed.slice(j));
  }
  return map;
}

export function buildIdentityMatcher(
  cmdlines: Map<number, string>,
): (pid: number, expected: { command: string; marker?: string }) => boolean {
  return (pid, expected) => {
    const cmdline = cmdlines.get(pid);
    if (cmdline === undefined) return false;
    if (expected.marker && cmdline.includes(expected.marker)) return true;
    const basename = path.basename(expected.command ?? "").toLowerCase();
    if (!basename) return false;
    return cmdline.toLowerCase().includes(basename);
  };
}

async function killPidTree(pid: number): Promise<void> {
  if (!Number.isFinite(pid) || pid <= 0) return;
  if (isWindows) {
    try {
      const taskkill = windowsExe("taskkill.exe");
      const killer = nodeSpawn(taskkill, ["/F", "/T", "/PID", String(pid)], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      unrefChildAndPipes(killer);
      await new Promise<void>((resolve) => {
        killer.once("close", () => resolve());
        killer.once("error", () => resolve());
      });
    } catch {}
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

export const MANAGED_BINARY_NAMES: readonly string[] = [
  "ast-grep",
  "opengrep-core",
  "opengrep",
  "marksman",
  "zizmor",
  "typos-lsp",
  "yaml-language-server",
  "typescript-language-server",
];

export interface OsProcessInfo {
  pid: number;
  parentPid: number;
  command: string;
}

export function decideBackstopOrphanReaping(
  processes: OsProcessInfo[],
  registry: InstanceEntry[],
  isPidAlive: (pid: number) => boolean,
): OsProcessInfo[] {
  const trackedPids = new Set<number>();
  for (const instance of registry) {
    for (const child of instance.lspChildren) trackedPids.add(child.pid);
  }

  const out: OsProcessInfo[] = [];
  for (const proc of processes) {
    if (trackedPids.has(proc.pid)) continue;
    if (!Number.isFinite(proc.parentPid) || proc.parentPid <= 0) continue;
    if (proc.parentPid === proc.pid) continue;
    if (isPidAlive(proc.parentPid)) continue;
    out.push(proc);
  }
  return out;
}

async function enumerateManagedProcesses(): Promise<OsProcessInfo[]> {
  if (isWindows) {
    const clauses = MANAGED_BINARY_NAMES.map(
      (name) => `CommandLine LIKE '%${escapeWqlLikeValue(name)}%'`,
    ).join(" OR ");
    const psScript =
      `Get-CimInstance Win32_Process -Filter "${clauses}" ` +
      `| ForEach-Object { "$($_.ProcessId)\t$($_.ParentProcessId)\t$($_.CommandLine)" }`;
    const powershell = windowsExe("WindowsPowerShell\\v1.0\\powershell.exe");
    const out = await spawnCollectStdout(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", psScript],
      { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    const results: OsProcessInfo[] = [];
    for (const line of out.split(/\r?\n/)) {
      const firstTab = line.indexOf("\t");
      if (firstTab <= 0) continue;
      const secondTab = line.indexOf("\t", firstTab + 1);
      if (secondTab <= 0) continue;
      const pid = Number(line.slice(0, firstTab).trim());
      const parentPid = Number(line.slice(firstTab + 1, secondTab).trim());
      const command = line.slice(secondTab + 1);
      if (Number.isFinite(pid) && pid > 0) {
        results.push({ pid, parentPid, command });
      }
    }
    return results;
  }
  const out = await spawnCollectStdout(posixPsPath(), ["-eo", "pid=,ppid=,args="], {
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const results: OsProcessInfo[] = [];
  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed) continue;
    let i = 0;
    while (i < trimmed.length && trimmed[i] >= "0" && trimmed[i] <= "9") i++;
    if (i === 0) continue;
    const pid = Number(trimmed.slice(0, i));
    let rest = trimmed.slice(i);
    let k = 0;
    while (k < rest.length && (rest[k] === " " || rest[k] === "\t")) k++;
    rest = rest.slice(k);
    let j = 0;
    while (j < rest.length && rest[j] >= "0" && rest[j] <= "9") j++;
    if (j === 0) continue;
    const parentPid = Number(rest.slice(0, j));
    let m = j;
    while (m < rest.length && (rest[m] === " " || rest[m] === "\t")) m++;
    const args = rest.slice(m);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const lowerArgs = args.toLowerCase();
    if (MANAGED_BINARY_NAMES.some((name) => lowerArgs.includes(name.toLowerCase()))) {
      results.push({ pid, parentPid, command: args });
    }
  }
  return results;
}

export async function sweepUntrackedOrphans(): Promise<void> {
  if (!isInstanceRegistryEnabled()) return;
  const startedAt = Date.now();
  try {
    const [registry, processes] = await Promise.all([
      readInstanceRegistry(),
      enumerateManagedProcesses(),
    ]);
    if (processes.length === 0) return;

    const candidates = decideBackstopOrphanReaping(processes, registry, realIsPidAlive);

    let killedCount = 0;
    for (const proc of candidates) {
      await killPidTree(proc.pid);
      killedCount++;
    }

    try {
      logLatency({
        type: "phase",
        phase: "orphan_backstop_reaped",
        filePath: "",
        durationMs: Date.now() - startedAt,
        metadata: {
          scanned: processes.length,
          killed: killedCount,
        },
      });
    } catch {}
  } catch {}
}

export async function sweepOrphans(): Promise<void> {
  if (!isInstanceRegistryEnabled()) return;
  const startedAt = Date.now();
  try {
    const registry = await readInstanceRegistry();
    if (registry.length === 0) return;

    const candidatePids = registry.flatMap((instance) =>
      instance.lspChildren.map((child) => child.pid),
    );
    const cmdlines = await queryCommandLines(candidatePids);
    const matchProcess = buildIdentityMatcher(cmdlines);

    const decision = decideOrphanReaping(registry, realIsPidAlive, matchProcess);

    let killedCount = 0;
    const killedServerIds: string[] = [];

    for (const child of decision.childrenToKill) {
      await killPidTree(child.pid);
      killedCount++;
      killedServerIds.push(child.serverId);
    }

    for (const search of decision.markerSearches) {
      try {
        const pids = await findPidsByMarkerWindows(search.marker);
        for (const pid of pids) {
          await killPidTree(pid);
          killedCount++;
          killedServerIds.push(search.serverId);
        }
      } catch {}
    }

    if (decision.deadInstances.length > 0 || decision.staleInstances.length > 0) {
      try {
        const prunePids = new Set([
          ...decision.deadInstances.map((i) => i.pid),
          ...decision.staleInstances.map((i) => i.pid),
        ]);
        await pruneDeadInstances(prunePids);
      } catch {}
    }

    try {
      logLatency({
        type: "phase",
        phase: "orphan_lsp_reaped",
        filePath: "",
        durationMs: Date.now() - startedAt,
        metadata: {
          deadInstances: decision.deadInstances.length,
          staleInstances: decision.staleInstances.length,
          killed: killedCount,
          serverIds: killedServerIds,
          markerSearches: decision.markerSearches.length,
        },
      });
    } catch {}
  } catch {}
}

export async function pruneDeadInstances(deadPids: Set<number>): Promise<void> {
  const target = path.join(getGlobalPiLensDir(), "instances.json");
  try {
    const raw = await fs.promises.readFile(target, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.instances)) return;
    const remaining = parsed.instances.filter((entry: InstanceEntry) => !deadPids.has(entry.pid));
    if (remaining.length === parsed.instances.length) return;
    await fs.promises.mkdir(getGlobalPiLensDir(), { recursive: true });
    await writeFileAtomicAsync(target, JSON.stringify({ instances: remaining }));
  } catch {}
}
