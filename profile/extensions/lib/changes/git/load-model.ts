import type { DiffFile, DiffModel, DiffNotice, ExecRunner, TurnTreeProvider } from "../types.ts";
import { createGitExecRunner, DiffDisposedError, DiffGitError } from "./exec.ts";
import { diffKind } from "./file-body.ts";
import { resolveDiffLimits, type DiffLimits } from "./limits.ts";
import type { DiffSource, FileBody, FileSummary } from "./model.ts";
import { createDiffStore, type DiffStoreOptions } from "./store.ts";
import { mapLimited } from "./worktree-files.ts";

export type LoadDiffModelOptions = {
  cwd: string;
  source: DiffSource;
  limits?: Partial<DiffLimits>;
  turns?: TurnTreeProvider;
  exec?: ExecRunner;
  isCurrent: () => boolean;
  skipContents?: (file: { path: string; oldPath?: string }) => boolean;
  onlyPath?: string;
};

export type LoadedDiffModel = {
  model: DiffModel;
  notices: DiffNotice[];
  omittedFiles: number;
};

export class DiffLoadCancelledError extends Error {
  constructor() {
    super("The diff load was cancelled.");
    this.name = "DiffLoadCancelledError";
  }
}

const BODY_CONCURRENCY = 4;
const OWNERSHIP_POLL_MS = 100;

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mebibytes = bytes / (1024 * 1024);
    return `${Number.isInteger(mebibytes) ? mebibytes : mebibytes.toFixed(1)} MiB`;
  }
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} bytes`;
}

export function noticeForBody(body: FileBody): string | undefined {
  switch (body.kind) {
    case "text":
    case "binary":
      return undefined;
    case "too-large":
      return `Not shown: ${formatBytes(body.bytes)} is over the ${formatBytes(body.limit)} file limit.`;
    case "unreadable":
      return `Not shown: ${body.reason}`;
    case "gone":
      return "Not shown: the file changed while the review was loading.";
  }
}

function emptyFile(summary: FileSummary, kind: DiffFile["kind"], counted: boolean): DiffFile {
  const file: DiffFile = {
    path: summary.path,
    kind,
    hunks: [],
    additions: counted ? (summary.additions ?? 0) : 0,
    deletions: counted ? (summary.deletions ?? 0) : 0,
  };
  if (summary.oldPath !== undefined) file.oldPath = summary.oldPath;
  return file;
}

function fileFor(summary: FileSummary, body: FileBody): DiffFile {
  if (body.kind === "text") return body.file;
  if (body.kind === "binary") return emptyFile(summary, "binary", false);
  return emptyFile(summary, diffKind(summary), true);
}

export async function loadDiffModel(options: LoadDiffModelOptions): Promise<LoadedDiffModel> {
  const isCurrent = options.isCurrent;
  const limits = resolveDiffLimits(options.limits);
  const controller = new AbortController();
  const storeOptions: DiffStoreOptions = {
    cwd: options.cwd,
    exec: options.exec ?? createGitExecRunner(limits, controller.signal),
    limits,
  };
  if (options.turns !== undefined) storeOptions.checkpoints = options.turns;
  const store = createDiffStore(storeOptions);
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    controller.abort();
    store.dispose();
  };
  const ensureCurrent = () => {
    if (cancelled || !isCurrent()) {
      cancel();
      throw new DiffLoadCancelledError();
    }
  };
  const poll = setInterval(() => {
    if (!isCurrent()) cancel();
  }, OWNERSHIP_POLL_MS);
  try {
    ensureCurrent();
    store.setSource(options.source);
    await store.refreshNow();
    ensureCurrent();
    const state = store.getState();
    if (state.kind === "error") throw new DiffGitError(state.message);
    if (state.kind === "not-a-repository") {
      throw new DiffGitError(`${options.cwd} is not inside a Git repository.`);
    }
    if (state.kind !== "ready") throw new DiffGitError("No change list was read.");
    const snapshot = state.snapshot;
    const listed =
      options.onlyPath === undefined
        ? snapshot.files
        : snapshot.files.filter((summary) => summary.path === options.onlyPath);
    const skipped = (summary: FileSummary) => options.skipContents?.(summary) === true;
    const bodies = await mapLimited(listed, BODY_CONCURRENCY, async (summary) => {
      if (skipped(summary)) return undefined;
      ensureCurrent();
      const { body } = await store.loadFile(summary.path);
      ensureCurrent();
      return body;
    });
    ensureCurrent();
    const files: DiffFile[] = [];
    const notices: DiffNotice[] = [];
    const hidden: string[] = [];
    listed.forEach((summary, index) => {
      if (skipped(summary)) {
        files.push(emptyFile(summary, summary.binary ? "binary" : diffKind(summary), true));
        hidden.push(summary.path);
        return;
      }
      const body: FileBody = bodies[index] ?? { kind: "gone" };
      files.push(fileFor(summary, body));
      const message = noticeForBody(body);
      if (message !== undefined) notices.push({ path: summary.path, message });
    });
    const model: DiffModel = {
      baseSha: snapshot.base,
      headSha: snapshot.head ?? "",
      files,
    };
    if (notices.length > 0) model.notices = notices;
    if (snapshot.omittedFiles > 0) model.omittedFiles = snapshot.omittedFiles;
    if (hidden.length > 0) model.hidden = hidden;
    const untracked = listed
      .filter((summary) => summary.status === "untracked")
      .map((summary) => summary.path);
    if (untracked.length > 0) model.untracked = untracked;
    return { model, notices, omittedFiles: snapshot.omittedFiles };
  } catch (error) {
    if (cancelled || error instanceof DiffDisposedError) throw new DiffLoadCancelledError();
    throw error;
  } finally {
    clearInterval(poll);
    store.dispose();
  }
}
