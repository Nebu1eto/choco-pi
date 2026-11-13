/**
 * `<home>/.install-provenance`: the installer's creation journal.
 *
 * Every step that creates an installer-owned path appends its absolute path
 * here the moment the path exists, before any later step can fail: install.sh
 * (stage 0) for the app clone and `runtime/node`, manage.ts (stage 1) for the
 * pnpm and Bun runtime paths and the bin link. Whoever next writes
 * install.json merges the journal into `created` and only then removes it, so
 * a failed install keeps ownership of what it created for the retry or for
 * `self uninstall`. A path that merely exists is never owned.
 *
 * Format: one absolute path per line, appended. Only Node built-ins are
 * imported: stage 1 reads this before the app's dependencies exist.
 */
import { appendFile, readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const PROVENANCE_NAME = ".install-provenance";

/** User state inside the home that the installer never owns (see install-manifest.ts). */
const USER_STATE_ENTRIES: readonly string[] = ["agent", "lsp"];

export function provenancePath(home: string): string {
  return path.join(home, PROVENANCE_NAME);
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isInsideOrSame(parent: string, child: string): boolean {
  return parent === child || isInside(parent, child);
}

/** The real path of `file`, or null when it does not exist. */
async function realpathOrNull(file: string): Promise<string | null> {
  try {
    return await realpath(file);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return null;
    throw error;
  }
}

/** `file` as written and, when it exists, its real path. */
async function bothForms(file: string): Promise<string[]> {
  const real = await realpathOrNull(file);
  return real === null || real === file ? [file] : [file, real];
}

export type EntryResolution =
  /** `path`: the real parent of the entry joined with its final name. */
  | { kind: "resolved"; path: string }
  /** The parent directory does not exist, so neither does the entry; it would land inside the home. */
  | { kind: "missing" }
  | { kind: "refused"; problem: string };

/**
 * The real path of `directory`: its deepest existing ancestor resolved, then
 * the missing components appended. `exists` tells whether `directory` itself exists.
 */
async function resolveDirectory(directory: string): Promise<{ path: string; exists: boolean }> {
  const missing: string[] = [];
  let current = directory;
  for (;;) {
    const real = await realpathOrNull(current);
    if (real !== null) return { path: path.join(real, ...missing), exists: missing.length === 0 };
    const parent = path.dirname(current);
    if (parent === current) return { path: directory, exists: false };
    missing.unshift(path.basename(current));
    current = parent;
  }
}

/**
 * Where an owned `entry` of the install in `home` really is, by resolving
 * every ancestor through the filesystem (the final component is never
 * followed: a symlink entry is the link itself). Refused when that location is
 * not strictly inside the real home, or is or holds a protected root: user
 * state (`agent`, `lsp`), the journal, `~/.pi`, or the user's home. A
 * lexical check alone is not enough: `<home>/alias -> /elsewhere` makes
 * `<home>/alias/file` name a file outside the home. Call it right before
 * deleting and delete the returned path, never `entry`. A missing parent is
 * resolved through its deepest existing ancestor, so it is checked too.
 */
export async function resolveOwnedEntry(
  home: string,
  entry: string,
  userHome: string = homedir(),
): Promise<EntryResolution> {
  const realHome = await realpath(home);
  let parent: { path: string; exists: boolean };
  try {
    parent = await resolveDirectory(path.dirname(entry));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: "refused", problem: `its parent directory does not resolve: ${reason}` };
  }
  const resolved = path.join(parent.path, path.basename(entry));
  if (!isInside(realHome, resolved))
    return { kind: "refused", problem: `resolves to ${resolved}, outside the install home` };
  if (resolved === provenancePath(realHome))
    return { kind: "refused", problem: "resolves to the journal itself" };
  const userState = (
    await Promise.all(USER_STATE_ENTRIES.map((name) => bothForms(path.join(realHome, name))))
  ).flat();
  const piHome = await bothForms(path.join(userHome, ".pi"));
  for (const root of [...userState, ...piHome]) {
    if (isInsideOrSame(root, resolved) || isInside(resolved, root))
      return { kind: "refused", problem: `resolves to ${resolved}, which is or holds ${root}` };
  }
  for (const root of await bothForms(path.resolve(userHome))) {
    if (isInsideOrSame(resolved, root))
      return { kind: "refused", problem: `resolves to ${resolved}, which is or holds ${root}` };
  }
  return parent.exists ? { kind: "resolved", path: resolved } : { kind: "missing" };
}

/**
 * Why `entry` cannot be an owned path of the install in `home`, or null when it
 * can: a normalized absolute path inside the home that is not the home, user
 * state or the journal itself, or exactly `binLink`. Lexical only; see
 * resolveOwnedEntry for where the path really leads.
 */
export function provenanceEntryProblem(
  home: string,
  binLink: string | null,
  entry: string,
): string | null {
  if (!path.isAbsolute(entry) || path.normalize(entry) !== entry || entry.endsWith(path.sep))
    return "not a normalized absolute path";
  if (binLink !== null && entry === binLink) return null;
  if (!isInside(home, entry)) return "outside the install home";
  if (entry === provenancePath(home)) return "the journal itself";
  if (
    USER_STATE_ENTRIES.some((name) => {
      const state = path.join(home, name);
      return entry === state || isInside(state, entry);
    })
  )
    return "inside user state";
  return null;
}

/** Appends `created` to the journal of `home`; call it as soon as `created` exists. */
export async function recordCreated(home: string, created: string): Promise<void> {
  if (!path.isAbsolute(created) || created.includes("\n"))
    throw new Error(`cannot journal ${JSON.stringify(created)}: not an absolute one-line path`);
  await appendFile(provenancePath(home), `${created}\n`, { mode: 0o600 });
}

export type Provenance = {
  /** Valid entries, deduplicated, in journal order. */
  accepted: string[];
  /** Entries that are not ownable paths of this install, with the reason. */
  rejected: { entry: string; problem: string }[];
};

/**
 * Reads and validates the journal of `home`; an absent journal is empty. An
 * entry other than `binLink` is accepted only when it is lexically valid and
 * resolveOwnedEntry does not refuse it, so a symlinked ancestor never turns a
 * journal line into ownership of an outside path. An entry whose parent does
 * not exist yet stays acceptable: uninstall resolves every entry again.
 */
export async function readProvenance(home: string, binLink: string | null): Promise<Provenance> {
  let text: string;
  try {
    text = await readFile(provenancePath(home), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { accepted: [], rejected: [] };
    throw error;
  }
  const accepted: string[] = [];
  const rejected: Provenance["rejected"] = [];
  for (const entry of text.split("\n")) {
    if (entry === "" || accepted.includes(entry)) continue;
    let problem = provenanceEntryProblem(home, binLink, entry);
    if (problem === null && entry !== binLink) {
      const resolution = await resolveOwnedEntry(home, entry);
      if (resolution.kind === "refused") problem = resolution.problem;
    }
    if (problem === null) accepted.push(entry);
    else rejected.push({ entry, problem });
  }
  return { accepted, rejected };
}

/** Removes the journal; call it only after install.json recorded every entry. */
export async function clearProvenance(home: string): Promise<void> {
  await rm(provenancePath(home), { force: true });
}
