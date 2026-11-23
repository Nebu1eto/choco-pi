import { type HeartbeatPatch, readInstanceRegistry, updateHeartbeat } from "./instance-registry.ts";
import { logLatency } from "./latency-logger.ts";
import { sampleProcesses } from "./resource-sampler.ts";
import type { RuntimeCoordinator } from "./runtime-coordinator.ts";
import {
  _resetQuietWindowEnabledForTests,
  isQuietWindowEnabled,
  quietWindowWaitMs,
} from "./quiet-window-config.ts";

export interface QuietWindowTaskResult {
  name: string;
  durationMs: number;
  ok: boolean;
}

export type QuietWindowTask = () => Promise<void> | void;

interface RegisteredTask {
  name: string;
  fn: QuietWindowTask;
}

const _tasks: RegisteredTask[] = [];

export function registerQuietWindowTask(name: string, fn: QuietWindowTask): void {
  _tasks.push({ name, fn });
}

export function _resetQuietWindowTasksForTests(): void {
  _tasks.length = 0;
}

export { isQuietWindowEnabled, quietWindowWaitMs, _resetQuietWindowEnabledForTests };

let _inProgress = false;

export interface QuietWindowDeps {
  runtime: RuntimeCoordinator;
  dbg: (msg: string) => void;
  cwd?: string;
}

export async function runQuietWindow(deps: QuietWindowDeps): Promise<void> {
  const { dbg, cwd } = deps;

  if (!isQuietWindowEnabled()) {
    logLatency({
      type: "phase",
      filePath: cwd ?? "<choco-pi-lsp>",
      phase: "quiet_window",
      durationMs: 0,
      metadata: { skipped: "disabled" },
    });
    return;
  }

  if (_inProgress) {
    dbg("quiet_window: skipping — a previous run is still in progress");
    logLatency({
      type: "phase",
      filePath: cwd ?? "<choco-pi-lsp>",
      phase: "quiet_window",
      durationMs: 0,
      metadata: { skipped: "in-progress" },
    });
    return;
  }

  _inProgress = true;
  const totalStart = Date.now();
  const results: QuietWindowTaskResult[] = [];
  try {
    for (const task of _tasks) {
      const taskStart = Date.now();
      let ok = true;
      try {
        await task.fn();
      } catch (err) {
        ok = false;
        const detail =
          err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
        dbg(`quiet_window: task "${task.name}" failed: ${detail}`);
      }
      results.push({
        name: task.name,
        durationMs: Date.now() - taskStart,
        ok,
      });
    }
  } finally {
    _inProgress = false;
    logLatency({
      type: "phase",
      filePath: cwd ?? "<choco-pi-lsp>",
      phase: "quiet_window",
      durationMs: Date.now() - totalStart,
      metadata: { tasks: results },
    });
  }
}

let _builtinsRegistered = false;

export function registerBuiltinQuietWindowTasks(getRuntime: () => RuntimeCoordinator): void {
  if (_builtinsRegistered) return;
  _builtinsRegistered = true;

  registerQuietWindowTask("cascade_carry_over_settle", async () => {
    const runtime = getRuntime();
    await runtime.settleCascadeRuns(quietWindowWaitMs());
  });

  registerQuietWindowTask("instance_registry_heartbeat", async () => {
    await updateHeartbeat(await buildHeartbeatResourcePatchBounded());
  });
}

const HEARTBEAT_SAMPLE_TIMEOUT_MS = 2000;

async function buildHeartbeatResourcePatchBounded(): Promise<HeartbeatPatch> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      buildHeartbeatResourcePatch(),
      new Promise<HeartbeatPatch>((resolve) => {
        timer = setTimeout(() => resolve({}), HEARTBEAT_SAMPLE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function buildHeartbeatResourcePatch(): Promise<HeartbeatPatch> {
  try {
    const instances = await readInstanceRegistry();
    const self = instances.find((instance) => instance.pid === process.pid);
    const childPids = self?.lspChildren.map((child) => child.pid) ?? [];
    const usage = await sampleProcesses([process.pid, ...childPids]);

    const childUsage: Record<number, { rssBytes?: number; cpuPercent?: number }> = {};
    for (const pid of childPids) {
      const sample = usage.get(pid);
      if (sample) childUsage[pid] = sample;
    }

    return {
      cpuPercent: usage.get(process.pid)?.cpuPercent,
      childUsage,
    };
  } catch {
    return {};
  }
}

export function _resetBuiltinQuietWindowRegistrationForTests(): void {
  _builtinsRegistered = false;
}
