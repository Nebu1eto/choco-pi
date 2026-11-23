import * as fs from "node:fs";
export { STAGE_TMP_PATTERN, stageOwnerPidFromName, stagePathFor } from "./atomic-write-staging.ts";
import { stagePathFor } from "./atomic-write-staging.ts";

export interface WriteFileAtomicOptions {
  bestEffort?: boolean;
  mode?: number;
}

export function writeFileAtomic(
  targetPath: string,
  data: string | Uint8Array,
  options?: WriteFileAtomicOptions,
): void {
  const bestEffort = options?.bestEffort ?? true;
  const tmpPath = stagePathFor(targetPath);
  try {
    fs.writeFileSync(tmpPath, data, {
      encoding: data instanceof Uint8Array ? undefined : "utf-8",
      mode: options?.mode,
    });
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {}
    if (!bestEffort) throw err;
  }
}

export async function writeFileAtomicAsync(
  targetPath: string,
  data: string | Uint8Array,
  options?: WriteFileAtomicOptions,
): Promise<void> {
  const bestEffort = options?.bestEffort ?? true;
  const tmpPath = stagePathFor(targetPath);
  try {
    await fs.promises.writeFile(tmpPath, data, {
      encoding: data instanceof Uint8Array ? undefined : "utf-8",
      mode: options?.mode,
    });
    await fs.promises.rename(tmpPath, targetPath);
  } catch (err) {
    try {
      await fs.promises.rm(tmpPath, { force: true });
    } catch {}
    if (!bestEffort) throw err;
  }
}
