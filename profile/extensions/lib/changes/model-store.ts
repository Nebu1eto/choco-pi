import type {
  DiffSnapshot,
  DiffSource,
  DiffStore,
  DiffStoreState,
  FileBody,
  FileSummary,
  SnapshotBaseline,
} from "./git/model.ts";
import type { DiffFile, DiffModel } from "./types.ts";

export type RevealedFile = { file?: DiffFile; notice?: string };

export type ModelStoreOptions = {
  model: DiffModel;
  source: DiffSource;
  repoRoot: string;
  branch?: string | null;
  baseline?: SnapshotBaseline;
  reveal?: (path: string) => Promise<RevealedFile>;
  reload?: () => Promise<DiffModel>;
  now?: () => number;
};

export type ModelStore = Pick<DiffStore, "getState" | "subscribe" | "loadFile" | "dispose"> & {
  peekFile(path: string): { revision: number; body: FileBody } | undefined;
  model(): DiffModel;
  readonly canRefresh: boolean;
  refresh(): Promise<"changed" | "unchanged" | "stale">;
};

function fileSummaryOf(file: DiffFile, untracked: boolean): FileSummary {
  const binary = file.kind === "binary";
  const summary: FileSummary = {
    path: file.path,
    status: untracked ? "untracked" : file.kind === "binary" ? "modified" : file.kind,
    additions: binary ? null : file.additions,
    deletions: binary ? null : file.deletions,
    binary,
    staged: false,
    unstaged: false,
  };
  if (file.oldPath !== undefined) summary.oldPath = file.oldPath;
  return summary;
}

function fingerprint(model: DiffModel): string {
  return JSON.stringify([
    model.baseSha,
    model.headSha,
    model.files.map((file) => [
      file.path,
      file.oldPath ?? "",
      file.kind,
      file.hunks.map((hunk) => [
        hunk.id,
        hunk.oldStart,
        hunk.oldLines,
        hunk.newStart,
        hunk.newLines,
      ]),
    ]),
    model.hidden ?? [],
    model.notices ?? [],
    model.omittedFiles ?? 0,
    model.untracked ?? [],
  ]);
}

export function createModelStore(options: ModelStoreOptions): ModelStore {
  const now = options.now ?? Date.now;
  const listeners = new Set<(state: DiffStoreState) => void>();
  let model = options.model;
  let print = fingerprint(model);
  let revision = 1;
  let generation = 0;
  let disposed = false;
  const revealed = new Map<string, DiffFile>();

  const snapshotOf = (current: DiffModel): DiffSnapshot => {
    const untracked = new Set(current.untracked ?? []);
    const files = current.files.map((file) => fileSummaryOf(file, untracked.has(file.path)));
    const snapshot: DiffSnapshot = {
      revision,
      source: options.source,
      repoRoot: options.repoRoot,
      head: current.headSha.length > 0 ? current.headSha : null,
      branch: options.branch ?? null,
      base: current.baseSha,
      capturedAt: now(),
      files,
      totals: {
        files: files.length,
        additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
        deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
      },
      omittedFiles: current.omittedFiles ?? 0,
    };
    if (options.baseline) snapshot.baseline = options.baseline;
    return snapshot;
  };
  let state: DiffStoreState = { kind: "ready", snapshot: snapshotOf(model), refreshing: false };

  const publish = (next: DiffStoreState) => {
    state = next;
    for (const listener of listeners) listener(next);
  };

  const heldBody = (path: string): FileBody | undefined => {
    const file = model.files.find((entry) => entry.path === path);
    if (!file) return { kind: "gone" };
    if (model.hidden?.includes(path)) {
      const shown = revealed.get(path);
      return shown ? { kind: "text", file: shown } : undefined;
    }
    const notice = model.notices?.find((entry) => entry.path === path)?.message;
    if (notice !== undefined) {
      return { kind: "unreadable", reason: notice.replace(/^Not shown: /u, "") };
    }
    if (file.kind === "binary") return { kind: "binary" };
    return { kind: "text", file };
  };

  const bodyOf = async (path: string): Promise<FileBody> => {
    const held = heldBody(path);
    if (held) return held;
    if (!options.reveal) {
      return { kind: "unreadable", reason: "this review cannot read the file's contents" };
    }
    const at = revision;
    const result = await options.reveal(path);
    if (disposed || at !== revision) return { kind: "gone" };
    if (result.file) {
      revealed.set(path, result.file);
      return { kind: "text", file: result.file };
    }
    if (result.notice !== undefined) {
      return { kind: "unreadable", reason: result.notice.replace(/^Not shown: /u, "") };
    }
    return { kind: "gone" };
  };

  return {
    canRefresh: options.reload !== undefined,
    getState: () => state,
    peekFile: (path) => {
      const body = heldBody(path);
      return body ? { revision, body } : undefined;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    loadFile: async (path) => {
      const at = revision;
      return { revision: at, body: await bodyOf(path) };
    },
    model: () =>
      revealed.size === 0
        ? model
        : { ...model, files: model.files.map((file) => revealed.get(file.path) ?? file) },
    refresh: async () => {
      const reload = options.reload;
      if (!reload || disposed) return "unchanged";
      generation += 1;
      const mine = generation;
      if (state.kind === "ready") publish({ ...state, refreshing: true });
      let next: DiffModel;
      try {
        next = await reload();
      } catch (error) {
        if (!disposed && mine === generation && state.kind === "ready") {
          publish({ ...state, refreshing: false });
        }
        throw error;
      }
      if (disposed || mine !== generation) return "stale";
      const nextPrint = fingerprint(next);
      if (nextPrint === print) {
        if (state.kind === "ready") publish({ ...state, refreshing: false });
        return "unchanged";
      }
      model = next;
      print = nextPrint;
      revision += 1;
      revealed.clear();
      publish({ kind: "ready", snapshot: snapshotOf(model), refreshing: false });
      return "changed";
    },
    dispose: () => {
      disposed = true;
      generation += 1;
      listeners.clear();
    },
  };
}
