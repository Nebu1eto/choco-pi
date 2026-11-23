import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectIgnoreMatcher } from "./file-utils.ts";
import { isExcludedDirName } from "./file-utils.ts";
import { isGeneratedArtifactDirectoryName } from "./generated-artifacts.ts";
import { createDeadline, yieldIfOverBudget } from "./cooperative-budget.ts";

export function readDirEntriesSafe(dirPath: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function readDirEntriesSafeAsync(dirPath: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

export interface DirWalkPolicy {
  ignoreMatcher: ProjectIgnoreMatcher;
  extraExcludeDirs?: string[];
  skipGeneratedArtifactDirs?: boolean;
  followSymlinks?: boolean;
}

export function shouldRecurseIntoDir(
  entry: fs.Dirent,
  fullPath: string,
  policy: DirWalkPolicy,
  onGeneratedDirSkip?: () => void,
): boolean {
  if (isExcludedDirName(entry.name, policy.extraExcludeDirs ?? [])) {
    return false;
  }
  if (policy.ignoreMatcher.isIgnored(fullPath, true)) return false;
  if (policy.skipGeneratedArtifactDirs === true && isGeneratedArtifactDirectoryName(entry.name)) {
    onGeneratedDirSkip?.();
    return false;
  }
  if (policy.followSymlinks !== true && entry.isSymbolicLink()) return false;
  return true;
}

export type WalkDisposition = "recurse" | "skip" | "stop";

export type WalkVisitor = (entry: fs.Dirent, fullPath: string) => WalkDisposition;

export interface StackWalkOptions {
  shouldStop?: () => boolean;
}

export interface AsyncStackWalkOptions extends StackWalkOptions {
  budgetMs?: number;
  beforeWalk?: () => Promise<void>;
}

function* walkTreeStackSteps(
  rootDir: string,
  visit: WalkVisitor,
  shouldStop?: () => boolean,
): Generator<string | undefined, boolean, fs.Dirent[] | undefined> {
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    if (shouldStop?.()) return false;
    const dir = stack.pop();
    if (dir === undefined) continue;
    const entries = (yield dir) ?? [];
    const subDirs: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const disposition = visit(entry, fullPath);
      if (disposition === "stop") return true;
      if (disposition === "recurse") subDirs.push(fullPath);
      yield undefined;
    }
    for (let i = subDirs.length - 1; i >= 0; i--) stack.push(subDirs[i]);
  }
  return false;
}

export function walkTreeStackSync(
  rootDir: string,
  visit: WalkVisitor,
  opts: StackWalkOptions = {},
): boolean {
  const steps = walkTreeStackSteps(rootDir, visit, opts.shouldStop);
  let step = steps.next();
  while (!step.done) {
    step = steps.next(step.value === undefined ? undefined : readDirEntriesSafe(step.value));
  }
  return step.value;
}

export async function walkTreeStackAsync(
  rootDir: string,
  visit: WalkVisitor,
  opts: AsyncStackWalkOptions,
): Promise<boolean> {
  await opts.beforeWalk?.();
  const steps = walkTreeStackSteps(rootDir, visit, opts.shouldStop);
  const deadline = createDeadline(opts.budgetMs ?? 8);
  let step = steps.next();
  while (!step.done) {
    if (step.value !== undefined) {
      step = steps.next(await readDirEntriesSafeAsync(step.value));
      deadline.reset();
      continue;
    }
    if (deadline.expired()) await yieldIfOverBudget(deadline);
    step = steps.next();
  }
  return step.value;
}

export function walkTreeRecursiveSync(rootDir: string, visit: WalkVisitor): boolean {
  function scan(currentDir: string): boolean {
    for (const entry of readDirEntriesSafe(currentDir)) {
      const fullPath = path.join(currentDir, entry.name);
      const disposition = visit(entry, fullPath);
      if (disposition === "stop") return true;
      if (disposition === "recurse" && scan(fullPath)) return true;
    }
    return false;
  }
  return scan(rootDir);
}
