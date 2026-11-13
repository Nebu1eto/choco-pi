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
import { appendFile, readFile, rm } from "node:fs/promises";
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

/**
 * Why `entry` cannot be an owned path of the install in `home`, or null when it
 * can: a normalized absolute path inside the home that is not the home, user
 * state or the journal itself, or exactly `binLink`.
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

/** Reads and validates the journal of `home`; an absent journal is empty. */
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
    const problem = provenanceEntryProblem(home, binLink, entry);
    if (problem === null) accepted.push(entry);
    else rejected.push({ entry, problem });
  }
  return { accepted, rejected };
}

/** Removes the journal; call it only after install.json recorded every entry. */
export async function clearProvenance(home: string): Promise<void> {
  await rm(provenancePath(home), { force: true });
}
