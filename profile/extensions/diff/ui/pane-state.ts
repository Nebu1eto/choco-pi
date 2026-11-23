/** Shared types, constants and state of the `/diff` pane controller (`controller.ts`). */
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
/** From the editor into the open pane; the pane's own Shift+← (and Tab, Esc, q) goes back. */
export const ENTER_PANE_SHORTCUT: KeyId = "shift+right";
/** A second Esc within this window after Esc left the pane closes it. */
export const DOUBLE_ESCAPE_MS = 500;
export const SUBAGENT_DONE_EVENTS = [
  "subagents:completed",
  "subagents:failed",
  "subagents:stopped",
] as const;

/**
 * Tools that never change files: their end does not trigger the automatic
 * opening check. Any other tool (built-in edit, write and bash, extension and
 * MCP tools) may, so the check reads the session source after it.
 */
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
  /**
   * `checkpoints` resolves "since a turn" and session sources; absent when
   * turns are not wired. `source` is the source the store starts with.
   */
  createStore(cwd: string, checkpoints?: TurnTreeProvider, source?: DiffSource): DiffStore;
  clock: DiffClock;
  prefsIo: PrefsIo;
  agentDir(): string;
  probe(ui: ExtensionUIContext): PaneTui | undefined;
  styler(ctx: ExtensionContext): PaneStyler;
  renderFileBody?: FileBodyRenderer;
  /** Turns of the active branch that have a file checkpoint, oldest first. */
  listTurns?(ctx: ExtensionContext): readonly TurnCheckpointInfo[];
  /** Where this session's changes start; omitted means the first turn `listTurns` returns. */
  sessionBaseline?(ctx: ExtensionContext): SessionBaselineChoice;
  /** The base `/diff source branch` uses when none is named; omitted means `main`. */
  defaultBranchBase?(cwd: string): Promise<DefaultBaseChoice>;
  /** Scratch directory holding `verdicts/<work_task>/*.json`; undefined when unknown. */
  scratchDir?(ctx: ExtensionContext): string | undefined;
  /** Reads recorded reviewer and verifier output; omitted means findings are not shown. */
  readRecords?: RecordsReader;
  /**
   * Reads `/review-assist` comments of reviews of this session or branch;
   * omitted means comments are not shown. Read with the review records and
   * whenever the pane shows a new snapshot.
   */
  readComments?: CommentReader;
  /** zentui's box for the pane's header; omitted or undefined draws the theme's own box. */
  headerBox?(ctx: ExtensionContext): Promise<HeaderBoxRenderer | undefined>;
  /** Epoch ms of a file's last change, or null when it cannot be read (for example deleted). */
  fileChangedAt?(absolutePath: string): Promise<number | null>;
  /** File for this session's notes; undefined keeps notes in memory only. */
  notesFile?(ctx: ExtensionContext): string | undefined;
  notesIo?: PrefsIo;
  /** Puts text on the system clipboard; omitted means the pane cannot copy. */
  copyText?(text: string): Promise<void>;
  /** Default startup/auto-open status (`on` | `off` | `auto`); omitted defaults to `auto`. */
  readDefaultStatus?(): Promise<DiffPaneDefault>;
  /** Persists a default-status change made through `/diff auto on | off`. */
  writeDefaultStatus?(status: DiffPaneDefault): Promise<void>;
  /** Subscribes to live default-status changes (for example from `/preferences`). */
  onDefaultStatusChange?(listener: (status: DiffPaneDefault) => void): () => void;
  /**
   * The environment Pi was started with; `process.env` when absent. Under the
   * choco-pi ACP adapter's marker the editor renders notifications as Markdown,
   * and `/diff` sends native diffs or Markdown instead of plain text.
   */
  env?: Readonly<Partial<Record<string, string>>>;
};

export type Session = {
  readonly ctx: ExtensionContext;
  alive: boolean;
  /** The user opened, closed or resized in this session; a late preference load must not override it. */
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
  /** Bumped by every review-record read and change-time scan; a stale result is dropped. */
  recordedGeneration: number;
  recorded?: FindingsSummary;
  timesRevision?: number;
  /** Bumped by every comment read; a stale result is dropped. */
  commentsGeneration: number;
  /** The snapshot revision comments were last read for. */
  commentsRevision?: number;
  /** The base last used for a branch source; resolved from git on first use. */
  branchBase?: string;
  /** The source the store was last given. */
  source: DiffSource;
  /** The first turn of the turns shown alone (←/→ in the pane); undefined for every other source. */
  turnOnly?: number;
  /** Bumped by every source change; a late default-base answer for an older request is dropped. */
  sourceGeneration: number;
  /** The `diffPaneDefault` preference (`on` | `off` | `auto`), updated live from `/preferences` or `/diff auto`. */
  defaultStatus: DiffPaneDefault;
  /** The user changed the default status in this session; a late startup load must not override it. */
  defaultStatusChosen: boolean;
  /** Pending startup preference load, awaited by automatic opening so a slow load cannot be raced. */
  prefsPending?: Promise<void>;
  /** Unsubscribes this session from live default-status changes. */
  unsubscribeDefaultStatus?: () => void;
  /** False after the pane was closed in this session, until the user opens it again. */
  autoArmed: boolean;
  /** The one hint that the pane could not open by itself was shown. */
  autoHinted: boolean;
  /** Automatic opening threw in this session; it stays off until the next session. */
  autoFailed: boolean;
  /** A check is reading the session source; "again" means another trigger arrived meanwhile. */
  autoCheck: "idle" | "running" | "again";
};

export type OpenResult = { opened: true } | { opened: false; reason: string };
export type BranchChoice =
  | { kind: "found"; source: DiffSource }
  // `detail` is git's own text when resolving the default base failed; it is part of `message`.
  | { kind: "none"; message: string; detail?: string }
  | { kind: "stale" };

/** Why there is no default branch base, for the editor: git's own text in a code block. */
export function noBaseMarkdown(choice: { message: string; detail?: string }): string {
  return choice.detail === undefined
    ? markdownText(choice.message)
    : markdownFailure("Cannot find the default base branch:", choice.detail);
}

/** Introspection for tests; never used by the extension itself. */
export type DiffPaneProbe = {
  session(): Session | undefined;
};

export function errorText(error: RuntimeValue): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0] || "unknown error";
}

/** What every part of the controller shares: Pi, the dependencies, and the live session. */
export type DiffPaneController = {
  readonly pi: ExtensionAPI;
  readonly deps: DiffPaneDependencies;
  /** The environment Pi was started with (`DiffPaneDependencies.env`, else `process.env`). */
  readonly env: NonNullable<DiffPaneDependencies["env"]>;
  current: Session | undefined;
  prefsStore: PrefsStore | undefined;
};
