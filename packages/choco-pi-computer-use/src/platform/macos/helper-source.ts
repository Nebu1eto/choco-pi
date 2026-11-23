import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The one definition of the helper source hash. `scripts/setup-helper.ts`
 * writes it into the installed bundle and `e2e/preflight.ts` compares a
 * tier-B app against it.
 */

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export type HelperArch = "arm64" | "x64";

/** Version tag hashed first; bump it when the scheme below changes. */
export const HELPER_SOURCE_HASH_SCHEME = "pi-computer-use-helper-source-v1";

/**
 * Package-relative Swift sources compiled into the helper, sorted.
 * `native/macos/agent_cursor_tests.swift` declares its own `@main` and is not
 * part of the helper, so it is neither compiled nor hashed.
 */
export const HELPER_SWIFT_SOURCES: readonly string[] = [
  "native/macos/agent_cursor.swift",
  "native/macos/agent_cursor_motion.swift",
  "native/macos/bridge.swift",
];

/** Absolute paths of `HELPER_SWIFT_SOURCES` under `packageRoot`. */
export function helperSourcePaths(packageRoot: string = PACKAGE_ROOT): string[] {
  return HELPER_SWIFT_SOURCES.map((relativePath) => path.join(packageRoot, relativePath));
}

/**
 * The value written to an installed bundle's `Contents/Resources/source.sha256`:
 * sha256 over `<scheme>\n<arch>\n`, then for each source in sorted order
 * `<relative path>\n<byte length>\n<contents>\n`. The architecture is hashed
 * because it selects the compiled binary; the byte length keeps the
 * concatenation unambiguous.
 */
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
