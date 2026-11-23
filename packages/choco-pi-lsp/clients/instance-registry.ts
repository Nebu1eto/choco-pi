import { hasErrorCode } from "./runtime-guards.ts";
import { arr, compile, obj, unknown } from "@earendil-works/pi-schema";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomic, writeFileAtomicAsync } from "./atomic-write.ts";
import { recordDegradationOnce } from "./degradation-ledger.ts";
import { getGlobalPiLensDir } from "./file-utils.ts";
import { realIsPidAlive } from "./instance-reaper.ts";
import { normalizeFilePath } from "./path-utils.ts";
import { getSubagentIdentity, isSubagentSession } from "./subagent-mode.ts";

export interface LspChildEntry {
  pid: number;
  serverId: string;
  command: string;
  marker?: string;
  spawnedAt: string;
  rssBytes?: number;
  cpuPercent?: number;
}

export interface InstanceEntry {
  pid: number;
  startedAt: string;
  projectRoot: string;
  lspChildren: LspChildEntry[];
  lspChildCount: number;
  rssBytes: number;
  cpuPercent?: number;
  heartbeatAt: string;
  subagent?: {
    marker?: string;
    agentType?: string;
    parentPid?: number;
    runId?: string;
  };
}

interface RegistryFile {
  instances: InstanceEntry[];
}

const RegistryFileSchema = obj({ instances: arr(unknown()) }, { open: true });
const isRegistryFile = compile(RegistryFileSchema).check;

function registryPath(): string {
  return path.join(getGlobalPiLensDir(), "instances.json");
}

let _enabledCache: boolean | undefined;

export function isInstanceRegistryEnabled(): boolean {
  if (_enabledCache !== undefined) return _enabledCache;
  _enabledCache = process.env.CHOCO_PI_LSP_INSTANCE_REGISTRY !== "0";
  return _enabledCache;
}

export function _resetInstanceRegistryEnabledForTests(): void {
  _enabledCache = undefined;
}

function recordCorruptRegistryRead(reasonCode: string): void {
  recordDegradationOnce({
    kind: "instance-registry-corrupt",
    subject: "instances.json",
    reason: `read failed (${reasonCode}); treating as empty`,
  });
}

