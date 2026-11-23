import { join } from "node:path";
import type { DiffClock } from "../lib/changes/git/clock.ts";
import { createGitExecRunner, createPinnedGitRunner, runGit } from "../lib/changes/git/exec.ts";
import { DEFAULT_DIFF_LIMITS } from "../lib/changes/git/limits.ts";
import type { DiffSnapshot, DiffStoreState, FileSummary } from "../lib/changes/git/model.ts";
import { parseStatusV2 } from "../lib/changes/git/parse.ts";
import { readWorktreeFile } from "../lib/changes/git/worktree-files.ts";
import { isSensitiveFile } from "../lib/changes/sensitive.ts";
import { EDITOR_MARKDOWN_ENV, markdownFailure, markdownName } from "../lib/changes/markdown.ts";

export const NATIVE_DIFF_ENV = EDITOR_MARKDOWN_ENV;
export const NATIVE_DIFF_NOTIFY_PREFIX = "choco-pi-native-diff/v1\n";
export const NATIVE_DIFF_MAX_FILES = 30;
export const NATIVE_DIFF_MAX_TEXT_BYTES = 1024 * 1024;
export const NATIVE_DIFF_MAX_SKIPPED = 200;

export type NativeDiffFile = {
  path: string;
  displayPath: string;
  oldPath?: string;
  status: FileSummary["status"];
  additions: number | null;
  deletions: number | null;
  oldText: string | null;
  newText: string;
};

export type NativeDiffSkip = { path: string; reason: string };

export type NativeDiffPayload = {
  title: string;
  files: NativeDiffFile[];
  skipped: NativeDiffSkip[];
  omitted: number;
};

export type SideRead =
  | { kind: "text"; text: string }
  | { kind: "binary" }
  | { kind: "too-large"; bytes: number }
  | { kind: "missing" }
  | { kind: "unreadable"; reason: string };

export type NativeDiffReaders = {
  readOld(path: string, maxBytes: number): Promise<SideRead>;
  readNew(path: string, maxBytes: number): Promise<SideRead>;
  countUncommitted?(): Promise<number | undefined>;
};

export type NativeDiffCaps = { maxFiles: number; maxTextBytes: number; maxSkipped: number };

const DEFAULT_CAPS: NativeDiffCaps = {
  maxFiles: NATIVE_DIFF_MAX_FILES,
  maxTextBytes: NATIVE_DIFF_MAX_TEXT_BYTES,
  maxSkipped: NATIVE_DIFF_MAX_SKIPPED,
};

function displayPath(file: FileSummary): string {
  return file.oldPath !== undefined && file.oldPath !== file.path
    ? `${file.oldPath} -> ${file.path}`
    : file.path;
}

function sideProblem(read: SideRead): string | undefined {
  switch (read.kind) {
    case "binary":
      return "binary file";
    case "too-large":
      return `too large for the remaining text budget (${read.bytes} bytes)`;
    case "unreadable":
      return `unreadable: ${read.reason}`;
    default:
      return undefined;
  }
}

function sideText(read: SideRead): string {
  return read.kind === "text" ? read.text : "";
}

function titleFor(snapshot: DiffSnapshot): string {
  const branch = snapshot.branch ? ` on ${snapshot.branch}` : "";
  const { files, additions, deletions } = snapshot.totals;
  const baseline = snapshot.baseline;
  const what =
    snapshot.source.kind !== "session"
      ? "uncommitted changes"
      : baseline?.kind === "checkpoint"
        ? `session changes since ${baseline.label}`
        : "session changes (no file checkpoint yet)";
  return `/diff: ${what}${branch} (${files} ${files === 1 ? "file" : "files"}, +${additions} -${deletions})`;
}

export async function selectNativeDiff(
  snapshot: DiffSnapshot,
  readers: NativeDiffReaders,
  caps: NativeDiffCaps = DEFAULT_CAPS,
): Promise<NativeDiffPayload> {
  const files: NativeDiffFile[] = [];
  const skipped: NativeDiffSkip[] = [];
  let omitted = snapshot.omittedFiles;
  let used = 0;
  const skip = (path: string, reason: string): void => {
    if (skipped.length < caps.maxSkipped) skipped.push({ path, reason });
    else omitted += 1;
  };

  for (const file of snapshot.files) {
    const shown = displayPath(file);
    if (isSensitiveFile(file)) {
      skip(shown, "sensitive file; contents not sent");
      continue;
    }
    if (files.length >= caps.maxFiles) {
      skip(shown, `over the ${caps.maxFiles}-file limit`);
      continue;
    }
    if (file.binary) {
      skip(shown, "binary file");
      continue;
    }
    const remaining = caps.maxTextBytes - used;
    const hasOld = file.status !== "added" && file.status !== "untracked";
    const oldRead: SideRead = hasOld
      ? await readers.readOld(file.oldPath ?? file.path, remaining)
      : { kind: "missing" };
    const oldProblem = sideProblem(oldRead);
    if (oldProblem !== undefined) {
      skip(shown, oldProblem);
      continue;
    }
    const oldBytes = Buffer.byteLength(sideText(oldRead), "utf8");
    const newRead: SideRead =
      file.status === "deleted"
        ? { kind: "missing" }
        : await readers.readNew(file.path, Math.max(0, remaining - oldBytes));
    const newProblem = sideProblem(newRead);
    if (newProblem !== undefined) {
      skip(shown, newProblem);
      continue;
    }
    const newText = sideText(newRead);
    const bytes = oldBytes + Buffer.byteLength(newText, "utf8");
    if (used + bytes > caps.maxTextBytes) {
      skip(shown, `too large for the remaining text budget (${bytes} bytes)`);
      continue;
    }
    used += bytes;
    const shownFile: NativeDiffFile = {
      path: join(snapshot.repoRoot, file.path),
      displayPath: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      oldText: hasOld && oldRead.kind === "text" ? oldRead.text : null,
      newText,
    };
    const moved = file.status === "renamed" || file.status === "copied";
    if (moved && file.oldPath !== undefined) {
      shownFile.oldPath = join(snapshot.repoRoot, file.oldPath);
    }
    files.push(shownFile);
  }
  return { title: titleFor(snapshot), files, skipped, omitted };
}

