import { appendFile, readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const PROVENANCE_NAME = ".install-provenance";

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

async function bothForms(file: string): Promise<string[]> {
  const real = await realpathOrNull(file);
  return real === null || real === file ? [file] : [file, real];
}

export type EntryResolution =
  | { kind: "resolved"; path: string }
  | { kind: "missing" }
  | { kind: "refused"; problem: string };

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

export async function recordCreated(home: string, created: string): Promise<void> {
  if (!path.isAbsolute(created) || created.includes("\n"))
    throw new Error(`cannot journal ${JSON.stringify(created)}: not an absolute one-line path`);
  await appendFile(provenancePath(home), `${created}\n`, { mode: 0o600 });
}

export type Provenance = {
  accepted: string[];
  rejected: { entry: string; problem: string }[];
};

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

export async function clearProvenance(home: string): Promise<void> {
  await rm(provenancePath(home), { force: true });
}
