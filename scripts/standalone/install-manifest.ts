/**
 * `$CHOCO_PI_HOME/install.json`: what the standalone installer created.
 *
 * `self uninstall` removes only paths listed in `created`, so validation is
 * strict: every path is absolute and normalized, and every created path is
 * either inside the home (but never the home itself, `agent/` or `lsp/`) or
 * the recorded bin link. `node_path` is also read by the POSIX launcher with
 * a line-based parser, so it may not contain characters JSON would escape.
 *
 * `runtime` and `bun_path` were added for the Bun runtime option; manifests
 * written before them stay valid and mean runtime node. The launcher reads
 * both with the same line parser.
 */
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  arr,
  compile,
  lit,
  nullable,
  obj,
  oneOf,
  opt,
  str,
  type Static,
} from "@earendil-works/pi-schema";

export const INSTALL_MANIFEST_NAME = "install.json";

export const InstallManifestSchema = obj({
  schema: lit(1),
  name: lit("choco-pi"),
  home: str(),
  app: str(),
  source: nullable(str()),
  ref: nullable(str()),
  rev: nullable(str()),
  node_path: str(),
  runtime: opt(oneOf(["node", "bun"])),
  bun_path: opt(nullable(str())),
  bin_link: nullable(str()),
  created: arr(str()),
  installed_at: str(),
  updated_at: str(),
});
export type InstallManifest = Static<typeof InstallManifestSchema>;
const isInstallManifestRecord = compile(InstallManifestSchema).check;

/** User state that only `self uninstall --purge` removes. */
export const USER_STATE_ENTRIES: readonly string[] = ["agent", "lsp"];

function isNormalizedAbsolute(value: string): boolean {
  return path.isAbsolute(value) && path.normalize(value) === value && !value.endsWith(path.sep);
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Characters the launcher's line parser cannot read back from JSON. */
export function isLauncherReadablePath(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '"' || character === "\\" || code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

export function manifestProblems(manifest: InstallManifest): string[] {
  const problems: string[] = [];
  const absolute: [string, string | null][] = [
    ["home", manifest.home],
    ["app", manifest.app],
    ["node_path", manifest.node_path],
    ["bun_path", manifest.bun_path ?? null],
    ["bin_link", manifest.bin_link],
  ];
  for (const [key, value] of absolute) {
    if (value !== null && !isNormalizedAbsolute(value))
      problems.push(`${key} is not a normalized absolute path`);
  }
  if (!isLauncherReadablePath(manifest.node_path))
    problems.push("node_path contains characters JSON escapes");
  if (manifest.bun_path !== undefined && manifest.bun_path !== null) {
    if (!isLauncherReadablePath(manifest.bun_path))
      problems.push("bun_path contains characters JSON escapes");
  }
  if (!Number.isFinite(Date.parse(manifest.installed_at)))
    problems.push("installed_at is not a timestamp");
  if (!Number.isFinite(Date.parse(manifest.updated_at)))
    problems.push("updated_at is not a timestamp");
  const reserved = new Set([
    manifest.home,
    ...USER_STATE_ENTRIES.map((entry) => path.join(manifest.home, entry)),
  ]);
  const seen = new Set<string>();
  for (const created of manifest.created) {
    if (seen.has(created)) problems.push(`created path listed twice: ${created}`);
    seen.add(created);
    if (!isNormalizedAbsolute(created)) {
      problems.push(`created path is not a normalized absolute path: ${created}`);
    } else if (created === manifest.bin_link) {
      continue;
    } else if (reserved.has(created) || !isInside(manifest.home, created)) {
      problems.push(`created path is outside the installer-owned part of the home: ${created}`);
    } else if (
      USER_STATE_ENTRIES.some((entry) => isInside(path.join(manifest.home, entry), created))
    ) {
      problems.push(`created path is inside user state: ${created}`);
    }
  }
  return problems;
}

/** Parses manifest JSON text; throws with every problem found. */
export function parseInstallManifest(text: string, origin: string): InstallManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${origin} is not valid JSON`);
  }
  if (!isInstallManifestRecord(parsed))
    throw new Error(`${origin} does not match the install manifest schema 1`);
  const problems = manifestProblems(parsed);
  if (problems.length > 0) throw new Error(`${origin} is invalid: ${problems.join("; ")}`);
  return parsed;
}

export function manifestPath(home: string): string {
  return path.join(home, INSTALL_MANIFEST_NAME);
}

/** Reads the manifest of `home`; null when absent. */
export async function readInstallManifest(home: string): Promise<InstallManifest | null> {
  const file = manifestPath(home);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  return parseInstallManifest(text, file);
}

export async function writeInstallManifest(manifest: InstallManifest): Promise<string> {
  const problems = manifestProblems(manifest);
  if (problems.length > 0)
    throw new Error(`refusing to write an invalid install manifest: ${problems.join("; ")}`);
  const file = manifestPath(manifest.home);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return file;
}
