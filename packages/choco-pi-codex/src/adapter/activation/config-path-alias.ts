import { existsSync, realpathSync } from "node:fs";

export function configPathsAliasSameFile(first: string, second: string): boolean {
  try {
    if (!existsSync(first) || !existsSync(second)) return false;
    return realpathSync(first) === realpathSync(second);
  } catch {
    return false;
  }
}
