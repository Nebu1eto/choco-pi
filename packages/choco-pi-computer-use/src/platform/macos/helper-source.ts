import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export type HelperArch = "arm64" | "x64";

export const HELPER_SOURCE_HASH_SCHEME = "pi-computer-use-helper-source-v1";

export const HELPER_SWIFT_SOURCES: readonly string[] = [
  "native/macos/agent_cursor.swift",
  "native/macos/agent_cursor_motion.swift",
  "native/macos/bridge.swift",
];

export function helperSourcePaths(packageRoot: string = PACKAGE_ROOT): string[] {
  return HELPER_SWIFT_SOURCES.map((relativePath) => path.join(packageRoot, relativePath));
}

export async function helperSourceHash(
  arch: HelperArch,
  packageRoot: string = PACKAGE_ROOT,
): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`${HELPER_SOURCE_HASH_SCHEME}\n${arch}\n`);
  for (const relativePath of [...HELPER_SWIFT_SOURCES].sort()) {
    const contents = await fs.readFile(path.join(packageRoot, relativePath));
    hash.update(`${relativePath}\n${contents.length}\n`);
    hash.update(contents);
    hash.update("\n");
  }
  return hash.digest("hex");
}