export function createNativeDiffReaders(
  repoRoot: string,
  base: string | null,
  clock: DiffClock,
): NativeDiffReaders & { dispose(): void } {
  const limits = {
    timeoutMs: DEFAULT_DIFF_LIMITS.timeoutMs,
    maxOutputBytes: NATIVE_DIFF_MAX_TEXT_BYTES + 64 * 1024,
  };
  const git = createPinnedGitRunner(createGitExecRunner(limits), clock, limits);
  return {
    async readOld(path, maxBytes) {
      if (base === null) return { kind: "missing" };
      try {
        const object = `${base}:${path}`;
        const size = Number((await runGit(git.run, repoRoot, ["cat-file", "-s", object])).trim());
        if (!Number.isFinite(size)) return { kind: "unreadable", reason: "unknown blob size" };
        if (size > maxBytes) return { kind: "too-large", bytes: size };
        const text = await runGit(git.run, repoRoot, ["cat-file", "blob", object]);
        return text.includes("\u0000") ? { kind: "binary" } : { kind: "text", text };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { kind: "unreadable", reason: message.split("\n", 1)[0] ?? message };
      }
    },
    async readNew(path, maxBytes) {
      const read = await readWorktreeFile(join(repoRoot, path), maxBytes);
      switch (read.kind) {
        case "text":
          return { kind: "text", text: read.content.toString("utf8") };
        case "too-large":
          return { kind: "too-large", bytes: read.bytes };
        case "binary":
        case "missing":
          return { kind: read.kind };
        case "unreadable":
          return { kind: "unreadable", reason: read.reason };
      }
    },
    dispose: () => git.cancelAll(),
    async countUncommitted() {
      try {
        const args = ["status", "--porcelain=v2", "-z", "--untracked-files=all"];
        const output = await runGit(git.run, repoRoot, [...args, "--ignore-submodules=dirty"]);
        return parseStatusV2(output).entries.length;
      } catch {
        return undefined;
      }
    },
  };
}

export function uncommittedHint(count: number): string {
  const changes = count === 1 ? "1 uncommitted change" : `${count} uncommitted changes`;
  return `This session has changed no files yet, but the working tree has ${changes}: \`/diff source uncommitted\` shows ${count === 1 ? "it" : "them"}.`;
}

export type NativeDiffDeps = {
  env: Readonly<Partial<Record<string, string>>>;
  clock: DiffClock;
  alive: () => boolean;
  readers?: (repoRoot: string, base: string | null) => NativeDiffReaders & { dispose(): void };
};

type NotifyTarget = {
  mode: string;
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
};

export async function presentNativeDiff(
  ctx: NotifyTarget,
  state: DiffStoreState,
  deps: NativeDiffDeps,
): Promise<boolean> {
  if (ctx.mode === "tui" || deps.env[NATIVE_DIFF_ENV] !== "1") return false;
  if (state.kind === "error") {
    ctx.ui.notify(markdownFailure("Diff failed:", state.message), "info");
    return true;
  }
  if (state.kind === "not-a-repository") {
    ctx.ui.notify(`Diff: ${markdownName(state.cwd)} is not inside a git repository.`, "info");
    return true;
  }
  if (state.kind !== "ready") return false;
  const kind = state.snapshot.source.kind;
  if (kind !== "uncommitted" && kind !== "session") return false;
  const snapshot = state.snapshot;
  const base = kind === "uncommitted" ? snapshot.head : snapshot.base || null;
  const ui = ctx.ui;
  const readers = (
    deps.readers ?? ((root, tree) => createNativeDiffReaders(root, tree, deps.clock))
  )(snapshot.repoRoot, base);
  try {
    const payload = await selectNativeDiff(snapshot, readers);
    if (!deps.alive()) return true;
    ui.notify(`${NATIVE_DIFF_NOTIFY_PREFIX}${JSON.stringify(payload)}`, "info");
    const empty = snapshot.files.length === 0 && snapshot.omittedFiles === 0;
    if (kind === "session" && empty && readers.countUncommitted) {
      const count = await readers.countUncommitted();
      if (!deps.alive()) return true;
      if (count !== undefined && count > 0) ui.notify(uncommittedHint(count), "info");
    }
    return true;
  } finally {
    readers.dispose();
  }
}