function readRegistrySync(): RegistryFile {
  try {
    const raw = fs.readFileSync(registryPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (isRegistryFile(parsed)) {
      // SAFETY: The cast intentionally preserves the legacy loader, which checked only the instances array container.
      return parsed as RegistryFile;
    }
    recordCorruptRegistryRead("invalid shape");
    return { instances: [] };
  } catch (err) {
    const code = hasErrorCode(err) ? err.code : undefined;
    if (code !== "ENOENT") recordCorruptRegistryRead(code ?? "invalid");
    return { instances: [] };
  }
}

async function readRegistryAsync(): Promise<RegistryFile> {
  try {
    const raw = await fs.promises.readFile(registryPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (isRegistryFile(parsed)) {
      // SAFETY: The cast intentionally preserves the legacy loader, which checked only the instances array container.
      return parsed as RegistryFile;
    }
    recordCorruptRegistryRead("invalid shape");
    return { instances: [] };
  } catch (err) {
    const code = hasErrorCode(err) ? err.code : undefined;
    if (code !== "ENOENT") recordCorruptRegistryRead(code ?? "invalid");
    return { instances: [] };
  }
}

export async function readInstanceRegistry(): Promise<InstanceEntry[]> {
  const file = await readRegistryAsync();
  return file.instances;
}

async function writeRegistryAsync(file: RegistryFile): Promise<void> {
  const dir = getGlobalPiLensDir();
  const target = registryPath();
  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch {
    return;
  }
  await writeFileAtomicAsync(target, JSON.stringify(file));
}

function writeRegistrySync(file: RegistryFile): void {
  const dir = getGlobalPiLensDir();
  const target = registryPath();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return;
  }
  writeFileAtomic(target, JSON.stringify(file));
}

export async function registerInstance(projectRoot: string): Promise<void> {
  if (!isInstanceRegistryEnabled()) return;
  const pid = process.pid;
  const normalizedRoot = normalizeFilePath(projectRoot);
  const file = await readRegistryAsync();
  const now = new Date().toISOString();
  const others = file.instances.filter((entry) => entry.pid !== pid);
  const existing = file.instances.find((entry) => entry.pid === pid);
  const identity = isSubagentSession() ? getSubagentIdentity() : undefined;
  const subagent = identity
    ? {
        marker: identity.marker,
        agentType: identity.agentName,
        parentPid: identity.parentPid,
        runId: identity.runId,
      }
    : undefined;
  const entry: InstanceEntry = {
    pid,
    startedAt: existing?.startedAt ?? now,
    projectRoot: normalizedRoot,
    lspChildren: existing?.lspChildren ?? [],
    lspChildCount: existing?.lspChildren?.length ?? 0,
    rssBytes: process.memoryUsage().rss,
    heartbeatAt: now,
  };
  if (subagent) entry.subagent = subagent;
  others.push(entry);
  await writeRegistryAsync({ instances: others });
}

export interface HeartbeatPatch {
  rssBytes?: number;
  cpuPercent?: number;
  childUsage?: Record<number, { rssBytes?: number; cpuPercent?: number }>;
}

export async function updateHeartbeat(patch: HeartbeatPatch = {}): Promise<void> {
  if (!isInstanceRegistryEnabled()) return;
  const pid = process.pid;
  const file = await readRegistryAsync();
  const idx = file.instances.findIndex((entry) => entry.pid === pid);
  if (idx === -1) {
    return;
  }
  const now = new Date().toISOString();
  const current = file.instances[idx];
  const lspChildren = patch.childUsage
    ? current.lspChildren.map((child) => {
        const usage = patch.childUsage?.[child.pid];
        if (!usage) return child;
        return {
          ...child,
          rssBytes: usage.rssBytes ?? child.rssBytes,
          cpuPercent: usage.cpuPercent ?? child.cpuPercent,
        };
      })
    : current.lspChildren;
  file.instances[idx] = {
    ...current,
    rssBytes: patch.rssBytes ?? process.memoryUsage().rss,
    cpuPercent: patch.cpuPercent ?? current.cpuPercent,
    lspChildren,
    lspChildCount: lspChildren.length,
    heartbeatAt: now,
  };
  await writeRegistryAsync(file);
}

export interface RecordLspChildInput {
  pid: number;
  serverId: string;
  command: string;
  marker?: string;
}

let registryChildMutationTail: Promise<void> = Promise.resolve();

function queueRegistryChildMutation(op: () => Promise<void>): Promise<void> {
  const run = registryChildMutationTail.then(op);
  registryChildMutationTail = run.catch(() => {});
  return run;
}

export function recordLspChild(entry: RecordLspChildInput): Promise<void> {
  return queueRegistryChildMutation(() => recordLspChildNow(entry));
}

async function recordLspChildNow(entry: RecordLspChildInput): Promise<void> {
  if (!isInstanceRegistryEnabled()) return;
  const pid = process.pid;
  const file = await readRegistryAsync();
  const idx = file.instances.findIndex((inst) => inst.pid === pid);
  const now = new Date().toISOString();
  const childEntry: LspChildEntry = {
    pid: entry.pid,
    serverId: entry.serverId,
    command: entry.command,
    marker: entry.marker,
    spawnedAt: now,
  };
  if (idx === -1) {
    file.instances.push({
      pid,
      startedAt: now,
      projectRoot: normalizeFilePath(process.cwd()),
      lspChildren: [childEntry],
      lspChildCount: 1,
      rssBytes: process.memoryUsage().rss,
      heartbeatAt: now,
    });
  } else {
    const current = file.instances[idx];
    const filtered = current.lspChildren.filter((child) => child.pid !== entry.pid);
    filtered.push(childEntry);
    file.instances[idx] = {
      ...current,
      lspChildren: filtered,
      lspChildCount: filtered.length,
    };
  }
  await writeRegistryAsync(file);
}

export function removeLspChild(pid: number, expectedMarker?: string): Promise<void> {
  return queueRegistryChildMutation(() => removeLspChildNow(pid, expectedMarker));
}

async function removeLspChildNow(pid: number, expectedMarker?: string): Promise<void> {
  if (!isInstanceRegistryEnabled()) return;
  const selfPid = process.pid;
  const file = await readRegistryAsync();
  const idx = file.instances.findIndex((inst) => inst.pid === selfPid);
  if (idx === -1) return;
  const current = file.instances[idx];
  const filtered = current.lspChildren.filter((child) => {
    if (child.pid !== pid) return true;
    if (expectedMarker && child.marker && child.marker !== expectedMarker) {
      return true;
    }
    return false;
  });
  if (filtered.length === current.lspChildren.length) return;
  file.instances[idx] = {
    ...current,
    lspChildren: filtered,
    lspChildCount: filtered.length,
  };
  await writeRegistryAsync(file);
}

export function deregisterInstance(): void {
  if (!isInstanceRegistryEnabled()) return;
  const pid = process.pid;
  const file = readRegistrySync();
  const remaining = file.instances.filter((entry) => entry.pid !== pid);
  if (remaining.length === file.instances.length) return;
  writeRegistrySync({ instances: remaining });
}

export interface InstanceFootprint {
  pid: number;
  projectRoot: string;
  rssBytes: number;
  cpuPercent: number;
  lspChildCount: number;
  lspChildRssBytes: number;
  lspChildCpuPercent: number;
}

export interface ResourceFootprint {
  instanceCount: number;
  totalRssBytes: number;
  totalCpuPercent: number;
  totalLspChildCount: number;
  perInstance: InstanceFootprint[];
}

export function computeResourceFootprint(
  instances: InstanceEntry[],
  isPidAlive?: (pid: number) => boolean,
): ResourceFootprint {
  const liveInstances = isPidAlive
    ? instances.filter((instance) => isPidAlive(instance.pid))
    : instances;
  const perInstance: InstanceFootprint[] = liveInstances.map((instance) => {
    const lspChildRssBytes = instance.lspChildren.reduce(
      (sum, child) => sum + (child.rssBytes ?? 0),
      0,
    );
    const lspChildCpuPercent = instance.lspChildren.reduce(
      (sum, child) => sum + (child.cpuPercent ?? 0),
      0,
    );
    return {
      pid: instance.pid,
      projectRoot: instance.projectRoot,
      rssBytes: instance.rssBytes ?? 0,
      cpuPercent: instance.cpuPercent ?? 0,
      lspChildCount: instance.lspChildren.length,
      lspChildRssBytes,
      lspChildCpuPercent,
    };
  });

  let totalRssBytes = 0;
  let totalCpuPercent = 0;
  let totalLspChildCount = 0;
  for (const inst of perInstance) {
    totalRssBytes += inst.rssBytes + inst.lspChildRssBytes;
    totalCpuPercent += inst.cpuPercent + inst.lspChildCpuPercent;
    totalLspChildCount += inst.lspChildCount;
  }

  return {
    instanceCount: perInstance.length,
    totalRssBytes,
    totalCpuPercent,
    totalLspChildCount,
    perInstance,
  };
}

export async function getResourceFootprint(
  isPidAlive: (pid: number) => boolean = realIsPidAlive,
): Promise<ResourceFootprint> {
  const instances = await readInstanceRegistry();
  const deadPids = new Set(
    instances.filter((instance) => !isPidAlive(instance.pid)).map((instance) => instance.pid),
  );
  if (deadPids.size > 0) {
    prunePids(deadPids).catch(() => {});
  }
  return computeResourceFootprint(instances, isPidAlive);
}

async function prunePids(deadPids: Set<number>): Promise<void> {
  const file = await readRegistryAsync();
  const remaining = file.instances.filter((entry) => !deadPids.has(entry.pid));
  if (remaining.length === file.instances.length) return;
  await writeRegistryAsync({ instances: remaining });
}
