import * as path from "node:path";
import pidusage from "pidusage";
import { spawnCollectStdout } from "./child-unref.ts";

type StartSpawnUsageSamplerResultContract = { stop: () => SpawnUsageSummary | null };

function runningOnWindows(): boolean {
  return process.platform === "win32";
}

export interface ProcessUsage {
  rssBytes: number;
  cpuPercent: number;
}

export function walkDescendantPids(rootPid: number, pairs: Array<[number, number]>): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const [pid, ppid] of pairs) {
    const list = childrenByParent.get(ppid);
    if (list) list.push(pid);
    else childrenByParent.set(ppid, [pid]);
  }

  const descendants: number[] = [];
  const queue = [rootPid];
  const visited = new Set<number>([rootPid]);
  while (queue.length > 0) {
    // SAFETY: The enclosing non-empty queue check guarantees this removal returns an element.
    const current = queue.shift() as number;
    for (const child of childrenByParent.get(current) ?? []) {
      if (visited.has(child)) continue;
      visited.add(child);
      descendants.push(child);
      queue.push(child);
    }
  }
  return descendants;
}

async function findDescendantPidsWindows(rootPid: number): Promise<number[]> {
  if (!runningOnWindows() || !Number.isFinite(rootPid) || rootPid <= 0) return [];
  const psScript =
    "Get-CimInstance Win32_Process " +
    "| Select-Object -Property ProcessId,ParentProcessId " +
    '| ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId)" }';
  const powershell = path.join(
    process.env.SystemRoot ?? String.raw`C:\Windows`,
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const out = await spawnCollectStdout(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", psScript],
    { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  const pairs: Array<[number, number]> = [];
  for (const line of out.split(/\r?\n/)) {
    const [pidStr, ppidStr] = line.split(",");
    const pid = Number(pidStr);
    const ppid = Number(ppidStr);
    if (Number.isFinite(pid) && Number.isFinite(ppid)) {
      pairs.push([pid, ppid]);
    }
  }

  return walkDescendantPids(rootPid, pairs);
}

interface WindowsCpuHistoryEntry {
  cpuMs: number;
  ts: number;
}
const windowsCpuHistory = new Map<number, WindowsCpuHistoryEntry>();
const CPU_HISTORY_MAX_AGE_MS = 60_000;

export function __resetWindowsCpuHistoryForTests(): void {
  windowsCpuHistory.clear();
}

async function sampleProcessesWindows(valid: number[]): Promise<Map<number, ProcessUsage>> {
  const result = new Map<number, ProcessUsage>();
  if (valid.length === 0) return result;

  const filter = valid.map((p) => `ProcessId=${p}`).join(" or ");
  const psScript =
    `Get-CimInstance Win32_Process -Filter "${filter}" ` +
    "| Select-Object -Property ProcessId,WorkingSetSize,KernelModeTime,UserModeTime " +
    '| ForEach-Object { "$($_.ProcessId),$($_.WorkingSetSize),$($_.KernelModeTime),$($_.UserModeTime)" }';

  const powershell = path.join(
    process.env.SystemRoot ?? String.raw`C:\Windows`,
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const out = await spawnCollectStdout(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", psScript],
    { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  try {
    const now = Date.now();
    const seen = new Set<number>();
    for (const line of out.split(/\r?\n/)) {
      const parts = line.split(",");
      if (parts.length < 4) continue;
      const pid = Number(parts[0]);
      const workingSet = Number(parts[1]);
      const kernel100ns = Number(parts[2]);
      const user100ns = Number(parts[3]);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      if (!Number.isFinite(workingSet)) continue;

      const cpuMs = Math.round(kernel100ns / 1e4) + Math.round(user100ns / 1e4);
      const prev = windowsCpuHistory.get(pid);
      let cpuPercent = 0;
      if (prev) {
        const wallMs = now - prev.ts;
        if (wallMs > 0) {
          cpuPercent = ((cpuMs - prev.cpuMs) / wallMs) * 100;
          if (!Number.isFinite(cpuPercent) || cpuPercent < 0) cpuPercent = 0;
        }
      }
      windowsCpuHistory.set(pid, { cpuMs, ts: now });
      seen.add(pid);
      result.set(pid, { rssBytes: workingSet, cpuPercent });
    }
    for (const [pid, entry] of windowsCpuHistory) {
      if (!seen.has(pid) && now - entry.ts > CPU_HISTORY_MAX_AGE_MS) {
        windowsCpuHistory.delete(pid);
      }
    }
  } catch {}
  return result;
}

export async function sampleProcesses(pids: number[]): Promise<Map<number, ProcessUsage>> {
  const result = new Map<number, ProcessUsage>();
  const valid = [...new Set(pids.filter((p) => Number.isFinite(p) && p > 0))];
  if (valid.length === 0) return result;

  if (runningOnWindows()) {
    return await sampleProcessesWindows(valid);
  }

  try {
    const stats = await pidusage(valid);
    for (const pid of valid) {
      const stat = stats[String(pid)];
      if (!stat) continue;
      result.set(pid, {
        rssBytes: stat.memory,
        cpuPercent: stat.cpu,
      });
    }
  } catch {}
  return result;
}

export class UsageAccumulator {
  private sampleCount = 0;
  private cpuSum = 0;
  private rssSum = 0;
  private cpuPeak = 0;
  private rssPeak = 0;

  addSample(usage: ProcessUsage): void {
    this.sampleCount++;
    this.cpuSum += usage.cpuPercent;
    this.rssSum += usage.rssBytes;
    if (usage.cpuPercent > this.cpuPeak) this.cpuPeak = usage.cpuPercent;
    if (usage.rssBytes > this.rssPeak) this.rssPeak = usage.rssBytes;
  }

  get count(): number {
    return this.sampleCount;
  }

  summarize(): {
    sampleCount: number;
    avgCpuPercent: number;
    peakCpuPercent: number;
    avgRssBytes: number;
    peakRssBytes: number;
  } | null {
    if (this.sampleCount === 0) return null;
    return {
      sampleCount: this.sampleCount,
      avgCpuPercent: this.cpuSum / this.sampleCount,
      peakCpuPercent: this.cpuPeak,
      avgRssBytes: this.rssSum / this.sampleCount,
      peakRssBytes: this.rssPeak,
    };
  }
}

export interface SpawnUsageSummary {
  sampleCount: number;
  avgCpuPercent: number;
  peakCpuPercent: number;
  avgRssBytes: number;
  peakRssBytes: number;
}

export function startSpawnUsageSampler(
  pid: number | undefined,
  intervalMs = 750,
): StartSpawnUsageSamplerResultContract {
  // SAFETY: The adjacent finite-number or TypeBox check establishes the numeric representation before this assertion.
  if (!Number.isFinite(pid) || (pid as number) <= 0) {
    return { stop: () => null };
  }

  // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
  const targetPid = pid as number;
  const accumulator = new UsageAccumulator();
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const pids = runningOnWindows()
        ? [targetPid, ...(await findDescendantPidsWindows(targetPid))]
        : [targetPid];
      const usageByPid = await sampleProcesses(pids);
      if (stopped || usageByPid.size === 0) return;
      let rssBytes = 0;
      let cpuPercent = 0;
      for (const usage of usageByPid.values()) {
        rssBytes += usage.rssBytes;
        cpuPercent += usage.cpuPercent;
      }
      accumulator.addSample({ rssBytes, cpuPercent });
    } catch {}
  };

  void tick();
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();

  return {
    stop(): SpawnUsageSummary | null {
      if (stopped) return accumulator.summarize();
      stopped = true;
      clearInterval(timer);
      return accumulator.summarize();
    },
  };
}
