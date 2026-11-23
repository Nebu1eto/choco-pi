import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import type { DiffClock } from "../../lib/changes/git/clock.ts";
import type { DefaultBaseChoice } from "../../lib/changes/git/default-base.ts";
import type { DiffSource, DiffStore } from "../../lib/changes/git/model.ts";
import type { SessionBaselineChoice, TurnTreeProvider } from "../../lib/changes/types.ts";
import type { TurnCheckpointInfo } from "../core/checkpoints.ts";
import type { RecordsReader, FindingsSummary } from "../../lib/changes/findings.ts";
import type { DiffPaneDefault } from "../../lib/agent-preferences.ts";
import { markdownFailure, markdownText } from "../../lib/changes/markdown.ts";
import type { RuntimeValue } from "../../lib/runtime-values.ts";
import type { PaneHost, PaneTui } from "../host/types.ts";
import type { PaneStyler } from "./format.ts";
import { NotesBook } from "../../lib/changes/notes.ts";
import { PaneView, type FileBodyRenderer } from "./pane-view.ts";
import type { PrefsIo, PrefsStore } from "./prefs.ts";
import type { HeaderBoxRenderer } from "../../lib/changes/view/header-box.ts";
import type { CommentReader } from "../../lib/changes/review-comments.ts";

export const TOGGLE_SHORTCUT: KeyId = "ctrl+alt+p";
export const FOCUS_SHORTCUT: KeyId = "ctrl+alt+f";
export const ENTER_PANE_SHORTCUT: KeyId = "shift+right";
export const DOUBLE_ESCAPE_MS = 500;
export const SUBAGENT_DONE_EVENTS = [
  "subagents:completed",
  "subagents:failed",
  "subagents:stopped",
] as const;

export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "read_symbol",
  "read_enclosing",
  "symbol_search",
  "lsp_navigation",
  "lsp_diagnostics",
  "ast_grep_search",
  "ast_grep_outline",
  "ast_grep_dump",
  "web_search",
  "fetch_content",
  "get_search_content",
  "tool_search",
]);

export const SESSION_SOURCE: DiffSource = { kind: "session" };

export type DiffPaneDependencies = {
  createStore(cwd: string, checkpoints?: TurnTreeProvider, source?: DiffSource): DiffStore;
  clock: DiffClock;
  prefsIo: PrefsIo;
  agentDir(): string;
  probe(ui: ExtensionUIContext): PaneTui | undefined;
  styler(ctx: ExtensionContext): PaneStyler;
  renderFileBody?: FileBodyRenderer;
  listTurns?(ctx: ExtensionContext): readonly TurnCheckpointInfo[];
  sessionBaseline?(ctx: ExtensionContext): SessionBaselineChoice;
  defaultBranchBase?(cwd: string): Promise<DefaultBaseChoice>;
  scratchDir?(ctx: ExtensionContext): string | undefined;
  readRecords?: RecordsReader;
  readComments?: CommentReader;
  headerBox?(ctx: ExtensionContext): Promise<HeaderBoxRenderer | undefined>;
  fileChangedAt?(absolutePath: string): Promise<number | null>;
  notesFile?(ctx: ExtensionContext): string | undefined;
  notesIo?: PrefsIo;
  copyText?(text: string): Promise<void>;
  readDefaultStatus?(): Promise<DiffPaneDefault>;
  writeDefaultStatus?(status: DiffPaneDefault): Promise<void>;
  onDefaultStatusChange?(listener: (status: DiffPaneDefault) => void): () => void;
  env?: Readonly<Partial<Record<string, string>>>;
};

export type Session = {
  readonly ctx: ExtensionContext;
  alive: boolean;
  userActed: boolean;
  width: number;
  tui?: PaneTui;
  store?: DiffStore;
  unsubscribeStore?: () => void;
  view?: PaneView;
  host?: PaneHost;
  removeInputListener?: () => void;
  escapeArmedUntil?: number;
  notes?: NotesBook;
  recordedGeneration: number;
  recorded?: FindingsSummary;
  timesRevision?: number;
  commentsGeneration: number;
  commentsRevision?: number;
  branchBase?: string;
  source: DiffSource;
  turnOnly?: number;
  sourceGeneration: number;
  defaultStatus: DiffPaneDefault;
  defaultStatusChosen: boolean;
  prefsPending?: Promise<void>;
  unsubscribeDefaultStatus?: () => void;
  autoArmed: boolean;
  autoHinted: boolean;
  autoFailed: boolean;
  autoCheck: "idle" | "running" | "again";
};

export type OpenResult = { opened: true } | { opened: false; reason: string };
export type BranchChoice =
  | { kind: "found"; source: DiffSource }
  | { kind: "none"; message: string; detail?: string }
  | { kind: "stale" };

export function noBaseMarkdown(choice: { message: string; detail?: string }): string {
  return choice.detail === undefined
    ? markdownText(choice.message)
    : markdownFailure("Cannot find the default base branch:", choice.detail);
}

export type DiffPaneProbe = {
  session(): Session | undefined;
};

export function errorText(error: RuntimeValue): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0] || "unknown error";
}

export type DiffPaneController = {
  readonly pi: ExtensionAPI;
  readonly deps: DiffPaneDependencies;
  readonly env: NonNullable<DiffPaneDependencies["env"]>;
  current: Session | undefined;
  prefsStore: PrefsStore | undefined;
};
