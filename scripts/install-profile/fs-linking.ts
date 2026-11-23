import { constants, type Stats } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import path from "node:path";

import { RETIRED_PROFILE_FILES } from "./constants.ts";

export type InstallLinkResult = {
  target: string;
  action: "unchanged" | "linked" | "backed-up";
  backup?: string;
};

export type LinkState = "absent" | "current" | "same-file" | "legacy" | "conflict";

export async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function backupPath(target: string): string {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  return `${target}.backup-${stamp}`;
}

async function sameFileContents(left: string, right: string): Promise<boolean> {
  try {
    return (await readFile(left)).equals(await readFile(right));
  } catch {
    return false;
  }
}

function isMissingPathError(error: Error): boolean {
  return "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function legacySourceRelative(sourceRelative: string): string | undefined {
  const prefix = "profile/";
  return sourceRelative.startsWith(prefix)
    ? `.pi/${sourceRelative.slice(prefix.length)}`
    : undefined;
}

export async function classifyLink(
  root: string,
  sourceRelative: string,
  target: string,
): Promise<LinkState> {
  const source = path.resolve(root, sourceRelative);
  let status: Stats;
  try {
    status = await lstat(target);
  } catch (error) {
    if (error instanceof Error && isMissingPathError(error)) return "absent";
    throw error;
  }
  if (!status.isSymbolicLink()) {
    return status.isFile() && (await sameFileContents(source, target)) ? "same-file" : "conflict";
  }
  const current = path.resolve(path.dirname(target), await readlink(target));
  if (current === source) return "current";
  const legacy = legacySourceRelative(sourceRelative);
  if (legacy === undefined) return "conflict";
  if (current === path.resolve(root, legacy)) return "legacy";
  try {
    await stat(target);
    return "conflict";
  } catch (error) {
    if (!(error instanceof Error && isMissingPathError(error))) throw error;
  }
  return current.endsWith(`${path.sep}${path.normalize(legacy)}`) ? "legacy" : "conflict";
}

async function replaceSymlink(source: string, target: string): Promise<void> {
  const temporary = `${target}.${process.pid}.link.tmp`;
  await rm(temporary, { force: true });
  await symlink(source, temporary);
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function installLink(
  root: string,
  sourceRelative: string,
  target: string,
  backup: boolean,
): Promise<InstallLinkResult> {
  const source = path.resolve(root, sourceRelative);
  await mkdir(path.dirname(target), { recursive: true });
  const state = await classifyLink(root, sourceRelative, target);
  if (state === "absent") {
    await symlink(source, target);
    return { target, action: "linked" };
  }
  if (state === "current") return { target, action: "unchanged" };
  if (state === "same-file") {
    await rm(target);
    await symlink(source, target);
    return { target, action: "linked" };
  }
  if (state === "legacy") {
    await replaceSymlink(source, target);
    return { target, action: "linked" };
  }
  if (!backup) {
    throw new Error(`${target} already exists; rerun with --backup to preserve and replace it`);
  }
  const saved = backupPath(target);
  await rename(target, saved);
  try {
    await symlink(source, target);
  } catch (error) {
    await rename(saved, target);
    throw error;
  }
  return { target, action: "backed-up", backup: saved };
}

export async function removeRetiredProfileFiles(
  agentDir: string,
  warnings: string[],
): Promise<string[]> {
  const removed: string[] = [];
  for (const relative of RETIRED_PROFILE_FILES) {
    const target = path.resolve(agentDir, relative);
    let isRemovable: boolean;
    try {
      const status = await lstat(target);
      isRemovable = status.isSymbolicLink() || status.isFile();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    if (!isRemovable) {
      warnings.push(`${target} is retired but is not a file or symlink; left in place.`);
      continue;
    }
    await rm(target);
    removed.push(target);
  }
  return removed;
}
