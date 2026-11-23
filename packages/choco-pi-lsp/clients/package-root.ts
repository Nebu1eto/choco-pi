import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const packageRootCache = new Map<string, string>();

export function getPackageRoot(importMetaUrl: string): string {
  const cached = packageRootCache.get(importMetaUrl);
  if (cached) return cached;

  let current = path.dirname(fileURLToPath(importMetaUrl));
  while (true) {
    if (fs.existsSync(path.join(current, "package.json"))) {
      packageRootCache.set(importMetaUrl, current);
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      packageRootCache.set(importMetaUrl, current);
      return current;
    }
    current = parent;
  }
}

export function resolvePackagePath(importMetaUrl: string, ...segments: string[]): string {
  return path.join(getPackageRoot(importMetaUrl), ...segments);
}
