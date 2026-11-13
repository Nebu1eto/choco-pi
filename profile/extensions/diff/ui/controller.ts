/**
 * `/diff` pane controller: command, shortcuts, session lifecycle, refresh
 * wiring, automatic opening, and preferences.
 *
 * The pane shows the session source (changes since the session's first file
 * checkpoint) whenever it opens without an explicit source; `/diff source …`
 * applies until the pane closes. Nothing runs before the user first opens the
 * pane, a saved preference says it was open, or a possibly file-changing tool
 * call ends: no store, no git, no timers, no TUI probe. Sessions without the
 * interactive terminal UI get the command (as an inline list) but never a host
 * and never open anything by themselves.
 *
 * Automatic opening: after a tool call that is not known to be read-only, or a
 * subagent's completion, the session source is read; when it lists a change
 * and the pane is closed, the pane docks beside the transcript without taking
 * focus. It never falls back to an overlay or the inline list; when docking is
 * impossible it leaves one hint per session. Closing the pane (any way) stops
 * it for the rest of the session until the user opens the pane again; a new
 * session starts armed. `/diff auto off` (`autoOpen` in the preferences)
 * turns it off.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, type KeyId } from "@earendil-works/pi-tui";
import { join } from "node:path";
import type { DiffClock } from "../../lib/changes/git/clock.ts";
import type { DefaultBaseChoice } from "../../lib/changes/git/default-base.ts";
import type {
  DiffSource,
  DiffStore,
  FileBody,
  FileSummary,
  RefreshReason,
} from "../../lib/changes/git/model.ts";
import { sourceKey } from "../../lib/changes/git/snapshot.ts";
import { plural } from "../../lib/changes/view/rows.ts";
import { sanitizeTerminalText } from "../../lib/changes/terminal-text.ts";
import type { DiffHunk, SessionBaselineChoice, TurnTreeProvider } from "../../lib/changes/types.ts";
import {
  chooseTurn,
  createTurnCheckpointProvider,
  turnOnlySource,
  turnSource,
  type TurnCheckpointInfo,
} from "../core/checkpoints.ts";
import {
  summarizeFindings,
  EMPTY_FINDINGS,
  type RecordsReader,
  type FindingsSummary,
} from "../../lib/changes/findings.ts";
import { isStaleContextError } from "../../lib/lifecycle.ts";
import {
  editorRendersMarkdown,
  markdownFailure,
  markdownText,
} from "../../lib/changes/markdown.ts";
import type { RuntimeValue } from "../../lib/runtime-values.ts";
import { createDockHost } from "../host/dock-host.ts";
import {
  BORDER_WIDTH,
  canHostPane,
  clampPaneWidth,
  MIN_PANE_WIDTH,
  MIN_TRANSCRIPT_WIDTH,
} from "../host/geometry.ts";
import { createOverlayHost } from "../host/overlay-host.ts";
import type { HostCallbacks } from "../../lib/changes/view/surface.ts";
import type { PaneHost, PaneTui } from "../host/types.ts";
import { DIFF_SUBCOMMANDS, FALLBACK_BRANCH_BASE, parseDiffCommand } from "./command.ts";
import {
  inlineList,
  inlineMarkdown,
  sourceLabel,
  type PaneColor,
  type PaneStyler,
} from "./format.ts";
import { presentNativeDiff } from "../native-diff.ts";
import { NotesBook, noteStatus, type DiffNote } from "../../lib/changes/notes.ts";
import {
  normalizeFindingPath,
  PaneView,
  type AskTarget,
  type FileBodyRenderer,
} from "./pane-view.ts";
import {
  createPrefsStore,
  DEFAULT_PANE_PREFS,
  prefsPath,
  type PrefsIo,
  type PrefsStore,
} from "./prefs.ts";
import {
  appendToEditor,
  clipboardText,
  editorPath,
  fileMention,
  hunkRangeText,
  hunkReference,
  linesReference,
  notesMessage,
  reviewInstruction,
  type NoteForMessage,
} from "../../lib/changes/references.ts";
import { isSensitiveFile } from "../../lib/changes/sensitive.ts";
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

const SESSION_SOURCE: DiffSource = { kind: "session" };

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
  /**
   * The environment Pi was started with; `process.env` when absent. Under the
   * choco-pi ACP adapter's marker the editor renders notifications as Markdown,
   * and `/diff` sends native diffs or Markdown instead of plain text.
   */
  env?: Readonly<Partial<Record<string, string>>>;
};

type Session = {
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
  /** The `autoOpen` preference, or the user's `/diff auto` choice in this session. */
  autoOpen: boolean;
  /** The user chose `/diff auto` in this session; a late preference load must not override it. */
  autoChosen: boolean;
  /** False after the pane was closed in this session, until the user opens it again. */
  autoArmed: boolean;
  /** The one hint that the pane could not open by itself was shown. */
  autoHinted: boolean;
  /** Automatic opening threw in this session; it stays off until the next session. */
  autoFailed: boolean;
  /** A check is reading the session source; "again" means another trigger arrived meanwhile. */
  autoCheck: "idle" | "running" | "again";
};

type OpenResult = { opened: true } | { opened: false; reason: string };
type BranchChoice =
  | { kind: "found"; source: DiffSource }
  // `detail` is git's own text when resolving the default base failed; it is part of `message`.
  | { kind: "none"; message: string; detail?: string }
  | { kind: "stale" };

/** Why there is no default branch base, for the editor: git's own text in a code block. */
function noBaseMarkdown(choice: { message: string; detail?: string }): string {
  return choice.detail === undefined
    ? markdownText(choice.message)
    : markdownFailure("Cannot find the default base branch:", choice.detail);
}

/** Introspection for tests; never used by the extension itself. */
export type DiffPaneProbe = {
  session(): Session | undefined;
};

function errorText(error: RuntimeValue): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0] || "unknown error";
}

