import type { SpawnResult } from "../../../safe-spawn.ts";

export function spawnFailedWithNoOutput(
  result: SpawnResult,
  output: string = result.stdout,
): boolean {
  return (Boolean(result.error) || result.status !== 0) && !output?.trim();
}
