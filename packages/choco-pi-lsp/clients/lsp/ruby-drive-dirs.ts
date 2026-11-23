import { BoundedLruCache } from "../bounded-cache.ts";
import { normalizeMapKey } from "../path-utils.ts";

import * as fs from "node:fs";

const RUBY_VERSION_DIR = /^ruby\d/i;

const rubyDirNamesCache = new BoundedLruCache<string, string[]>(16);

function rubyDriveKey(driveRoot: string): string {
  return normalizeMapKey(driveRoot);
}

function filterRubyDirNames(entries: string[]): string[] {
  return entries.filter((name) => RUBY_VERSION_DIR.test(name));
}

export function getRubyVersionDirNamesSync(driveRoot: string): string[] {
  const key = rubyDriveKey(driveRoot);
  const cached = rubyDirNamesCache.get(key);
  if (cached !== undefined) return cached;
  let names: string[];
  try {
    names = filterRubyDirNames(fs.readdirSync(driveRoot));
  } catch {
    names = [];
  }
  rubyDirNamesCache.set(key, names);
  return names;
}

export async function getRubyVersionDirNamesAsync(driveRoot: string): Promise<string[]> {
  const key = rubyDriveKey(driveRoot);
  const cached = rubyDirNamesCache.get(key);
  if (cached !== undefined) return cached;
  let names: string[];
  try {
    names = filterRubyDirNames(await fs.promises.readdir(driveRoot));
  } catch {
    names = [];
  }
  rubyDirNamesCache.set(key, names);
  return names;
}

export function __resetRubyDriveDirsCacheForTest(): void {
  rubyDirNamesCache.clear();
}
