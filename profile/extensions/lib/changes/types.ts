export type DiffSide = "LEFT" | "RIGHT";

export type DiffLine = {
  kind: "context" | "add" | "del";
  oldLine?: number;
  newLine?: number;
  text: string;
};

export type DiffHunk = {
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type DiffFile = {
  path: string;
  oldPath?: string;
  kind: "modified" | "added" | "deleted" | "renamed" | "copied" | "binary";
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
};

export type DiffModel = {
  baseSha: string;
  headSha: string;
  files: DiffFile[];
  notices?: DiffNotice[];
  omittedFiles?: number;
  hidden?: string[];
  untracked?: string[];
};

export type DiffNotice = { path: string; message: string };

export type ExecRunner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; input?: string },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export type HighlightFn = (code: string, lang?: string) => string[];

export type HighlightLimits = {
  enabled: boolean;
  maxFileBytes: number;
  maxDiffLines: number;
};

export type DiffRenderOptions = {
  mode: "unified" | "split";
  width: number;
  highlight: HighlightFn;
  fold: (hunkId: string) => boolean;
};

export type TurnTreeProvider = {
  listTurns(): Promise<Array<{ turnIndex: number; tree: string; label: string }>>;
  sessionBaseline?(): Promise<SessionBaselineChoice>;
};

export type SessionBaselineChoice =
  | { kind: "checkpoint"; tree: string; label: string }
  | { kind: "none"; reason: string };