export function registerDiffPane(pi: ExtensionAPI, deps: DiffPaneDependencies): DiffPaneProbe {
  let current: Session | undefined;
  let prefsStore: PrefsStore | undefined;
  const env = deps.env ?? process.env;

  function prefs(): PrefsStore {
    prefsStore ??= createPrefsStore(prefsPath(deps.agentDir()), deps.prefsIo, deps.clock);
    return prefsStore;
  }

  function sessionFor(ctx: ExtensionContext): Session {
    if (current?.alive) return current;
    current = {
      ctx,
      alive: true,
      userActed: false,
      width: DEFAULT_PANE_PREFS.width,
      recordedGeneration: 0,
      commentsGeneration: 0,
      source: SESSION_SOURCE,
      sourceGeneration: 0,
      autoOpen: DEFAULT_PANE_PREFS.autoOpen,
      autoChosen: false,
      autoArmed: true,
      autoHinted: false,
      autoFailed: false,
      autoCheck: "idle",
    };
    return current;
  }

  function persist(session: Session): void {
    prefs().save({
      open: session.host !== undefined,
      width: session.width,
      autoOpen: session.autoOpen,
    });
  }

  function ensureStore(session: Session): DiffStore {
    if (session.store) return session.store;
    const ctx = session.ctx;
    const listTurns = deps.listTurns;
    const baseline = deps.sessionBaseline;
    const checkpoints = listTurns
      ? createTurnCheckpointProvider(
          () => listTurns(ctx),
          baseline ? () => baseline(ctx) : undefined,
        )
      : undefined;
    const store = deps.createStore(ctx.cwd, checkpoints, session.source);
    session.store = store;
    session.unsubscribeStore = store.subscribe((update) => {
      if (!session.alive) return;
      // A poll can list a new prompt's edits before any event names them. Following
      // changes the source, and `update` is then older than what the store holds.
      const generation = session.sourceGeneration;
      followTurn(session);
      const state = generation === session.sourceGeneration ? update : store.getState();
      session.view?.setState(state);
      if (
        state.kind === "ready" &&
        state.snapshot.revision !== session.timesRevision &&
        (session.recorded?.findings.length ?? 0) > 0
      ) {
        void refreshChangeTimes(session);
      }
      if (state.kind === "ready" && state.snapshot.revision !== session.commentsRevision) {
        void reloadComments(session);
      }
      session.host?.requestRender();
    });
    return store;
  }

  /* ------------------------------------------------------ messages */

  function say(session: Session, text: string, color: PaneColor = "muted"): void {
    if (session.view && session.host) {
      session.view.setMessage(text, color);
      session.host.requestRender();
    } else {
      session.ctx.ui.notify(
        sanitizeTerminalText(text),
        color === "warning" || color === "error" ? "warning" : "info",
      );
    }
  }

  /**
   * Confirm a source switch. The open pane names its source on the header's
   * border, so there it only clears an older message (an earlier failure
   * would otherwise stay up); a closed pane gets a notice.
   */
  function saySource(session: Session, source: DiffSource): void {
    if (session.view && session.host) {
      session.view.clearMessage();
      session.host.requestRender();
    } else {
      say(session, `Diff source: ${sourceLabel(source)}.`);
    }
  }

  /**
   * Show a failure of work nothing awaits: in the open pane, else as a notice.
   * Silent once the session ended or its context went stale. Never throws, so
   * it is safe as the last handler of a fire-and-forget promise.
   */
  function reportFailure(session: Session, text: string, error: RuntimeValue): void {
    if (!session.alive || isStaleContextError(error)) return;
    try {
      say(session, text, "error");
    } catch (failure) {
      if (isStaleContextError(failure) || !session.view || !session.host) return;
      // The pane could not show it: try a notice instead.
      try {
        session.ctx.ui.notify(sanitizeTerminalText(text), "warning");
      } catch {
        // Neither the pane nor a notice can show it; there is nowhere left to report it.
      }
    }
  }

  /** Give keyboard focus back to the prompt editor without arming double-Esc close. */
  function returnToEditor(session: Session): void {
    if (session.host?.isFocused()) session.host.unfocus();
  }

  function insertIntoEditor(session: Session, text: string): void {
    const ui = session.ctx.ui;
    ui.setEditorText(appendToEditor(ui.getEditorText(), text));
    returnToEditor(session);
  }

  /* ------------------------------------------------- review records */

  function findingPaths(session: Session, recorded: FindingsSummary): string[] {
    const state = session.store?.getState();
    if (state?.kind !== "ready") return [];
    const listed = new Set(state.snapshot.files.map((file) => file.path));
    const paths = new Set<string>();
    for (const finding of recorded.findings) {
      const path = normalizeFindingPath(finding.path, state.snapshot.repoRoot);
      if (listed.has(path)) paths.add(path);
    }
    return [...paths];
  }

  async function changeTimesFor(
    session: Session,
    recorded: FindingsSummary,
  ): Promise<Map<string, number | null>> {
    const times = new Map<string, number | null>();
    const stat = deps.fileChangedAt;
    const state = session.store?.getState();
    if (!stat || state?.kind !== "ready") return times;
    const root = state.snapshot.repoRoot;
    for (const path of findingPaths(session, recorded)) {
      times.set(path, await stat(join(root, path)).catch(() => null));
    }
    return times;
  }

  /**
   * A review-record read or change-time scan threw: keep the findings last read and
   * add the failure to the summary's read errors, which the header counts and
   * the findings list shows. Never throws.
   */
  function recordedFailed(session: Session, error: RuntimeValue): void {
    if (!session.alive || isStaleContextError(error)) return;
    const text = `Cannot read the review records: ${errorText(error)}`;
    const previous = session.recorded ?? EMPTY_FINDINGS;
    const recorded = previous.errors.includes(text)
      ? previous
      : { ...previous, errors: [...previous.errors, text] };
    session.recorded = recorded;
    try {
      session.view?.setRecorded(recorded, session.view.changeTimes);
      session.host?.requestRender();
    } catch (failure) {
      reportFailure(session, text, failure);
    }
  }

  /**
   * Re-read the review records (first use, manual refresh, subagent completion). Never
   * polls and never rejects: a failure is shown with the summary's read errors.
   */
  async function reloadRecorded(session: Session): Promise<void> {
    const read = deps.readRecords;
    if (!read || !session.view) return;
    let generation: number | undefined;
    try {
      const scratch = deps.scratchDir?.(session.ctx);
      if (!scratch) return;
      session.recordedGeneration += 1;
      generation = session.recordedGeneration;
      const listing = await read(scratch).catch((error: RuntimeValue) => ({
        tasks: [],
        errors: [`Cannot read the review records: ${errorText(error)}`],
      }));
      if (!session.alive || generation !== session.recordedGeneration) return;
      const recorded = summarizeFindings(listing);
      const revision = currentRevision(session);
      const times = await changeTimesFor(session, recorded);
      if (!session.alive || generation !== session.recordedGeneration) return;
      session.recorded = recorded;
      session.timesRevision = revision;
      session.view?.setRecorded(recorded, times);
      session.host?.requestRender();
    } catch (error) {
      if (generation !== undefined && generation !== session.recordedGeneration) return;
      recordedFailed(session, error);
    }
  }

  /** The working tree changed: re-check which findings predate their file's last change. Never rejects. */
  async function refreshChangeTimes(session: Session): Promise<void> {
    const recorded = session.recorded;
    if (!recorded) return;
    session.recordedGeneration += 1;
    const generation = session.recordedGeneration;
    try {
      const revision = currentRevision(session);
      session.timesRevision = revision;
      const times = await changeTimesFor(session, recorded);
      if (!session.alive || generation !== session.recordedGeneration) return;
      session.view?.setRecorded(recorded, times);
      session.host?.requestRender();
    } catch (error) {
      if (generation !== session.recordedGeneration) return;
      recordedFailed(session, error);
    }
  }

  function currentRevision(session: Session): number | undefined {
    const state = session.store?.getState();
    return state?.kind === "ready" ? state.snapshot.revision : undefined;
  }

  function manualRefresh(session: Session): void {
    followTurn(session);
    session.store?.requestRefresh("manual");
    void reloadRecorded(session);
    void reloadComments(session);
  }

  /**
   * Re-read the `/review-assist` comments for the snapshot shown (first use, each new
   * snapshot, manual refresh, subagent completion). Never rejects: a failure is shown
   * in the pane's message line and the comments last read stay.
   */
  async function reloadComments(session: Session): Promise<void> {
    const read = deps.readComments;
    const view = session.view;
    const state = session.store?.getState();
    if (!read || !view || state?.kind !== "ready") return;
    session.commentsGeneration += 1;
    const generation = session.commentsGeneration;
    const snapshot = state.snapshot;
    session.commentsRevision = snapshot.revision;
    try {
      const sessionId = session.ctx.sessionManager.getSessionId();
      const comments = await read({
        repoRoot: snapshot.repoRoot,
        sessionId: sessionId || undefined,
        branch: snapshot.branch,
      });
      if (!session.alive || generation !== session.commentsGeneration) return;
      session.view?.setComments(comments);
      session.host?.requestRender();
    } catch (error) {
      if (generation !== session.commentsGeneration) return;
      reportFailure(session, `Cannot read the review comments: ${errorText(error)}`, error);
    }
  }

  /* ---------------------------------------------------------- sources */

  function applySource(session: Session, source: DiffSource): void {
    if (source.kind === "branch-base") session.branchBase = source.base;
    session.source = source;
    delete session.turnOnly;
    session.sourceGeneration += 1;
    const store = ensureStore(session);
    store.setSource(source);
    if (session.view) {
      session.view.source = source;
      session.view.selectedHunk = undefined;
    }
  }

  /** Opening without an explicit source, and closing, return to the session source. */
  function resetToSessionSource(session: Session): void {
    if (session.source.kind === "session") return;
    applySource(session, SESSION_SOURCE);
  }

  function turnsOf(session: Session): readonly TurnCheckpointInfo[] {
    try {
      return deps.listTurns?.(session.ctx) ?? [];
    } catch {
      return [];
    }
  }

  /** A branch source for `base`, or for the repository's default base when it is undefined. */
  async function branchSource(session: Session, base: string | undefined): Promise<BranchChoice> {
    if (base !== undefined) return { kind: "found", source: { kind: "branch-base", base } };
    const known = session.branchBase;
    if (known !== undefined) return { kind: "found", source: { kind: "branch-base", base: known } };
    const resolve = deps.defaultBranchBase;
    if (!resolve) {
      return { kind: "found", source: { kind: "branch-base", base: FALLBACK_BRANCH_BASE } };
    }
    const generation = session.sourceGeneration;
    let choice: DefaultBaseChoice;
    let detail: string | undefined;
    try {
      choice = await resolve(session.ctx.cwd);
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
      choice = { kind: "none", message: `Cannot find the default base branch: ${detail}` };
    }
    if (!session.alive || generation !== session.sourceGeneration) return { kind: "stale" };
    if (choice.kind === "none") {
      return detail === undefined
        ? { kind: "none", message: choice.message }
        : { kind: "none", message: choice.message, detail };
    }
    session.branchBase = choice.base;
    return { kind: "found", source: { kind: "branch-base", base: choice.base } };
  }

  /** An explicit `/diff source …`: show it, opening the pane when it is closed. */
  async function showSource(session: Session, source: DiffSource): Promise<void> {
    applySource(session, source);
    if (session.host) {
      saySource(session, source);
      return;
    }
    if (await userOpen(session, { keepSource: true })) {
      saySource(session, source);
      return;
    }
    // The inline list showed it; the pane is still closed, so the explicit source ends here.
    if (session.alive) resetToSessionSource(session);
  }

  /** `/diff source branch [<base>]`; keeps the current source when no base exists. */
  async function sourceBranch(session: Session, base: string | undefined): Promise<void> {
    const choice = await branchSource(session, base);
    if (choice.kind === "stale") return;
    if (choice.kind === "none") {
      say(session, `${choice.message} The diff source is unchanged.`, "warning");
      return;
    }
    await showSource(session, choice.source);
  }

  /** `/diff source turn [<n>]`; keeps the current source when no checkpoint matches. */
  async function sourceTurn(session: Session, turn: number | undefined): Promise<void> {
    const choice = chooseTurn(turnsOf(session), turn);
    if (choice.kind === "none") {
      say(session, choice.message, "warning");
      return;
    }
    await showSource(session, turnSource(choice.turn));
  }

  /** The pane's `s` key: session, uncommitted, latest turn, branch base, and around again. */
  async function cycleSource(session: Session): Promise<void> {
    // A turn shown alone is outside the cycle, which starts over from it.
    if (session.turnOnly !== undefined) {
      applySource(session, SESSION_SOURCE);
      saySource(session, SESSION_SOURCE);
      return;
    }
    const now = session.source;
    let next: DiffSource = SESSION_SOURCE;
    let note = "";
    if (now.kind === "session") {
      next = { kind: "uncommitted" };
    } else if (now.kind === "uncommitted") {
      const choice = chooseTurn(turnsOf(session), undefined);
      if (choice.kind === "found") next = turnSource(choice.turn);
      else {
        note = "No turn checkpoint exists in this session yet, so the turn source was skipped. ";
        const branch = await branchSource(session, undefined);
        if (branch.kind === "stale") return;
        if (branch.kind === "found") next = branch.source;
        else note += `${branch.message} `;
      }
    } else if (now.kind === "since-checkpoint") {
      const branch = await branchSource(session, undefined);
      if (branch.kind === "stale") return;
      if (branch.kind === "found") next = branch.source;
      else note = `${branch.message} `;
    }
    applySource(session, next);
    if (note) say(session, `${note}Diff source: ${sourceLabel(next)}.`, "warning");
    else saySource(session, next);
  }

  /** Show `turns[index]` alone; false when there is no such turn. */
  function showTurnOnly(
    session: Session,
    turns: readonly TurnCheckpointInfo[],
    index: number,
  ): boolean {
    const turn = turns[index];
    const source = turnOnlySource(turns, index);
    if (!turn || !source) return false;
    applySource(session, source);
    session.turnOnly = turn.turn;
    return true;
  }

  /**
   * The pane's ← and →. The turns are in order with every session change after
   * the newest: ← goes to the turn before the one shown, or to the newest from
   * any other source; → goes to the turn after it and then to the session.
   */
  function stepTurn(session: Session, delta: -1 | 1): void {
    const turns = turnsOf(session);
    const shown =
      session.turnOnly === undefined
        ? -1
        : turns.findIndex((turn) => turn.turn === session.turnOnly);
    const index = (shown < 0 ? turns.length : shown) + delta;
    if (index >= turns.length) {
      if (session.source.kind === "session") {
        say(session, "Every change of the session is shown; ← shows its newest turn alone.");
        return;
      }
      applySource(session, SESSION_SOURCE);
      saySource(session, SESSION_SOURCE);
      return;
    }
    if (turns.length === 0) {
      say(session, "No turn of this session has a file checkpoint, so no turn can be shown alone.");
      return;
    }
    if (!showTurnOnly(session, turns, index)) {
      say(session, "This is the session's first turn with a file checkpoint.");
      return;
    }
    say(
      session,
      `Diff source: ${sourceLabel(session.source)}, ${index + 1} of ${turns.length} (← older, → newer).`,
    );
  }

  /**
   * Keep a turn shown alone on its own changes. The newest turn is compared
   * with the working tree until the next prompt records a checkpoint, and with
   * that checkpoint from then on; a turn that left the branch gives way to the
   * session source.
   */
  function followTurn(session: Session): void {
    if (session.turnOnly === undefined) return;
    const turns = turnsOf(session);
    const index = turns.findIndex((turn) => turn.turn === session.turnOnly);
    const source = turnOnlySource(turns, index);
    if (!source) {
      applySource(session, SESSION_SOURCE);
      say(
        session,
        "The turn that was shown is not on this branch any more. Diff source: Session changes.",
      );
      return;
    }
    if (sourceKey(source) !== sourceKey(session.source)) showTurnOnly(session, turns, index);
  }

  /* ---------------------------------------------------------- actions */

  function mentionFor(session: Session, path: string): string {
    const state = session.store?.getState();
    const root = state?.kind === "ready" ? state.snapshot.repoRoot : session.ctx.cwd;
    return fileMention(editorPath(root, session.ctx.cwd, path));
  }

  function ask(session: Session, target: AskTarget): void {
    const mention = mentionFor(session, target.file.path);
    const sensitive = isSensitiveFile(target.file);
    const hunk: DiffHunk | undefined = target.hunk;
    if (!hunk) {
      insertIntoEditor(session, mention);
      say(
        session,
        sensitive
          ? `Sensitive file: only its path is in the editor. Type your question.`
          : "File reference added to the editor. Type your question; nothing was sent.",
        sensitive ? "warning" : "muted",
      );
      return;
    }
    const lines = target.lines;
    // An earlier turn's numbers are of the file as that turn left it.
    const shown = session.source;
    const context =
      shown.kind === "range" && shown.turnOnly
        ? `as the file was after ${shown.label}; it may have changed since`
        : undefined;
    const reference = lines
      ? linesReference(mention, hunk, lines, sensitive, context)
      : hunkReference(mention, hunk, sensitive, context);
    insertIntoEditor(session, reference.text);
    if (sensitive) {
      say(
        session,
        "Sensitive file: only its path was put in the editor, never its contents.",
        "warning",
      );
    } else if (!reference.includesContent) {
      say(
        session,
        `The ${lines ? "selection" : "hunk"} is longer than 60 lines, so only its range was inserted.`,
        "warning",
      );
    } else {
      say(
        session,
        `${lines ? "Selected lines" : "Hunk"} added to the editor. Type your question; nothing was sent.`,
      );
    }
  }

  /** The pane's copy key: the selected lines as code, or the cursor's hunk as a diff. */
  function copy(session: Session, target: AskTarget): void {
    const hunk = target.hunk;
    if (!hunk) {
      say(session, "Nothing to copy on a file's row: move to a line or a hunk with ↑/↓ first.");
      return;
    }
    const write = deps.copyText;
    if (!write) {
      say(session, "Copying is not available here.", "warning");
      return;
    }
    const lines = target.lines;
    const text = clipboardText(hunk, lines);
    const copied = lines
      ? `Copied ${plural(lines.last - lines.first + 1, "line")}.`
      : `Copied the hunk as a diff (${plural(hunk.lines.length, "line")}).`;
    void (async () => {
      await write(text);
      if (session.alive) say(session, copied);
    })().catch((error: RuntimeValue) =>
      reportFailure(session, `Cannot copy to the clipboard: ${errorText(error)}`, error),
    );
  }

  function notesFor(session: Session): NotesBook {
    if (session.notes) return session.notes;
    const book = new NotesBook({
      io: deps.notesIo,
      file: deps.notesIo ? deps.notesFile?.(session.ctx) : undefined,
      onChange: () => {
        if (!session.alive) return;
        // Also runs inside the book's file read: a throw here would leave that read rejected for good.
        try {
          session.view?.invalidate();
          session.host?.requestRender();
        } catch (error) {
          reportFailure(session, `Cannot redraw the diff pane: ${errorText(error)}`, error);
        }
      },
    });
    session.notes = book;
    if (session.view) session.view.notes = book;
    void book
      .load()
      .catch((error: RuntimeValue) =>
        reportFailure(session, `Cannot read the diff notes: ${errorText(error)}`, error),
      );
    return book;
  }

  function addNote(session: Session, file: FileSummary, hunk: DiffHunk, text: string): void {
    notesFor(session).add({
      path: file.path,
      hunk,
      range: hunkRangeText(hunk),
      text,
      now: deps.clock.now(),
    });
    say(
      session,
      `Note added on ${file.path} ${hunkRangeText(hunk)}. Press a to put the notes in the editor.`,
    );
  }

  /**
   * The newest loaded body of each note's path, with the revision the store
   * gave it (the snapshot current when that load began). When a body is not of
   * the snapshot current after the loads, the paths are loaded once more. This
   * only improves the chance of a match; whether a body may be used is decided
   * by the caller against the snapshot current when it sends. Undefined when
   * the session ended.
   */
  async function noteHunks(
    session: Session,
    store: DiffStore,
    notes: readonly DiffNote[],
  ): Promise<Map<string, { revision: number; body: FileBody }> | undefined> {
    const loaded = new Map<string, { revision: number; body: FileBody }>();
    const paths = [...new Set(notes.map((note) => note.path))];
    const current = () => {
      const state = store.getState();
      return state.kind === "ready" ? state.snapshot : undefined;
    };
    for (let pass = 0; pass < 2; pass += 1) {
      const listed = new Set(current()?.files.map((file) => file.path) ?? []);
      for (const path of paths) {
        if (!listed.has(path)) continue;
        loaded.set(path, await store.loadFile(path));
        if (!session.alive) return undefined;
      }
      const revision = current()?.revision;
      if ([...loaded.values()].every((entry) => entry.revision === revision)) break;
    }
    return loaded;
  }

  /**
   * All notes as one message in the editor, with each note's current or last
   * known range (the pane's `a` while there are notes, and `/diff notes
   * send`). The notes are then cleared: they are in the editor, and `a` asks
   * about the cursor's target again.
   */
  async function sendNotes(session: Session): Promise<void> {
    const book = notesFor(session);
    await book.load();
    if (!session.alive) return;
    const read = book.notes;
    if (read.length === 0) {
      say(session, "No notes yet: select a hunk (n/N) and press c.", "warning");
      return;
    }
    const store = ensureStore(session);
    const loaded = await noteHunks(session, store, read);
    if (!loaded) return;
    // No await below: the snapshot read here is the one the text is sent against, and a
    // body is used only when it is of that snapshot. Anything else leaves the note outdated.
    // A note another send took while this one waited is not sent twice.
    const held = new Set(book.notes.map((note) => note.id));
    const notes = read.filter((note) => held.has(note.id));
    if (notes.length === 0) return;
    const state = store.getState();
    const revision = state.kind === "ready" ? state.snapshot.revision : undefined;
    const files = new Map(
      state.kind === "ready" ? state.snapshot.files.map((file) => [file.path, file]) : [],
    );
    const hunks = new Map<string, readonly DiffHunk[]>();
    for (const [path, entry] of loaded) {
      if (entry.revision !== revision) continue;
      hunks.set(path, entry.body.kind === "text" ? entry.body.file.hunks : []);
    }
    const entries: NoteForMessage[] = notes.map((note) => {
      const file = files.get(note.path);
      // A path with no body of the current snapshot has no hunks: its notes go as outdated.
      const status = noteStatus(note, file !== undefined, hunks.get(note.path));
      return {
        mention: mentionFor(session, note.path),
        range: status.kind === "current" ? hunkRangeText(status.hunk) : note.range,
        outdated: status.kind !== "current",
        text: note.text,
      };
    });
    insertIntoEditor(session, notesMessage(entries));
    book.remove(notes);
    say(
      session,
      `${plural(entries.length, "note")} put in the editor and cleared from the pane; nothing was sent.`,
    );
  }

  async function clearNotes(session: Session): Promise<void> {
    const book = notesFor(session);
    await book.load();
    if (!session.alive) return;
    const count = book.clear();
    say(
      session,
      count === 0 ? "No notes to clear." : `Cleared ${count === 1 ? "1 note" : `${count} notes`}.`,
    );
  }

  function startReview(session: Session): void {
    const state = session.store?.getState();
    let source: DiffSource = state?.kind === "ready" ? state.snapshot.source : session.source;
    if (state?.kind === "ready" && source.kind === "session") {
      const baseline = state.snapshot.baseline;
      // The agent reviews the same comparison: the working tree against the session's checkpoint.
      if (baseline?.kind === "checkpoint") {
        source = {
          kind: "since-checkpoint",
          checkpointId: state.snapshot.base,
          label: baseline.label,
        };
      }
    }
    insertIntoEditor(session, reviewInstruction(source));
    say(session, "Review instruction put in the editor; edit it and press Enter to start.");
  }

  function effectiveWidth(session: Session): number {
    const tui = session.tui;
    return tui ? clampPaneWidth(session.width, tui.terminal.columns) : session.width;
  }

  function setWidth(session: Session, width: number): void {
    session.userActed = true;
    const tui = session.tui;
    session.width = tui
      ? clampPaneWidth(width, tui.terminal.columns)
      : Math.max(MIN_PANE_WIDTH, width);
    session.host?.setWidth(effectiveWidth(session));
    persist(session);
  }

  function ensureView(session: Session, store: DiffStore): PaneView {
    if (session.view) return session.view;
    const view = new PaneView({
      store,
      styler: deps.styler(session.ctx),
      renderFileBody: deps.renderFileBody,
      actions: {
        unfocus: () => {
          session.host?.unfocus();
          session.escapeArmedUntil = deps.clock.now() + DOUBLE_ESCAPE_MS;
        },
        close: () => closePane(session),
        resizeBy: (delta) => setWidth(session, effectiveWidth(session) + delta),
        refresh: () => manualRefresh(session),
        requestRender: () => session.host?.requestRender(),
        isToggleKey: (data) => matchesKey(data, TOGGLE_SHORTCUT),
        isFocusKey: (data) => matchesKey(data, FOCUS_SHORTCUT),
        ask: (target) => ask(session, target),
        copy: (target) => copy(session, target),
        addNote: (file, hunk, text) => addNote(session, file, hunk, text),
        sendNotes: () =>
          void sendNotes(session).catch((error: RuntimeValue) =>
            reportFailure(
              session,
              `Cannot put the notes in the editor: ${errorText(error)}`,
              error,
            ),
          ),
        cycleSource: () =>
          void cycleSource(session).catch((error: RuntimeValue) =>
            reportFailure(session, `Cannot change the diff source: ${errorText(error)}`, error),
          ),
        stepTurn: (delta) => stepTurn(session, delta),
        startReview: () => startReview(session),
      },
    });
    view.source = session.source;
    view.setState(store.getState());
    session.view = view;
    view.notes = notesFor(session);
    void reloadRecorded(session);
    void reloadComments(session);
    loadHeaderBox(session, view);
    return view;
  }

  /** zentui's header box, when installed; the view draws its own until it arrives. */
  function loadHeaderBox(session: Session, view: PaneView): void {
    const load = deps.headerBox;
    if (!load) return;
    void (async () => {
      const box = await load(session.ctx);
      if (!session.alive || session.view !== view || !box) return;
      view.headerBox = box;
      session.host?.requestRender();
    })().catch(() => {
      // zentui could not be loaded: the header keeps the theme's own box, which is complete.
    });
  }

  /** Why the pane cannot dock now, or undefined when it can try. */
  function dockBlocker(session: Session): string | undefined {
    const ctx = session.ctx;
    if (ctx.mode !== "tui") return "it needs the terminal UI";
    session.tui ??= deps.probe(ctx.ui);
    const tui = session.tui;
    if (!tui) return "the terminal UI could not be reached";
    if (tui.mode !== "fullscreen") return "it needs fullscreen mode (/settings, TUI mode)";
    if (!canHostPane(tui.terminal.columns)) {
      const needed = MIN_PANE_WIDTH + MIN_TRANSCRIPT_WIDTH + BORDER_WIDTH;
      return `the terminal is ${tui.terminal.columns} columns wide and it needs ${needed}`;
    }
    return undefined;
  }

  /**
   * Mount the pane. `overlay` allows the overlay host when docking fails
   * (user and restored opens); automatic opening never uses it.
   */
  function openPane(
    session: Session,
    options: { announce: boolean; overlay: boolean },
  ): OpenResult {
    const announce = options.announce;
    if (session.host) return { opened: true };
    const ctx = session.ctx;
    if (ctx.mode !== "tui")
      return { opened: false, reason: "The diff pane needs the terminal UI." };
    session.tui ??= deps.probe(ctx.ui);
    const tui = session.tui;
    if (!tui) return { opened: false, reason: "The diff pane could not reach the terminal UI." };
    if (tui.mode !== "fullscreen") {
      return {
        opened: false,
        reason:
          "The diff pane needs fullscreen mode (/settings, TUI mode); showing a list instead.",
      };
    }
    if (!canHostPane(tui.terminal.columns)) {
      const needed = MIN_PANE_WIDTH + MIN_TRANSCRIPT_WIDTH + BORDER_WIDTH;
      return {
        opened: false,
        reason: `The terminal is ${tui.terminal.columns} columns wide; the diff pane needs ${needed}. Showing a list instead.`,
      };
    }
    const store = ensureStore(session);
    const view = ensureView(session, store);
    const callbacks: HostCallbacks = {
      width: () => effectiveWidth(session),
      resizeTo: (width) => setWidth(session, width),
      failed: (kind, error) => paneFailed(session, host, kind, error),
    };
    let host: PaneHost = createDockHost(tui, view, callbacks);
    let docked: boolean;
    try {
      docked = host.install();
    } catch (error) {
      // Automatic opening reports the failure and stops; a user's open falls back to the overlay.
      if (!options.overlay) throw error;
      docked = false;
    }
    let overlayFallback = false;
    if (!docked) {
      if (!options.overlay) {
        return { opened: false, reason: "Pi's screen layout is not the expected one" };
      }
      host = createOverlayHost(tui, view, callbacks);
      if (!host.install()) return { opened: false, reason: "The diff pane could not be mounted." };
      overlayFallback = true;
    }
    session.host = host;
    session.removeInputListener = tui.addInputListener((data) => {
      if (isKeyRelease(data)) return undefined;
      const armedUntil = session.escapeArmedUntil;
      session.escapeArmedUntil = undefined;
      if (
        armedUntil !== undefined &&
        deps.clock.now() <= armedUntil &&
        matchesKey(data, "escape") &&
        !host.isFocused()
      ) {
        closePane(session);
        return { consume: true };
      }
      return undefined;
    });
    store.setVisible(true);
    store.requestRefresh("open");
    if (overlayFallback && announce) {
      // On the pane's own message line: the overlay covers the transcript column
      // where a notification would be drawn, and clipped it.
      say(
        session,
        "Opened as an overlay because Pi's screen layout is not the expected one. Close it (/diff close) before changing the TUI mode.",
        "warning",
      );
    }
    return { opened: true };
  }

  function closePane(session: Session): void {
    const host = session.host;
    if (!host) return;
    session.host = undefined;
    session.escapeArmedUntil = undefined;
    session.removeInputListener?.();
    session.removeInputListener = undefined;
    host.uninstall();
    session.store?.setVisible(false);
    // Every close is the user's (command, shortcut, double Esc): stop opening by itself.
    session.autoArmed = false;
    // A message about the old source (or anything else) would be stale when the pane reopens.
    if (session.view) {
      session.view.message = undefined;
      // A revealed sensitive file is shown for this opening only; reopening hides it again.
      session.view.hideRevealed();
    }
    resetToSessionSource(session);
  }

  async function showInline(session: Session, reason: string | undefined): Promise<void> {
    const store = ensureStore(session);
    await store.refreshNow();
    if (!session.alive) return;
    // Native-diff seam (native-diff.ts): an ACP client that renders diffs gets them instead.
    const native = { env, clock: deps.clock, alive: () => session.alive };
    if (await presentNativeDiff(session.ctx, store.getState(), native)) return;
    if (!session.alive) return;
    if (editorRendersMarkdown(env)) {
      // Any other source in the editor: the same list as Markdown, sanitised once there.
      const list = inlineMarkdown(store.getState());
      session.ctx.ui.notify(reason ? `${markdownText(reason)}\n\n${list}` : list, "info");
      return;
    }
    const list = inlineList(store.getState());
    session.ctx.ui.notify(reason ? `${sanitizeTerminalText(reason)}\n${list}` : list, "info");
  }

  /** Open on the user's request; without `keepSource` the pane shows the session source. */
  async function userOpen(
    session: Session,
    options: { keepSource: boolean } = { keepSource: false },
  ): Promise<boolean> {
    session.userActed = true;
    session.autoArmed = true;
    if (!options.keepSource && !session.host) resetToSessionSource(session);
    const result = openPane(session, { announce: true, overlay: true });
    if (result.opened) {
      persist(session);
      return true;
    }
    await showInline(session, session.ctx.mode === "tui" ? result.reason : undefined);
    return false;
  }

  function userClose(session: Session): void {
    session.userActed = true;
    closePane(session);
    persist(session);
  }

  async function toggle(session: Session): Promise<void> {
    if (session.host) userClose(session);
    else await userOpen(session);
  }

  async function focusToggle(session: Session): Promise<void> {
    if (session.host?.isFocused()) {
      session.host.unfocus();
      return;
    }
    if (session.host || (await userOpen(session))) session.host?.focus();
  }

  function requestRefresh(reason: RefreshReason): void {
    const session = current;
    if (!session?.alive || !session.host) return;
    followTurn(session);
    session.store?.requestRefresh(reason);
    if (reason === "subagent") {
      void reloadRecorded(session);
      void reloadComments(session);
    }
  }

  /* --------------------------------------------------- automatic opening */

  function autoEligible(session: Session): boolean {
    return (
      session.alive &&
      current === session &&
      session.ctx.mode === "tui" &&
      session.autoOpen &&
      session.autoArmed &&
      !session.autoFailed &&
      session.host === undefined
    );
  }

  function autoHint(session: Session, reason: string): void {
    if (session.autoHinted) return;
    session.autoHinted = true;
    session.ctx.ui.notify(
      `The diff pane did not open by itself: ${reason}. /diff lists this session's changes.`,
      "info",
    );
  }

  /**
   * After a tool call that may have changed files: read the session source
   * and dock the pane when it lists a change. Coalesces triggers that arrive
   * while a read runs into one more read.
   */
  async function maybeAutoOpen(session: Session): Promise<void> {
    if (!autoEligible(session)) return;
    if (session.autoCheck !== "idle") {
      session.autoCheck = "again";
      return;
    }
    // Docking is impossible and the user was told once: reading git would change nothing.
    if (session.autoHinted && dockBlocker(session) !== undefined) return;
    session.autoCheck = "running";
    try {
      for (;;) {
        resetToSessionSource(session);
        const store = ensureStore(session);
        await store.refreshNow();
        if (!autoEligible(session)) return;
        const state = store.getState();
        const changed =
          state.kind === "ready" &&
          state.snapshot.source.kind === "session" &&
          state.snapshot.files.length + state.snapshot.omittedFiles > 0;
        if (changed) {
          const later = dockBlocker(session);
          const result: OpenResult =
            later === undefined
              ? openPane(session, { announce: false, overlay: false })
              : { opened: false, reason: later };
          if (!result.opened) autoHint(session, result.reason);
          return;
        }
        if (!rearmCheck(session)) return;
      }
    } finally {
      session.autoCheck = "idle";
    }
  }

  /** Whether a trigger arrived during the last read; if so, the check reads once more. */
  function rearmCheck(session: Session): boolean {
    if (session.autoCheck !== "again") return false;
    session.autoCheck = "running";
    return true;
  }

  /**
   * Start the automatic opening check without anyone awaiting it. Any failure
   * (a git read, the TUI probe, docking into Pi's layout, a stale context)
   * turns automatic opening off for the rest of this session and is told once;
   * `/diff` still opens the pane by hand.
   */
  function autoOpenInBackground(): void {
    const session = current;
    if (!session) return;
    void maybeAutoOpen(session).catch((error: RuntimeValue) => autoOpenFailed(session, error));
  }

  /**
   * A host contained a throw from the view (guard.ts). Never throws: it runs
   * in a microtask, where nothing above would catch it.
   *
   * Render: the pane closes (a failure that comes from the data repeats on
   * every frame, and a pane that cannot draw only takes room), focus returns
   * to the editor, the user is told once, and the pane does not open by
   * itself again in this session; `/diff` by hand tries again.
   * Input: focus returns to the editor and the failure is shown on the
   * pane's message line; the pane stays, and the toggle shortcut and
   * `/diff close` (handled here, not by the view) still close it.
   */
  function paneFailed(
    session: Session,
    host: PaneHost,
    kind: "render" | "input",
    error: RuntimeValue,
  ): void {
    if (!session.alive || isStaleContextError(error)) return;
    if (session.host !== host) return;
    try {
      if (kind === "input") {
        host.unfocus();
        reportFailure(session, `A key in the diff pane failed: ${errorText(error)}`, error);
        return;
      }
      session.autoFailed = true;
      closePane(session);
    } catch (failure) {
      // Closing touched a stale or broken host; the notice below still says what happened.
      if (isStaleContextError(failure)) return;
    }
    if (kind !== "render") return;
    try {
      session.ctx.ui.notify(
        sanitizeTerminalText(
          `The diff pane could not be drawn (${errorText(error)}) and was closed; it will not open by itself again in this session. /diff opens it.`,
        ),
        "warning",
      );
    } catch {
      // A stale context: the session ended, nothing to tell.
    }
  }

  /** Never throws: it is the last handler of the background check. */
  function autoOpenFailed(session: Session, error: RuntimeValue): void {
    if (session.autoFailed) return;
    session.autoFailed = true;
    if (!session.alive || current !== session || isStaleContextError(error)) return;
    try {
      session.ctx.ui.notify(
        sanitizeTerminalText(
          `The diff pane could not open by itself (${errorText(error)}) and will not try again in this session; /diff opens it.`,
        ),
        "warning",
      );
    } catch {
      // A notice is the only place to say it; when that fails too, automatic opening just stays off.
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const previous = current;
    if (previous?.alive) shutdown(previous);
    const session = sessionFor(ctx);
    if (ctx.mode !== "tui") return;
    const saved = await prefs().load();
    if (!session.alive) return;
    if (!session.autoChosen) session.autoOpen = saved.autoOpen;
    if (session.userActed) return;
    session.width = saved.width;
    if (saved.open) openPane(session, { announce: false, overlay: true });
  });

  function shutdown(session: Session): void {
    session.alive = false;
    if (current === session) current = undefined;
    session.escapeArmedUntil = undefined;
    session.removeInputListener?.();
    session.removeInputListener = undefined;
    session.host?.uninstall();
    session.host = undefined;
    session.unsubscribeStore?.();
    session.unsubscribeStore = undefined;
    session.store?.dispose();
    session.store = undefined;
    session.view?.dispose();
    session.view = undefined;
    session.tui = undefined;
    session.recordedGeneration += 1;
  }

  // Synchronous: hosts are removed before Pi tears the session down, and the
  // pending preference write (if any) starts now instead of on a timer.
  pi.on("session_shutdown", () => {
    if (current) shutdown(current);
    if (prefsStore) void prefsStore.flush();
  });

  pi.on("tool_execution_end", (event) => {
    requestRefresh("tool");
    if (!READ_ONLY_TOOLS.has(event.toolName)) autoOpenInBackground();
  });
  pi.on("agent_settled", () => requestRefresh("settled"));
  // `!cmd` shell commands emit nothing after they run; the next turn catches them.
  pi.on("turn_start", () => requestRefresh("turn"));
  for (const channel of SUBAGENT_DONE_EVENTS) {
    pi.events.on(channel, () => {
      requestRefresh("subagent");
      autoOpenInBackground();
    });
  }

  pi.registerCommand("diff", {
    description: "Show this session's changes in a side pane",
    getArgumentCompletions: (prefix) => {
      const typed = prefix.trim();
      // An exact match offers nothing to complete; listing it makes Enter accept it instead of running.
      const items = DIFF_SUBCOMMANDS.filter(
        (item) => item.value.startsWith(typed) && item.value !== typed,
      ).map((item) => ({ value: item.value, label: item.value, description: item.description }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const session = sessionFor(ctx);
      const command = parseDiffCommand(args);
      if (ctx.mode !== "tui") {
        // No terminal UI (print, RPC, ACP, subagent sessions): answer inline, never mount.
        // In the editor the usage text is Markdown-escaped: `<columns>` would be read as HTML.
        const editor = editorRendersMarkdown(env);
        if (command.kind === "invalid") {
          ctx.ui.notify(editor ? markdownText(command.message) : command.message, "warning");
        } else if (command.kind === "review") {
          startReview(session);
        } else if (command.kind === "notes" || command.kind === "source-turn") {
          ctx.ui.notify("Notes and turn sources need the diff pane in the terminal UI.", "info");
        } else if (command.kind === "auto") {
          ctx.ui.notify("The diff pane opens by itself only in the terminal UI.", "info");
        } else if (command.kind === "source") {
          applySource(session, command.source);
          await showInline(session, undefined);
        } else if (command.kind === "source-branch") {
          const choice = await branchSource(session, command.base);
          // git's own text from a failed default-base lookup reaches a plain terminal here.
          if (choice.kind === "none")
            ctx.ui.notify(
              editor ? noBaseMarkdown(choice) : sanitizeTerminalText(choice.message),
              "warning",
            );
          if (choice.kind !== "found") return;
          applySource(session, choice.source);
          await showInline(session, undefined);
        } else {
          resetToSessionSource(session);
          await showInline(session, undefined);
        }
        return;
      }
      switch (command.kind) {
        case "invalid":
          // In the open pane when there is one: an overlay can cover a notification.
          say(session, command.message, "warning");
          return;
        case "toggle":
          await toggle(session);
          return;
        case "open":
          await userOpen(session);
          return;
        case "close":
          userClose(session);
          return;
        case "focus":
          if (!session.host?.isFocused()) await focusToggle(session);
          return;
        case "width":
          setWidth(session, command.width);
          if (!session.host) ctx.ui.notify(`Diff pane width set to ${session.width}.`, "info");
          return;
        case "refresh":
          if (session.host) manualRefresh(session);
          else await showInline(session, undefined);
          return;
        case "source":
          await showSource(session, command.source);
          return;
        case "source-turn":
          await sourceTurn(session, command.turn);
          return;
        case "source-branch":
          await sourceBranch(session, command.base);
          return;
        case "auto":
          if (command.enabled !== undefined) {
            session.autoOpen = command.enabled;
            session.autoChosen = true;
            persist(session);
          }
          say(
            session,
            session.autoOpen
              ? "The diff pane opens by itself when the agent changes code (/diff auto off stops it)."
              : "The diff pane does not open by itself (/diff auto on turns it back on).",
          );
          return;
        case "notes":
          if (command.action === "send") await sendNotes(session);
          else await clearNotes(session);
          return;
        case "review":
          startReview(session);
          return;
      }
    },
  });

  pi.registerShortcut(TOGGLE_SHORTCUT, {
    description: "Toggle the diff pane",
    handler: async (ctx) => {
      if (ctx.mode === "tui") await toggle(sessionFor(ctx));
    },
  });
  pi.registerShortcut(FOCUS_SHORTCUT, {
    description: "Move focus into or out of the diff pane",
    handler: async (ctx) => {
      if (ctx.mode === "tui") await focusToggle(sessionFor(ctx));
    },
  });
  pi.registerShortcut(ENTER_PANE_SHORTCUT, {
    description: "Move focus into the open diff pane",
    handler: async (ctx) => {
      if (ctx.mode !== "tui") return;
      const host = sessionFor(ctx).host;
      if (host && !host.isFocused()) host.focus();
    },
  });

  return { session: () => current };
}
