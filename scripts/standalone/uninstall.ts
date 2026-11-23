import { lstat, readlink, realpath, rm, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { InstallManifest } from "./install-manifest.ts";
import {
  PROVENANCE_NAME,
  provenancePath,
  readProvenance,
  resolveOwnedEntry,
} from "./provenance.ts";
import { exists, samePath } from "./provision.ts";

export type UninstallLog = { info(line: string): void; warn(line: string): void };

export type UninstallOptions = {
  home: string;
  launcher: string;
  manifest: InstallManifest | null;
  purge: boolean;
  log: UninstallLog;
};

export async function isOurLink(link: string, launcher: string): Promise<boolean> {
  try {
    if (!(await lstat(link)).isSymbolicLink()) return false;
    return path.resolve(path.dirname(link), await readlink(link)) === launcher;
  } catch {
    return false;
  }
}

function isInsideOrSame(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function removeWithoutFollowing(target: string): Promise<void> {
  if ((await lstat(target)).isSymbolicLink()) await unlink(target);
  else await rm(target, { recursive: true, force: true });
}

export async function uninstall(options: UninstallOptions): Promise<void> {
  const { home, launcher, manifest, log } = options;
  if (manifest !== null && !(await samePath(manifest.home, home)))
    throw new Error(`install.json belongs to ${manifest.home}, not ${home}`);
  const installHome = manifest?.home ?? (await realpath(home));
  const binLink = manifest?.bin_link ?? null;
  const journal = await readProvenance(installHome, binLink);
  const removed: string[] = [];
  const kept: string[] = [];
  for (const { entry, problem } of journal.rejected) {
    if (await exists(entry)) kept.push(`${entry} (${PROVENANCE_NAME} entry refused: ${problem})`);
    else log.warn(`ignoring ${PROVENANCE_NAME} entry ${JSON.stringify(entry)}: ${problem}`);
  }
  if (manifest === null && journal.accepted.length === 0) {
    for (const target of kept) log.info(`kept: ${target}`);
    throw new Error(`${home}/install.json is missing; nothing is recorded to uninstall`);
  }
  const owned = [...new Set([...(manifest?.created ?? []), ...journal.accepted])];
  const piHome = path.join(homedir(), ".pi");
  const purge = options.purge;
  const userState = purge ? ["agent", "lsp"].map((entry) => path.join(installHome, entry)) : [];
  for (const target of userState) {
    if (isInsideOrSame(piHome, target))
      throw new Error(`refusing to remove ${target}: it is under ${piHome}`);
  }
  const installedLauncher = path.join(
    manifest?.app ?? path.join(installHome, "app"),
    "bin",
    "choco-pi",
  );
  if (binLink !== null && owned.includes(binLink)) {
    if ((await isOurLink(binLink, installedLauncher)) || (await isOurLink(binLink, launcher))) {
      await rm(binLink, { force: true });
      removed.push(binLink);
    } else if (await exists(binLink)) {
      kept.push(`${binLink} (not a link to this launcher)`);
    }
  }
  const manifestFile = path.join(installHome, "install.json");
  const ordered = owned
    .filter((entry) => entry !== binLink && entry !== manifestFile)
    .toSorted((left, right) => right.length - left.length);
  for (const target of ordered) {
    const resolution = await resolveOwnedEntry(installHome, target);
    if (resolution.kind === "missing") continue;
    if (resolution.kind === "refused") {
      if (await exists(target)) kept.push(`${target} (not removed: ${resolution.problem})`);
      continue;
    }
    if (!(await exists(resolution.path))) continue;
    await removeWithoutFollowing(resolution.path);
    removed.push(target);
  }
  for (const target of userState) {
    if (!(await exists(target))) continue;
    await removeWithoutFollowing(target);
    removed.push(target);
  }
  for (const file of [manifestFile, provenancePath(installHome)]) {
    if (!(await exists(file))) continue;
    await rm(file, { force: true });
    removed.push(file);
  }
  for (const directory of [path.join(installHome, "runtime"), ...(purge ? [installHome] : [])]) {
    try {
      await rmdir(directory);
      removed.push(directory);
    } catch {
      continue;
    }
  }
  if (!purge) {
    for (const entry of ["agent", "lsp"]) {
      const target = path.join(installHome, entry);
      if (await exists(target)) kept.push(target);
    }
  }
  for (const target of removed) log.info(`removed: ${target}`);
  for (const target of kept) log.info(`kept: ${target}`);
}
