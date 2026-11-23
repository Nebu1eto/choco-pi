import { logSessionStart } from "./sessionstart-logger.ts";
import type { InstanceEntry } from "./instance-registry.ts";
import { realIsPidAlive } from "./instance-reaper.ts";

export interface VanishedInstance {
  pid: number;
  lastSeenAt: string;
  rssBytes: number;
}

export function detectVanishedInstances(
  registry: InstanceEntry[],
  isPidAlive: (pid: number) => boolean,
): VanishedInstance[] {
  return registry
    .filter((entry) => !isPidAlive(entry.pid))
    .map((entry) => ({
      pid: entry.pid,
      lastSeenAt: entry.heartbeatAt,
      rssBytes: entry.rssBytes ?? 0,
    }));
}

export function logVanishedInstances(
  registry: InstanceEntry[],
  isPidAlive: (pid: number) => boolean = realIsPidAlive,
): void {
  try {
    const vanished = detectVanishedInstances(registry, isPidAlive);
    for (const instance of vanished) {
      const rssMb = Math.round(instance.rssBytes / (1024 * 1024));
      logSessionStart(
        `previous instance pid ${instance.pid} last seen ${instance.lastSeenAt} (RSS ${rssMb}MB) exited without shutdown`,
      );
    }
  } catch {}
}
