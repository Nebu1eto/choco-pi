import { existsSync, realpathSync } from "node:fs";

/**
 * True when two config paths resolve to the same file on disk.
 *
 * The choco-pi profile installs the global Codex config as a symlink into the
 * repository checkout, so inside that checkout the "project" config path and
 * the global config path are one file. Folder-settings writes have to detect
 * this: clearing or materializing a folder layer onto that file would rewrite
 * the tracked global profile.
 */
export function configPathsAliasSameFile(first: string, second: string): boolean {
  try {
    if (!existsSync(first) || !existsSync(second)) return false;
    return realpathSync(first) === realpathSync(second);
  } catch {
    return false;
  }
}
