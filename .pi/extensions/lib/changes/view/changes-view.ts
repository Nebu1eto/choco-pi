/**
 * Host-independent changes view: header, file list, expanded hunks, notes and
 * recorded review findings, and the keys the pane handles while it has focus.
 *
 * Rendered file blocks are cached by (width, snapshot revision, path,
 * expanded, decorations), so a refresh that produces the same revision renders
 * nothing new.
 */
import { Input, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type {
  DiffSnapshot,
  DiffSource,
  DiffStore,
  DiffStoreState,
  FileBody,
  FileSummary,
} from "../git/model.ts";
import {
  createIntralineBudget,
  MIN_SPLIT_WIDTH,
  renderDiffFile,
  withRenderBudget,
  type IntralineBudget,
} from "../render/diff-render.ts";
import {
  BODY_INDENT,
  bodyBlock,
  bodyNote,
  hunkRowOfLine,
  renderHunkRows,
  type HunkRows,
  splitRowCount,
  type BodyAnnotation,
  type BodyBlockInput,
} from "./body-block.ts";
import { createHighlight, DEFAULT_HIGHLIGHT } from "../render/highlight.ts";
import { sanitizeTerminalText as safe, terminalSafeFile } from "../terminal-text.ts";
import type { DiffFile, DiffHunk } from "../types.ts";
import {
  EMPTY_FINDINGS,
  reviewLine,
  type FindingsSummary,
  type RecordedFinding,
} from "../findings.ts";
import { actionFor, PANE_KEYS, type ChangesKeyTable } from "./keys.ts";
import {
  KEYBOARD_RESIZE_STEP,
  type PaneScroller,
  type PaneSurface,
  type PointerGesture,
} from "./surface.ts";
import {
  bodyNotice,
  fileRow,
  plural,
  type PaneColor,
  type PaneStyler,
  type RowBadge,
} from "./rows.ts";
import { baselineText, emptyMessage, sourceLabel } from "./source-text.ts";
import { noteStatus, type DiffNote, type NotesBook } from "../notes.ts";
import { hunkRangeText } from "../references.ts";
import { isSensitiveFile } from "../sensitive.ts";
import type { RuntimeValue } from "../../runtime-values.ts";
import {
  currentCommentPosition,
  cursorRows,
  extendSelection,
  moveLine,
  selectedLineIndexes,
  type CommentPosition,
  type CursorFile,
  type CursorRow,
  type LineCursor,
  type LineTarget,
} from "./line-cursor.ts";

/** What the pane can be asked about. */
export type AskTarget = {
  file: FileSummary;
  hunk?: DiffHunk;
  /** The lines of `hunk` the cursor selects, as indexes into its lines; absent for the whole hunk. */
  lines?: { first: number; last: number };
};

/** What the view asks of its owner. Optional members are features the owner may not provide. */
export type PaneActions = {
  /** Esc, q, or the focus shortcut: give keyboard focus back to the editor. */
  unfocus(): void;
  /** The toggle shortcut pressed while the pane has focus. */
  close(): void;
  resizeBy(delta: number): void;
  refresh(): void;
  requestRender(): void;
  isToggleKey(data: string): boolean;
  isFocusKey(data: string): boolean;
  ask?(target: AskTarget): void;
  /** Copy what the cursor is on to the clipboard. */
  copy?(target: AskTarget): void;
  addNote?(file: FileSummary, hunk: DiffHunk, text: string): void;
  /** Ask about every note at once; the ask key runs this while there are notes. */
  sendNotes?(): void;
  cycleSource?(): void;
  /** Show the turn before (-1) or after (1) the one shown, alone. */
  stepTurn?(delta: -1 | 1): void;
  startReview?(): void;
};

/** How a host lays out hunk rows: split or unified, and which hunks fold to one row. */
export type BodyLayout = {
  mode: "unified" | "split";
  fold(hunkId: string): boolean;
  foldReason(hunkId: string): string | undefined;
};

export type FileBodyRenderer = (
  file: DiffFile,
  width: number,
  styler: PaneStyler,
  layout?: BodyLayout,
) => string[];

/** Hunks from the review renderer, without its own file header line; unified unless `layout` says otherwise. */
export const renderUnifiedBody: FileBodyRenderer = (file, width, styler, layout) =>
  renderDiffFile(
    file,
    {
      mode: layout?.mode ?? "unified",
      width,
      highlight: createHighlight({
        config: DEFAULT_HIGHLIGHT,
        filePath: file.path,
        diffLines: file.hunks.reduce((total, hunk) => total + hunk.lines.length, 0),
      }),
      fold: (hunkId) => layout?.fold(hunkId) ?? false,
      foldReason: (hunkId) => layout?.foldReason(hunkId),
    },
    styler,
  ).slice(1);

type LoadedBody = { revision: number; body: FileBody };

/**
 * Where the view reads bodies. `peekFile` returns a body the store already
 * holds for the current revision, so it can be drawn without a loading row.
 */
export type ViewStore = Pick<DiffStore, "loadFile"> & {
  peekFile?(path: string): LoadedBody | undefined;
};

/** A loaded file's hunks as rendered at one width and layout (`key`), from one body (`raw`). */
type RenderedHunks = { raw: DiffFile; key: string; file: DiffFile; rows: HunkRows[] };

/** Blocks kept however few files are listed; see `fileBlock`. */
const MIN_CACHED_BLOCKS = 32;
/** Past this many, the rows measured so far are forgotten and measured again as they are drawn. */
const MAX_FITTED_ROWS = 50_000;

type Block = {
  lines: string[];
  /** Offset of the line to keep visible, when not the file row. */ anchor?: number;
  /** What each row shows, for the mouse: a file row, a hunk header or a line. */
  stops?: Array<CursorRow | undefined>;
};

type FindingsIndex = {
  byPath: Map<string, RecordedFinding[]>;
  unlisted: RecordedFinding[];
  /** Findings on listed files in display order, for f/F. */
  order: Array<{ path: string; key: string }>;
};

type PaneMessage = { text: string; color: PaneColor };

/** A short line under a file row, such as a risk reason or a read-limit notice. */
export type RowDetail = { text: string; color: PaneColor };

export type ChangesViewOptions = {
  store: ViewStore;
  styler: PaneStyler;
  actions: PaneActions;
  renderFileBody?: FileBodyRenderer;
  /** One line of key help shown under the header while the view has focus. */
  keyHint: string;
  /** The ? key list, one entry per line. */
  helpLines: readonly string[];
  /**
   * Messages stay on the message line until another message replaces them
   * (the review, a full-screen view with no other place to show them).
   * Otherwise the next key the view acts on clears them (the pane).
   */
  keepMessages?: boolean;
  /** Key bindings; defaults to the pane's (`PANE_KEYS`). */
  keys?: ChangesKeyTable;
  /** Order of the listed files (review orders by risk); defaults to the snapshot's. */
  fileOrder?: (files: readonly FileSummary[]) => readonly FileSummary[];
  /**
   * Extra badges after the view's own on a file row, such as a risk score.
   * Must be a pure function of the path for a given state, as rows are cached.
   */
  rowBadges?: (path: string) => readonly RowBadge[];
  /** Header title; defaults to "Diff". */
  title?: string;
  /**
   * "line" moves a cursor through file rows, folded hunks and displayed lines,
   * with Shift range selection (the review and the pane). Defaults to "hunk"
   * (files, then hunks with n/N).
   */
  cursor?: "hunk" | "line";
  /**
   * Line cursor: an unfolded hunk's header is a stop where the whole hunk is
   * selected, and n/N land on it (the pane). Otherwise a hunk is entered on
   * its first line.
   */
  hunkStops?: boolean;
  /**
   * Line cursor: a selection may cover removed and added lines together (the
   * pane, which quotes the lines). Otherwise it stays on lines one side
   * numbers, as a review comment needs.
   */
  freeSelection?: boolean;
  /**
   * Line cursor: false makes Enter on a hunk or line collapse its file (the
   * pane). Otherwise it folds the hunk.
   */
  enterFolds?: boolean;
  /** Text in a folded hunk's placeholder (line cursor); the view's fold set says which are folded. */
  foldReason?: (hunkId: string) => string | undefined;
  /** Hunks marked reviewed; an unfolded one shows "✓ reviewed" on its header. */
  reviewedHunks?: () => ReadonlySet<string>;
  /** Body layout (line cursor); split falls back to unified below the renderer's minimum width. */
  mode?: () => "unified" | "split";
  /** Changed lines matching a query, for `setSearch` and `moveSearchMatch`. */
  search?: (query: string) => readonly LineTarget[];
  /** A hunk as displayed, with any context revealed around it (same id). */
  expandContext?: (hunk: DiffHunk) => DiffHunk;
  /**
   * Rows anchored in a file's displayed hunks, such as review comments. Rows
   * for a folded hunk are not drawn. Host state: call `invalidate` when it changes.
   */
  annotations?: (path: string, hunks: readonly DiffHunk[], width: number) => BodyAnnotation[];
  /** Rows after a file's hunks, such as comments whose hunk is gone. Host state, as above. */
  fileTrailer?: (path: string, hunks: readonly DiffHunk[], width: number) => string[];
  /** Lines under a file row. Host state, as above. */
  rowDetails?: (path: string, expanded: boolean) => readonly RowDetail[];
  /** Rows after the list, such as comments on files no longer in it. */
  trailer?: (width: number) => string[];
};

/** Shown in place of a hidden sensitive file's body. */
export const HIDDEN_CONTENTS =
  "Sensitive file: contents hidden. Press v to show them until this view closes.";

export function findingKey(finding: Pick<RecordedFinding, "workTask" | "id">): string {
  return `${finding.workTask}/${finding.id}`;
}

function findingRange(finding: RecordedFinding): string {
  const start = finding.startLine;
  if (start === undefined) return "";
  const end = finding.endLine;
  return end !== undefined && end !== start ? `L${start}-${end}` : `L${start}`;
}

function severityColor(finding: RecordedFinding): PaneColor {
  if (finding.class === "candidate") return "muted";
  if (finding.severity === "critical" || finding.severity === "high") return "error";
  if (finding.severity === "medium") return "warning";
  return "muted";
}

function hunkContains(hunk: DiffHunk, line: number): boolean {
  return hunk.newLines > 0 && line >= hunk.newStart && line <= hunk.newStart + hunk.newLines - 1;
}

export { terminalSafeFile };

/** A finding path made repository-relative with forward slashes. */
/**
 * Index of the last line at or before new-side line `target`, after which a
 * finding on that line is shown; undefined when it belongs after the header.
 */
function insertionLine(hunk: DiffHunk, target: number): number | undefined {
  let index: number | undefined;
  hunk.lines.forEach((line, lineIndex) => {
    if (line.newLine !== undefined && line.newLine <= target) index = lineIndex;
  });
  return index;
}

export function normalizeFindingPath(path: string, repoRoot: string): string {
  let result = path.replaceAll("\\", "/");
  const root = repoRoot.replaceAll("\\", "/").replace(/\/+$/u, "");
  if (root.length > 0 && result.startsWith(`${root}/`)) result = result.slice(root.length + 1);
  while (result.startsWith("./")) result = result.slice(2);
  return result;
}

export class ChangesView implements PaneSurface {
  state: DiffStoreState = { kind: "idle" };
  source: DiffSource = { kind: "session" };
  selectedPath: string | undefined;
  selectedIndex = 0;
  /** The selected hunk; absent while a whole file is selected. */
  selectedHunk: { path: string; hunkId: string } | undefined;
  readonly expanded = new Set<string>();
  readonly bodies = new Map<string, LoadedBody>();
  /** Sensitive files whose contents the user agreed to show in this session. */
  readonly revealed = new Set<string>();
  /** Number of file blocks built since creation; a cache hit does not count. */
  blockRenders = 0;
  /** Work of the last body render: one budget for every file it drew (see withRenderBudget). */
  lastRenderBudget: IntralineBudget | undefined;
  styler: PaneStyler;
  disposed = false;
  helpOpen = false;
  message: PaneMessage | undefined;
  notes: NotesBook | undefined;
  recorded: FindingsSummary = EMPTY_FINDINGS;
  /** Epoch ms of each listed file's last change; null when it could not be read. */
  changeTimes: ReadonlyMap<string, number | null> = new Map();
  focusedFinding: string | undefined;
  noteInput: { input: Input; path: string; hunkId: string; range: string } | undefined;

  readonly store: ViewStore;
  readonly actions: PaneActions;
  readonly renderFileBody: FileBodyRenderer;
  private readonly cache = new Map<string, Block>();
  /**
   * Each loaded file's hunks as rendered, which no cursor position changes:
   * a cursor move lays the file's block out again from these instead of
   * highlighting and diffing the whole file once more.
   */
  private readonly renderedHunks = new Map<string, RenderedHunks>();
  /** Rows already cut to `fittedWidth`; nearly every row of a frame was in the frame before. */
  private readonly fittedRows = new Map<string, string>();
  private fittedWidth = -1;
  private readonly requested = new Map<string, number>();
  private scroller: PaneScroller | undefined;
  private lastWidth = 0;
  private selectedLine = 0;
  private cachedRevision: number | undefined;
  private recordedVersion = 0;
  private findingsCache: { key: string; index: FindingsIndex } | undefined;
  private pendingHunk: { path: string; direction: 1 | -1 } | undefined;
  /** A search match whose body was loading when the cursor was sent there. */
  private pendingLine: LineTarget | undefined;
  /** First body row of each file block as last drawn, for `rowTarget`. */
  private blockRows: Array<{ start: number; block: Block }> = [];

  /** Line cursor: index into the selected hunk's displayed lines; absent on a file row or a fold. */
  cursorLine: number | undefined;
  /** Fixed end of a Shift selection in the selected hunk. */
  anchorLine: number | undefined;
  /** Hunks drawn as one placeholder row (line cursor). */
  readonly foldedHunks = new Set<string>();
  /** The last search: its query, matches and the current match (-1 when none). */
  searchState: { query: string; matches: readonly LineTarget[]; index: number } | undefined;

  readonly keyHint: string;
  readonly helpLines: readonly string[];

  readonly keys: ChangesKeyTable;
  readonly cursorMode: "hunk" | "line";
  readonly title: string;
  private readonly fileOrder: ChangesViewOptions["fileOrder"];
  private readonly rowBadges: ChangesViewOptions["rowBadges"];
  private readonly options: ChangesViewOptions;
  private ordered: { state: DiffStoreState; files: readonly FileSummary[] } | undefined;

  constructor(dependencies: ChangesViewOptions) {
    this.options = dependencies;
    this.keyHint = dependencies.keyHint;
    this.helpLines = dependencies.helpLines;
    this.keys = dependencies.keys ?? PANE_KEYS;
    this.cursorMode = dependencies.cursor ?? "hunk";
    this.title = dependencies.title ?? "Diff";
    this.fileOrder = dependencies.fileOrder;
    this.rowBadges = dependencies.rowBadges;
    this.store = dependencies.store;
    this.styler = dependencies.styler;
    this.actions = dependencies.actions;
    this.renderFileBody = dependencies.renderFileBody ?? renderUnifiedBody;
  }

  attachScroller(scroller: PaneScroller): void {
    this.scroller = scroller;
  }

  /** Body row of the cursor (or the selected file) as of the last `renderBody`. */
  selectionRow(): number {
    return this.selectedLine;
  }

  files(): readonly FileSummary[] {
    if (this.state.kind !== "ready") return [];
    if (!this.fileOrder) return this.state.snapshot.files;
    if (this.ordered?.state !== this.state) {
      this.ordered = { state: this.state, files: this.fileOrder(this.state.snapshot.files) };
    }
    return this.ordered.files;
  }

  selectedFile(): FileSummary | undefined {
    return this.files()[this.selectedIndex];
  }

  /** Apply a store state, keeping the selected path and expanded files that still exist. */
  setState(state: DiffStoreState): void {
    this.state = state;
    if (state.kind !== "ready") return;
    const snapshot = state.snapshot;
    this.source = snapshot.source;
    if (this.cachedRevision !== snapshot.revision) {
      this.invalidate();
      this.cachedRevision = snapshot.revision;
    }
    const paths = new Set(snapshot.files.map((file) => file.path));
    for (const path of this.expanded) if (!paths.has(path)) this.expanded.delete(path);
    // A body belongs to one snapshot: an older one is neither drawn nor offered to hunk actions.
    for (const [path, loaded] of this.bodies) {
      if (!paths.has(path) || loaded.revision !== snapshot.revision) this.bodies.delete(path);
    }
    const files = this.files();
    const index =
      this.selectedPath === undefined
        ? -1
        : files.findIndex((file) => file.path === this.selectedPath);
    if (index >= 0) this.selectedIndex = index;
    else this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, files.length - 1));
    this.selectedPath = files[this.selectedIndex]?.path;
    if (this.selectedHunk && this.selectedHunk.path !== this.selectedPath) {
      this.selectedHunk = undefined;
    }
    if (!this.selectedHunk) this.clearLine();
    for (const path of this.expanded) this.ensureBody(path);
  }

  /** Replace the recorded review summary and file change times. */
  setRecorded(recorded: FindingsSummary, changeTimes: ReadonlyMap<string, number | null>): void {
    this.recorded = recorded;
    this.changeTimes = changeTimes;
    this.recordedVersion += 1;
    this.findingsCache = undefined;
    const keys = new Set(recorded.findings.map(findingKey));
    if (this.focusedFinding !== undefined && !keys.has(this.focusedFinding)) {
      this.focusedFinding = undefined;
    }
  }

  setMessage(text: string, color: PaneColor = "muted"): void {
    // Messages often embed a file name, so the whole text is made terminal-safe.
    this.message = { text: safe(text), color };
  }

  /** Release references; late body loads are dropped. */
  dispose(): void {
    this.disposed = true;
    this.invalidate();
    this.bodies.clear();
    this.requested.clear();
    this.noteInput = undefined;
  }

  invalidate(): void {
    this.cache.clear();
    this.renderedHunks.clear();
    this.fittedRows.clear();
  }

  /* ------------------------------------------------------------ header */

  renderHeader(width: number, focused: boolean): string[] {
    const styler = this.styler;
    const source = this.state.kind === "ready" ? this.state.snapshot.source : this.source;
    const branch =
      this.state.kind === "ready" && this.state.snapshot.branch
        ? styler.fg("dim", ` on ${safe(this.state.snapshot.branch)}`)
        : "";
    const lines = [
      `${styler.bold(this.title)} ${styler.fg("muted", sourceLabel(source))}${branch}`,
    ];
    // Lines that must be read in full wrap; the rest truncate.
    const wrapped = new Set<number>();
    const pushWrapped = (line: string) => {
      wrapped.add(lines.length);
      lines.push(line);
    };
    switch (this.state.kind) {
      case "idle":
        lines.push(styler.fg("dim", "Loading…"));
        break;
      case "not-a-repository":
        lines.push(styler.fg("warning", "Not a git repository"));
        break;
      case "error":
        pushWrapped(styler.fg("error", `Error: ${safe(this.state.message)}`));
        break;
      case "ready": {
        const snapshot = this.state.snapshot;
        const baseline = baselineText(snapshot);
        if (baseline !== undefined) lines.push(styler.fg("dim", baseline));
        const refreshing = this.state.refreshing ? styler.fg("dim", " · refreshing…") : "";
        const { files, additions, deletions } = snapshot.totals;
        const noteCount = this.notes?.notes.length ?? 0;
        const notes = noteCount > 0 ? styler.fg("accent", ` · ${plural(noteCount, "note")}`) : "";
        lines.push(
          `${plural(files, "file")} ${styler.fg("toolDiffAdded", `+${additions}`)} ${styler.fg("toolDiffRemoved", `-${deletions}`)}${notes}${refreshing}`,
        );
        break;
      }
    }
    const reviewText = reviewLine(this.recorded);
    const review = reviewText === undefined ? undefined : safe(reviewText);
    if (review !== undefined) {
      const troubled =
        this.recorded.malformed > 0 ||
        this.recorded.errors.length > 0 ||
        this.recorded.tasks.some((task) => task.review?.kind === "unrecorded");
      pushWrapped(styler.fg(troubled ? "warning" : "muted", review));
    }
    if (this.message) pushWrapped(styler.fg(this.message.color, this.message.text));
    if (this.noteInput) {
      const target = this.noteInput;
      lines.push(
        styler.fg(
          "accent",
          `Note on ${safe(target.path)} ${safe(target.range)} (⏎ save, esc cancel):`,
        ),
      );
      lines.push(...target.input.render(Math.max(1, width)));
    }
    if (this.helpOpen) for (const line of this.helpLines) pushWrapped(styler.fg("muted", line));
    else if (focused) lines.push(styler.fg("dim", this.keyHint));
    lines.push(styler.fg("borderMuted", "─".repeat(Math.max(0, width))));
    const columns = Math.max(1, width);
    return lines.flatMap((line, index) =>
      wrapped.has(index)
        ? wrapTextWithAnsi(line, columns).map((part) => truncateToWidth(part, width, "…"))
        : [truncateToWidth(line, width, "…")],
    );
  }

  /* -------------------------------------------------------------- body */

  renderBody(width: number, _focused: boolean): string[] {
    this.lastWidth = width;
    this.blockRows = [];
    if (this.state.kind !== "ready") return [];
    // Every row is cut to the width after the selection gutter and host rows are added.
    const columns = Math.max(0, width);
    // One frame: every file block built here shares one work budget; cached blocks spend none.
    const budget = createIntralineBudget();
    this.lastRenderBudget = budget;
    const snapshot = this.state.snapshot;
    const rows = withRenderBudget(budget, () => this.bodyRows(snapshot, width));
    // The rows are cut to the width one column short, behind the selection gutter.
    return columns >= 2 ? rows : rows.map((row) => truncateToWidth(row, columns, "…"));
  }

  /** A block's row cut to `width`; measured once for as long as the same text is drawn at that width. */
  private fit(row: string, width: number): string {
    if (width !== this.fittedWidth || this.fittedRows.size > MAX_FITTED_ROWS) {
      this.fittedRows.clear();
      this.fittedWidth = width;
    }
    let cut = this.fittedRows.get(row);
    if (cut === undefined) {
      cut = truncateToWidth(row, width, "…");
      this.fittedRows.set(row, cut);
    }
    return cut;
  }

  private bodyRows(snapshot: DiffSnapshot, width: number): string[] {
    const styler = this.styler;
    // Host rows are cut here; file blocks are cut as they are added below.
    const trailer = [...this.unlistedLines(width), ...(this.options.trailer?.(width) ?? [])].map(
      (line) => truncateToWidth(line, width, "…"),
    );
    if (snapshot.files.length === 0 && snapshot.omittedFiles === 0) {
      // The empty message can be a sentence explaining why nothing is listed; it wraps.
      const columns = Math.max(1, width);
      return [
        ...wrapTextWithAnsi(styler.fg("dim", emptyMessage(snapshot)), columns).map((line) =>
          truncateToWidth(line, width, "…"),
        ),
        ...trailer,
      ];
    }
    const lines: string[] = [];
    const blockWidth = Math.max(1, width - 1);
    this.files().forEach((file, index) => {
      const block = this.fileBlock(file, snapshot.revision, blockWidth);
      this.blockRows.push({ start: lines.length, block });
      const selected = index === this.selectedIndex;
      if (selected) this.selectedLine = lines.length + (block.anchor ?? 0);
      const row = this.fit(block.lines[0] ?? "", blockWidth);
      // The line cursor on a file row inverts the row, as it does a selected line.
      const onRow = selected && this.cursorMode === "line" && this.selectedHunk === undefined;
      lines.push((selected ? styler.fg("accent", "❯") : " ") + (onRow ? styler.inverse(row) : row));
      for (let at = 1; at < block.lines.length; at += 1) {
        lines.push(` ${this.fit(block.lines[at] ?? "", blockWidth)}`);
      }
    });
    if (snapshot.omittedFiles > 0) {
      lines.push(
        truncateToWidth(
          styler.fg("dim", `${plural(snapshot.omittedFiles, "more file")} not shown`),
          width,
          "…",
        ),
      );
    }
    lines.push(...trailer);
    return lines;
  }

  private findings(): FindingsIndex {
    const snapshot = this.state.kind === "ready" ? this.state.snapshot : undefined;
    const key = `${this.recordedVersion}\u0000${snapshot?.revision ?? -1}`;
    if (this.findingsCache?.key === key) return this.findingsCache.index;
    const listed = new Map(this.files().map((file, index) => [file.path, index]));
    const byPath = new Map<string, RecordedFinding[]>();
    const unlisted: RecordedFinding[] = [];
    for (const finding of this.recorded.findings) {
      const path = normalizeFindingPath(finding.path, snapshot?.repoRoot ?? "");
      if (!listed.has(path)) {
        unlisted.push(finding);
        continue;
      }
      byPath.set(path, [...(byPath.get(path) ?? []), finding]);
    }
    const lineOf = (finding: RecordedFinding) => finding.startLine ?? 0;
    for (const list of byPath.values()) list.sort((a, b) => lineOf(a) - lineOf(b));
    const order = [...byPath.keys()]
      .sort((a, b) => (listed.get(a) ?? 0) - (listed.get(b) ?? 0))
      .flatMap((path) =>
        (byPath.get(path) ?? []).map((finding) => ({ path, key: findingKey(finding) })),
      );
    const index = { byPath, unlisted, order };
    this.findingsCache = { key, index };
    return index;
  }

  /** True when the record predates the file's last change, so its lines may have moved. */
  mayBeOutdated(finding: RecordedFinding, path: string): boolean {
    if (Number.isNaN(finding.completedAt)) return true;
    const changed = this.changeTimes.get(path);
    if (changed === undefined) return false;
    if (changed === null) return true;
    return finding.completedAt < changed;
  }

  private findingText(finding: RecordedFinding, path: string): string {
    const range = findingRange(finding);
    const outcome = finding.outcome ? ` [${finding.outcome}]` : "";
    const outdated = this.mayBeOutdated(finding, path) ? " (may be outdated)" : "";
    return safe(
      `⚑ ${finding.severity} ${finding.class} ${finding.id}${range ? ` ${range}` : ""}: ${finding.invariant}${outcome}${outdated}`,
    );
  }

  private findingLine(finding: RecordedFinding, path: string, width: number): string {
    const focused = this.focusedFinding === findingKey(finding);
    const text = this.findingText(finding, path);
    const marker = focused ? this.styler.fg("accent", "▶ ") : "  ";
    return truncateToWidth(
      `${BODY_INDENT}${marker}${this.styler.fg(severityColor(finding), text)}`,
      width,
      "…",
    );
  }

  private noteLine(note: DiffNote, outdated: boolean, width: number): string {
    const text = safe(outdated ? `✎ (outdated, was ${note.range}) ${note.text}` : `✎ ${note.text}`);
    return truncateToWidth(
      `${BODY_INDENT}  ${this.styler.fg(outdated ? "dim" : "accent", text)}`,
      width,
      "…",
    );
  }

  /** Findings and notes on files that are not in the current list. */
  private unlistedLines(width: number): string[] {
    const listed = new Set(this.files().map((file) => file.path));
    const findings = this.findings().unlisted;
    const notes = (this.notes?.notes ?? []).filter((note) => !listed.has(note.path));
    if (findings.length === 0 && notes.length === 0) return [];
    const styler = this.styler;
    const lines = ["", styler.fg("dim", "Not in this diff:")];
    for (const finding of findings) {
      const range = findingRange(finding);
      const outcome = finding.outcome ? ` [${finding.outcome}]` : "";
      const text = safe(
        `⚑ ${finding.severity} ${finding.class} ${finding.id} ${finding.path}${range ? ` ${range}` : ""}: ${finding.invariant}${outcome}`,
      );
      lines.push(`  ${styler.fg(severityColor(finding), text)}`);
    }
    for (const note of notes) {
      lines.push(
        `  ${styler.fg("dim", safe(`✎ ${note.path} (outdated, was ${note.range}) ${note.text}`))}`,
      );
    }
    return lines.map((line) => truncateToWidth(line, width, "…"));
  }

  private badges(path: string): RowBadge[] {
    const badges: RowBadge[] = [];
    const findings = this.findings().byPath.get(path);
    if (findings && findings.length > 0) {
      const serious = findings.some((finding) => finding.class === "finding");
      badges.push({ text: `⚑${findings.length}`, color: serious ? "warning" : "muted" });
    }
    const notes = this.notes?.forPath(path).length ?? 0;
    if (notes > 0) badges.push({ text: `✎${notes}`, color: "accent" });
    if (this.rowBadges) badges.push(...this.rowBadges(path));
    return badges;
  }

  private decorationKey(path: string): string {
    const findings = this.findings().byPath.get(path);
    const focused =
      this.focusedFinding !== undefined &&
      findings?.some((f) => findingKey(f) === this.focusedFinding)
        ? this.focusedFinding
        : "";
    return [
      this.notes?.version ?? 0,
      this.recordedVersion,
      this.selectedHunk?.path === path ? this.selectedHunk.hunkId : "",
      focused,
      this.revealed.has(path) ? 1 : 0,
      // Host badges can change without a new snapshot (a risk score is not one).
      this.rowBadges ? JSON.stringify(this.rowBadges(path)) : "",
      this.selectedHunk?.path === path ? `${this.cursorLine ?? ""}/${this.anchorLine ?? ""}` : "",
    ].join(",");
  }

  private fileBlock(file: FileSummary, revision: number, width: number): Block {
    const expanded = this.expanded.has(file.path);
    const key = `${width}\u0000${revision}\u0000${file.path}\u0000${expanded ? 1 : 0}\u0000${this.decorationKey(file.path)}`;
    const cached = this.cache.get(key);
    if (cached) {
      // Most recently drawn last: the blocks dropped below are the ones no frame uses.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    this.blockRenders += 1;
    const stops: Array<CursorRow | undefined> = [{ path: file.path }];
    const block: Block = {
      lines: [fileRow(file, expanded, width, this.styler, this.badges(file.path))],
      stops,
    };
    for (const detail of this.options.rowDetails?.(file.path, expanded) ?? []) {
      block.lines.push(bodyNote(safe(detail.text), width, this.styler, detail.color));
      stops.push(undefined);
    }
    const bodyOffset = block.lines.length;
    if (expanded) {
      const body = this.bodyBlock(file, width);
      stops.push(...(body.stops ?? []));
      block.lines.push(...body.lines);
      if (body.anchor !== undefined) block.anchor = body.anchor + bodyOffset;
    }
    this.cache.set(key, block);
    // Every cursor position makes a block of its file; only the newest are drawn again.
    const kept = Math.max(MIN_CACHED_BLOCKS, 2 * this.files().length);
    for (const stale of this.cache.keys()) {
      if (this.cache.size <= kept) break;
      this.cache.delete(stale);
    }
    return block;
  }

  /** True when the pane may show (and load) this file's contents. */
  canShowContents(file: FileSummary): boolean {
    return !isSensitiveFile(file) || this.revealed.has(file.path);
  }

  /** Hide every revealed sensitive file again and forget its body (a host closing the view). */
  hideRevealed(): void {
    for (const path of this.revealed) this.bodies.delete(path);
    this.revealed.clear();
    this.invalidate();
  }

  private bodyBlock(file: FileSummary, width: number): Block {
    const styler = this.styler;
    const path = file.path;
    const note = (text: string, color: PaneColor = "dim") => bodyNote(text, width, styler, color);
    const findings = this.findings().byPath.get(path) ?? [];
    const notes = this.notes?.forPath(path) ?? [];
    if (!this.canShowContents(file)) {
      const lines = [note(HIDDEN_CONTENTS, "warning")];
      for (const finding of findings) lines.push(this.findingLine(finding, path, width));
      for (const entry of notes) lines.push(this.noteLine(entry, false, width));
      return { lines };
    }
    const loaded = this.bodies.get(path);
    if (!loaded) return { lines: [note("Loading…")] };
    const notice = bodyNotice(loaded.body);
    if (notice !== undefined || loaded.body.kind !== "text") {
      const lines = [note(notice ?? "")];
      for (const finding of findings) lines.push(this.findingLine(finding, path, width));
      for (const entry of notes) lines.push(this.noteLine(entry, true, width));
      lines.push(...(this.options.fileTrailer?.(path, [], width) ?? []));
      return { lines };
    }
    const line = this.cursorMode === "line";
    const raw = loaded.body.file;
    const innerWidth = Math.max(1, width - BODY_INDENT.length);
    const selectedHunkId = this.selectedHunk?.path === path ? this.selectedHunk.hunkId : undefined;
    const decorated =
      line || findings.length > 0 || notes.length > 0 || selectedHunkId !== undefined;
    const indent = (line: string) => truncateToWidth(`${BODY_INDENT}${line}`, width, "…");
    if (!decorated) {
      const expand = this.options.expandContext;
      const plain = terminalSafeFile(
        line && expand ? { ...raw, hunks: raw.hunks.map((hunk) => expand(hunk)) } : raw,
      );
      return { lines: this.renderFileBody(plain, innerWidth, styler).map(indent) };
    }
    const layout = line ? this.layout() : undefined;
    const mode = layout?.mode === "split" && innerWidth >= MIN_SPLIT_WIDTH ? "split" : "unified";
    const { file: diffFile, rows } = this.hunksRendered(path, raw, innerWidth, layout, mode);

    // Findings outside every hunk, then notes whose hunk is gone, then the hunks.
    const lines: string[] = [];
    let anchor: number | undefined;
    const hunkOf = (finding: RecordedFinding) => {
      const line = finding.startLine;
      return line === undefined
        ? undefined
        : diffFile.hunks.find((entry) => hunkContains(entry, line));
    };
    for (const finding of findings) {
      if (hunkOf(finding)) continue;
      if (this.focusedFinding === findingKey(finding)) anchor = lines.length;
      lines.push(this.findingLine(finding, path, width));
    }
    const hunkIds = new Set(diffFile.hunks.map((hunk) => hunk.id));
    for (const entry of notes) {
      if (!hunkIds.has(entry.hunkId)) lines.push(this.noteLine(entry, true, width));
    }
    const annotations: BodyAnnotation[] = [];
    const focused: number[] = [];
    for (const finding of findings) {
      const hunk = hunkOf(finding);
      if (!hunk) continue;
      if (this.focusedFinding === findingKey(finding)) focused.push(annotations.length);
      const after = insertionLine(hunk, finding.endLine ?? finding.startLine ?? hunk.newStart);
      annotations.push({
        hunkId: hunk.id,
        place: after === undefined ? "header" : { afterLine: after },
        lines: [this.findingLine(finding, path, width)],
      });
    }
    for (const entry of notes) {
      if (hunkIds.has(entry.hunkId)) {
        annotations.push({
          hunkId: entry.hunkId,
          place: "end",
          lines: [this.noteLine(entry, false, width)],
        });
      }
    }
    if (line) {
      for (const annotation of this.options.annotations?.(path, diffFile.hunks, width) ?? []) {
        if (!this.foldedHunks.has(annotation.hunkId)) annotations.push(annotation);
      }
    }
    const input: BodyBlockInput = {
      hunks: diffFile.hunks,
      rows,
      width,
      styler,
      annotations,
    };
    if (selectedHunkId !== undefined) input.markedHunkId = selectedHunkId;
    if (line) {
      input.mode = mode;
      const reviewed = this.options.reviewedHunks?.();
      input.headerSuffix = (hunkId) =>
        reviewed?.has(hunkId) && !this.foldedHunks.has(hunkId)
          ? styler.fg("toolDiffAdded", "✓ reviewed")
          : undefined;
      const at = diffFile.hunks.findIndex((hunk) => hunk.id === selectedHunkId);
      const hunk = diffFile.hunks[at];
      if (hunk)
        input.inverted = new Map([
          [hunk.id, this.invertedRows(hunk, rows[at]?.lines.length ?? 0, mode)],
        ]);
    }
    const block = bodyBlock(input);
    const offset = lines.length;
    lines.push(...block.lines);
    const stops = Array.from({ length: lines.length }, (): CursorRow | undefined => undefined);
    for (const hunk of diffFile.hunks) {
      const start = block.hunkStart.get(hunk.id);
      if (start === undefined) continue;
      stops[offset + start] = { path, hunkId: hunk.id };
      hunk.lines.forEach((_line, lineIndex) => {
        // A line without a row of its own (a folded hunk) reports the header's.
        const row = block.rowOfLine(hunk.id, lineIndex);
        if (row !== undefined && row !== start) {
          stops[offset + row] ??= { path, hunkId: hunk.id, lineIndex };
        }
      });
    }
    const focusedRow = focused.length > 0 ? block.annotationRows[focused[0]!] : undefined;
    if (focusedRow !== undefined) anchor = offset + focusedRow;
    else if (anchor === undefined && selectedHunkId !== undefined) {
      const onLine = line && this.cursorLine !== undefined && !this.foldedHunks.has(selectedHunkId);
      const start = onLine
        ? block.rowOfLine(selectedHunkId, this.cursorLine ?? 0)
        : block.hunkStart.get(selectedHunkId);
      if (start !== undefined) anchor = offset + start;
    }
    lines.push(...(this.options.fileTrailer?.(path, diffFile.hunks, width) ?? []));
    return anchor === undefined ? { lines, stops } : { lines, anchor, stops };
  }

  /**
   * A loaded file's hunks, made terminal-safe, and their rendered rows. They
   * are kept until the body, the width or the layout changes, or the view is
   * invalidated (a fold, revealed context, a new theme): the cursor, notes
   * and findings are drawn around these rows and never change them. Rows the
   * frame's budget cut short are not kept, so a later frame draws them in full.
   */
  private hunksRendered(
    path: string,
    raw: DiffFile,
    innerWidth: number,
    layout: BodyLayout | undefined,
    mode: "unified" | "split",
  ): RenderedHunks {
    const key = `${innerWidth}\u0000${layout ? mode : "plain"}`;
    const kept = this.renderedHunks.get(path);
    if (kept && kept.raw === raw && kept.key === key) return kept;
    const expand = layout ? this.options.expandContext : undefined;
    // Revealed context is repository text too: it is made terminal-safe with the hunk.
    const file = terminalSafeFile(
      expand ? { ...raw, hunks: raw.hunks.map((hunk) => expand(hunk)) } : raw,
    );
    const budget = this.lastRenderBudget;
    const cutShort = () => (budget?.fallbacks ?? 0) + (budget?.highlightSkipped ?? 0);
    const before = cutShort();
    const rows = renderHunkRows(
      file,
      (part) => this.renderFileBody(part, innerWidth, this.styler, layout),
      (hunk) =>
        layout?.fold(hunk.id)
          ? 1
          : 1 + (mode === "split" ? splitRowCount(hunk) : hunk.lines.length),
    );
    const rendered: RenderedHunks = { raw, key, file, rows };
    if (cutShort() === before) this.renderedHunks.set(path, rendered);
    else this.renderedHunks.delete(path);
    return rendered;
  }

  /** The host's layout for line-cursor bodies. */
  private layout(): BodyLayout {
    return {
      mode: this.options.mode?.() ?? "unified",
      fold: (hunkId) => this.foldedHunks.has(hunkId),
      foldReason: (hunkId) => this.options.foldReason?.(hunkId) ?? "folded",
    };
  }

  /** Rows of the cursor's hunk drawn inverted: the selected lines, or its header or placeholder. */
  private invertedRows(hunk: DiffHunk, rowCount: number, mode: "unified" | "split"): Set<number> {
    const rows = new Set<number>();
    const cursor = this.lineCursor();
    if (cursor && !this.foldedHunks.has(hunk.id)) {
      for (const index of selectedLineIndexes(hunk, cursor)) {
        rows.add(hunkRowOfLine(hunk, rowCount, index, mode) ?? 0);
      }
    }
    if (rows.size === 0) rows.add(0);
    return rows;
  }

  private dropCachedBlocks(path: string): void {
    this.renderedHunks.delete(path);
    for (const key of this.cache.keys()) {
      if (key.split("\u0000")[2] === path) this.cache.delete(key);
    }
  }

  /** Load hunks for an expanded file unless the current revision is loaded or requested. */
  private ensureBody(path: string): void {
    if (this.state.kind !== "ready") return;
    const file = this.state.snapshot.files.find((entry) => entry.path === path);
    if (file && !this.canShowContents(file)) return;
    const revision = this.state.snapshot.revision;
    if (this.bodies.get(path)?.revision === revision) return;
    if (this.requested.get(path) === revision) return;
    // A store that holds the body already (the review's) hands it over now: no loading row.
    const held = this.store.peekFile?.(path);
    if (held && held.revision === revision) {
      this.acceptBody(path, revision, held);
      return;
    }
    this.requested.set(path, revision);
    void this.store
      .loadFile(path)
      .then(
        (result) => this.acceptBody(path, revision, result),
        (error: RuntimeValue) =>
          this.acceptBody(path, revision, {
            revision,
            body: {
              kind: "unreadable",
              reason: error instanceof Error ? error.message : String(error),
            },
          }),
      )
      .catch((error: RuntimeValue) => this.bodyFailed(path, error));
  }

  /** Showing a loaded body threw (a render or host call): say so in the message line. Never throws. */
  private bodyFailed(path: string, error: RuntimeValue): void {
    if (this.disposed) return;
    const detail = error instanceof Error ? error.message : String(error);
    this.setMessage(`Cannot show ${path}: ${detail}`, "error");
    try {
      this.actions.requestRender();
    } catch {
      // The message is drawn with the next frame the host renders.
    }
  }

  private acceptBody(path: string, requestedAt: number, result: LoadedBody): void {
    if (this.disposed) return;
    if (this.requested.get(path) === requestedAt) this.requested.delete(path);
    if (!this.expanded.has(path)) return;
    // Only a body of the snapshot the view shows is accepted. An older one is late: `setState`
    // already requested the current snapshot's body (asking again here would loop on a store
    // that is behind the view). A newer one comes from a snapshot the view has not applied
    // yet; applying it requests that body.
    const revision = this.state.kind === "ready" ? this.state.snapshot.revision : undefined;
    if (result.revision !== revision) return;
    this.bodies.set(path, result);
    const hunks = result.body.kind === "text" ? result.body.file.hunks : [];
    if (
      this.selectedHunk?.path === path &&
      !hunks.some((hunk) => hunk.id === this.selectedHunk?.hunkId)
    ) {
      this.selectedHunk = undefined;
    }
    const pending = this.pendingHunk;
    if (pending?.path === path) {
      this.pendingHunk = undefined;
      const hunk = pending.direction > 0 ? hunks[0] : hunks.at(-1);
      if (hunk && this.selectedPath === path) this.enterHunk(path, hunk);
    }
    if (!this.selectedHunk) this.clearLine();
    else if (this.selectedHunk.path === path && this.cursorLine !== undefined) {
      const shown = this.currentDisplayHunk()?.hunk.lines.length ?? 0;
      this.cursorLine = Math.max(0, Math.min(this.cursorLine, shown - 1));
      if (this.anchorLine !== undefined && this.anchorLine >= shown) this.anchorLine = undefined;
    }
    const target = this.pendingLine;
    if (target?.path === path) {
      this.pendingLine = undefined;
      this.goTo(target);
    }
    this.dropCachedBlocks(path);
    this.keepSelectionVisible();
    this.actions.requestRender();
  }

  /** Hunks of a loaded, showable file; undefined while loading. */
  visibleHunks(file: FileSummary): readonly DiffHunk[] | undefined {
    if (!this.canShowContents(file)) return [];
    const loaded = this.bodies.get(file.path);
    if (!loaded) return undefined;
    return loaded.body.kind === "text" ? loaded.body.file.hunks : [];
  }

  /** The selected hunk, when one is selected and its body is loaded. */
  currentHunk(): { file: FileSummary; hunk: DiffHunk } | undefined {
    const file = this.selectedFile();
    const selection = this.selectedHunk;
    if (!file || !selection || selection.path !== file.path) return undefined;
    const hunk = this.visibleHunks(file)?.find((entry) => entry.id === selection.hunkId);
    return hunk ? { file, hunk } : undefined;
  }

  /** Hunks currently loaded for `path`, for note status. */
  loadedHunks(path: string): readonly DiffHunk[] | undefined {
    const loaded = this.bodies.get(path);
    if (!loaded) return undefined;
    return loaded.body.kind === "text" ? loaded.body.file.hunks : [];
  }

  /** Note status against the current list and the hunks loaded so far. */
  statusOf(note: DiffNote) {
    const listed = this.files().some((file) => file.path === note.path);
    return noteStatus(note, listed, this.loadedHunks(note.path));
  }

  /* ------------------------------------------------------- navigation */

  select(index: number): void {
    const files = this.files();
    if (files.length === 0) return;
    this.selectedIndex = Math.max(0, Math.min(index, files.length - 1));
    this.selectedPath = files[this.selectedIndex]?.path;
    this.selectedHunk = undefined;
    this.clearLine();
    this.focusedFinding = undefined;
    this.keepSelectionVisible();
  }

  toggleExpanded(): void {
    const path = this.selectedPath;
    if (path === undefined) return;
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
      if (this.selectedHunk?.path === path) {
        this.selectedHunk = undefined;
        this.clearLine();
      }
    } else {
      this.expanded.add(path);
      this.ensureBody(path);
    }
    this.keepSelectionVisible();
  }

  /** Expand a file and load its body; nothing when already expanded. */
  expand(path: string): void {
    if (this.expanded.has(path)) return;
    this.expanded.add(path);
    this.ensureBody(path);
  }

  /** n/N: the next or previous hunk, crossing into neighbouring files. */
  moveHunk(direction: 1 | -1): void {
    const files = this.files();
    for (let guard = 0; guard <= files.length; guard += 1) {
      const file = this.selectedFile();
      if (!file) return;
      this.expand(file.path);
      const hunks = this.visibleHunks(file);
      if (hunks === undefined) {
        this.pendingHunk = { path: file.path, direction };
        return;
      }
      const selection = this.selectedHunk;
      const at =
        selection?.path === file.path
          ? hunks.findIndex((hunk) => hunk.id === selection.hunkId)
          : -1;
      const next = at < 0 ? (direction > 0 ? 0 : hunks.length - 1) : at + direction;
      const hunk = hunks[next];
      if (hunk && next >= 0) {
        this.enterHunk(file.path, hunk);
        this.focusedFinding = undefined;
        this.keepSelectionVisible();
        return;
      }
      const neighbour = this.selectedIndex + direction;
      if (neighbour < 0 || neighbour >= files.length) {
        this.setMessage(direction > 0 ? "No more hunks below." : "No more hunks above.");
        return;
      }
      this.select(neighbour);
    }
  }

  /** f/F: the next or previous recorded finding on a listed file. */
  moveFinding(direction: 1 | -1): void {
    const order = this.findings().order;
    if (order.length === 0) {
      this.setMessage(
        this.recorded.findings.length > 0
          ? "No findings on files in this diff; see the list at the bottom."
          : "No recorded review findings.",
      );
      return;
    }
    const at = order.findIndex((entry) => entry.key === this.focusedFinding);
    const next =
      at < 0
        ? direction > 0
          ? 0
          : order.length - 1
        : (at + direction + order.length) % order.length;
    const target = order[next];
    if (!target) return;
    const index = this.files().findIndex((file) => file.path === target.path);
    if (index < 0) return;
    this.select(index);
    this.focusedFinding = target.key;
    this.expand(target.path);
    this.keepSelectionVisible();
  }

  private keepSelectionVisible(): void {
    const scroller = this.scroller;
    if (!scroller || this.lastWidth <= 0) return;
    this.renderBody(this.lastWidth, true);
    const height = scroller.viewportHeight();
    if (height <= 0) return;
    const top = scroller.top();
    if (this.selectedLine < top) scroller.scrollTo(this.selectedLine);
    else if (this.selectedLine >= top + height) scroller.scrollTo(this.selectedLine - height + 1);
  }

  private page(): number {
    return Math.max(1, (this.scroller?.viewportHeight() ?? 10) - 1);
  }

  /* ------------------------------------------------------ line cursor */

  /**
   * Select a hunk; the line cursor starts on its first displayed line unless
   * it is folded or its header is a stop.
   */
  private enterHunk(path: string, hunk: DiffHunk): void {
    this.selectedHunk = { path, hunkId: hunk.id };
    this.anchorLine = undefined;
    this.cursorLine =
      this.cursorMode === "line" &&
      !this.options.hunkStops &&
      !this.foldedHunks.has(hunk.id) &&
      hunk.lines.length > 0
        ? 0
        : undefined;
  }

  private clearLine(): void {
    this.cursorLine = undefined;
    this.anchorLine = undefined;
  }

  /** Where the line cursor is; undefined with nothing listed. */
  lineCursor(): LineCursor | undefined {
    const path = this.selectedPath;
    if (path === undefined) return undefined;
    const cursor: LineCursor = { path };
    const hunkId = this.selectedHunk?.path === path ? this.selectedHunk.hunkId : undefined;
    if (hunkId === undefined) return cursor;
    cursor.hunkId = hunkId;
    if (this.cursorLine !== undefined) cursor.lineIndex = this.cursorLine;
    if (this.anchorLine !== undefined) cursor.anchorIndex = this.anchorLine;
    return cursor;
  }

  /** Hunks of a showable, loaded file as displayed (with revealed context). */
  displayHunks(file: FileSummary): readonly DiffHunk[] | undefined {
    const hunks = this.visibleHunks(file);
    const expand = this.options.expandContext;
    return hunks && expand ? hunks.map((hunk) => expand(hunk)) : hunks;
  }

  /** The cursor's hunk as displayed. */
  currentDisplayHunk(): { file: FileSummary; hunk: DiffHunk } | undefined {
    const current = this.currentHunk();
    if (!current) return undefined;
    const expand = this.options.expandContext;
    return { file: current.file, hunk: expand ? expand(current.hunk) : current.hunk };
  }

  private cursorFiles(): CursorFile[] {
    return this.files().map((file) => ({
      path: file.path,
      open: this.expanded.has(file.path) && this.canShowContents(file),
      hunks: this.displayHunks(file),
      folded: (hunkId) => this.foldedHunks.has(hunkId),
      hunkStops: this.options.hunkStops === true,
    }));
  }

  /** Put the line cursor at `cursor` (a listed path) and keep it visible. */
  setCursor(cursor: LineCursor | undefined): void {
    if (!cursor) return;
    const index = this.files().findIndex((file) => file.path === cursor.path);
    if (index < 0) return;
    this.selectedIndex = index;
    this.selectedPath = cursor.path;
    this.focusedFinding = undefined;
    if (cursor.hunkId === undefined) {
      this.selectedHunk = undefined;
      this.clearLine();
    } else {
      this.selectedHunk = { path: cursor.path, hunkId: cursor.hunkId };
      this.cursorLine = cursor.lineIndex;
      this.anchorLine = cursor.lineIndex === undefined ? undefined : cursor.anchorIndex;
    }
    this.keepSelectionVisible();
  }

  /** Move the line cursor `delta` stops (file rows, folded hunks, lines); a selection collapses. */
  moveCursor(delta: number): void {
    this.setCursor(moveLine(this.cursorFiles(), this.lineCursor(), delta));
  }

  /** Shift+↑/↓: extend the selection within the cursor's hunk. */
  extendLineSelection(delta: number): void {
    const cursor = this.lineCursor();
    const current = this.currentDisplayHunk();
    if (!cursor || !current || this.foldedHunks.has(current.hunk.id)) return;
    if (!this.options.freeSelection) {
      this.setCursor(extendSelection(current.hunk, cursor, delta));
      return;
    }
    const count = current.hunk.lines.length;
    if (count === 0 || !Number.isInteger(delta) || delta === 0) return;
    const index = cursor.lineIndex;
    if (index === undefined) {
      // From the hunk's header a selection starts on its first line.
      if (delta > 0) this.setCursor({ ...cursor, lineIndex: 0 });
      return;
    }
    const next = Math.max(0, Math.min(count - 1, index + delta));
    if (next === index) return;
    this.setCursor({ ...cursor, lineIndex: next, anchorIndex: cursor.anchorIndex ?? index });
  }

  /** Where a comment written now attaches; undefined off a line. */
  commentPosition(): CommentPosition | undefined {
    const cursor = this.lineCursor();
    const current = this.currentDisplayHunk();
    if (!cursor || !current || this.foldedHunks.has(current.hunk.id)) return undefined;
    return currentCommentPosition(current.file.path, current.hunk, cursor);
  }

  /** Fold or unfold a hunk; the cursor on it moves to its placeholder or first line. */
  setFolded(hunkId: string, folded: boolean): void {
    if (folded === this.foldedHunks.has(hunkId)) return;
    if (folded) this.foldedHunks.add(hunkId);
    else this.foldedHunks.delete(hunkId);
    if (this.selectedHunk?.hunkId === hunkId) {
      this.anchorLine = undefined;
      this.cursorLine = folded ? undefined : 0;
    }
    this.invalidate();
  }

  /** Enter/space with the line cursor: fold the cursor's hunk, or expand its file row. */
  private toggleLine(): void {
    const hunk = this.selectedHunk;
    if (hunk && hunk.path === this.selectedPath) {
      this.setFolded(hunk.hunkId, !this.foldedHunks.has(hunk.hunkId));
      this.keepSelectionVisible();
      return;
    }
    this.toggleExpanded();
  }

  /**
   * The host changed the context shown around `hunkId`; `aboveDelta` lines were
   * added (or removed) above it, so the cursor follows its line. A selection collapses.
   */
  contextChanged(hunkId: string, aboveDelta: number): void {
    if (this.selectedHunk?.hunkId === hunkId && this.cursorLine !== undefined) {
      const shown = this.currentDisplayHunk()?.hunk.lines.length ?? 0;
      this.cursorLine = Math.max(0, Math.min(shown - 1, this.cursorLine + aboveDelta));
    }
    this.anchorLine = undefined;
    this.invalidate();
    this.keepSelectionVisible();
  }

  /** Replace the search; an empty query clears it. The cursor goes to the first match. */
  setSearch(query: string): void {
    const search = this.options.search;
    if (query.length === 0 || !search) {
      this.searchState = undefined;
      return;
    }
    const matches = search(query);
    this.searchState = { query, matches, index: matches.length > 0 ? 0 : -1 };
    this.goTo(matches[0]);
  }

  /** The next or previous match, wrapping at the ends. */
  moveSearchMatch(delta: number): void {
    const search = this.searchState;
    if (!search || search.matches.length === 0 || !Number.isInteger(delta)) return;
    const count = search.matches.length;
    const index = (((search.index + delta) % count) + count) % count;
    this.searchState = { ...search, index };
    this.goTo(search.matches[index]);
  }

  /** Send the line cursor to a line: its file expands and its hunk unfolds; a loading body is awaited. */
  goTo(target: LineTarget | undefined): void {
    if (!target) return;
    const file = this.files().find((entry) => entry.path === target.path);
    if (!file) return;
    this.expand(target.path);
    if (this.foldedHunks.delete(target.hunkId)) this.invalidate();
    const hunks = this.visibleHunks(file);
    if (hunks === undefined) {
      this.pendingLine = target;
      this.setCursor({ path: target.path });
      return;
    }
    const hunk = hunks.find((entry) => entry.id === target.hunkId);
    if (!hunk) {
      this.setCursor({ path: target.path });
      return;
    }
    const shown = this.options.expandContext?.(hunk) ?? hunk;
    const original = hunk.lines[target.lineIndex];
    const at = original === undefined ? -1 : shown.lines.indexOf(original);
    this.setCursor({
      path: target.path,
      hunkId: hunk.id,
      lineIndex: at >= 0 ? at : target.lineIndex,
    });
  }

  /* ------------------------------------------------------------ mouse */

  /** What body row `row` showed when the body was last drawn; undefined on any other row. */
  rowTarget(row: number): CursorRow | undefined {
    for (const entry of this.blockRows) {
      const offset = row - entry.start;
      if (offset >= 0 && offset < entry.block.lines.length) return entry.block.stops?.[offset];
    }
    return undefined;
  }

  /** Body rows of a hunk's lines as last drawn. */
  private lineRows(path: string, hunkId: string): Array<{ row: number; lineIndex: number }> {
    const rows: Array<{ row: number; lineIndex: number }> = [];
    for (const entry of this.blockRows) {
      if (entry.block.stops?.[0]?.path !== path) continue;
      entry.block.stops.forEach((stop, offset) => {
        if (stop?.hunkId === hunkId && stop.lineIndex !== undefined) {
          rows.push({ row: entry.start + offset, lineIndex: stop.lineIndex });
        }
      });
    }
    return rows;
  }

  /**
   * Extend the selection to the line of the cursor's hunk nearest to `row`: it
   * stays in one hunk. False when that leaves the selection as it was, which
   * is most of a drag: a terminal reports every cell the pointer crosses.
   */
  private dragTo(row: number): boolean {
    const selection = this.selectedHunk;
    const from = this.cursorLine;
    if (!selection || from === undefined) return false;
    let nearest: { row: number; lineIndex: number } | undefined;
    for (const entry of this.lineRows(selection.path, selection.hunkId)) {
      if (!nearest || Math.abs(entry.row - row) < Math.abs(nearest.row - row)) nearest = entry;
    }
    if (!nearest || nearest.lineIndex === from) return false;
    this.extendLineSelection(nearest.lineIndex - from);
    return this.cursorLine !== from;
  }

  /**
   * A click on a file row selects the file and expands or collapses it; on a
   * hunk header it selects the hunk. With the line cursor, a press on a line
   * puts the cursor there (Shift extends from where it was) and the drags
   * that follow select a range.
   */
  pointer(gesture: PointerGesture): boolean {
    if (this.noteInput || this.disposed) return false;
    const line = this.cursorMode === "line";
    if (gesture.kind === "drag") {
      if (!line) return false;
      if (this.dragTo(gesture.row)) this.actions.requestRender();
      return true;
    }
    const target = this.rowTarget(gesture.row);
    if (!target) return false;
    const onLine = line && target.hunkId !== undefined && target.lineIndex !== undefined;
    if (gesture.kind === "press") {
      if (!onLine) return false;
      if (!this.options.keepMessages) this.message = undefined;
      const from = this.cursorLine;
      const selection = this.selectedHunk;
      if (
        gesture.extend &&
        from !== undefined &&
        selection?.path === target.path &&
        selection.hunkId === target.hunkId
      ) {
        this.extendLineSelection((target.lineIndex ?? from) - from);
      } else this.setCursor(target);
      this.actions.requestRender();
      return true;
    }
    if (!this.options.keepMessages) this.message = undefined;
    if (target.hunkId === undefined) {
      const index = this.files().findIndex((file) => file.path === target.path);
      if (index < 0) return false;
      this.select(index);
      this.toggleExpanded();
    } else if (!onLine) {
      // Where an unfolded hunk's header is not a stop (the review), its first line is.
      const header = { path: target.path, hunkId: target.hunkId };
      const stop =
        !line ||
        cursorRows(this.cursorFiles()).some(
          (row) =>
            row.path === header.path && row.hunkId === header.hunkId && row.lineIndex === undefined,
        );
      this.setCursor(stop ? header : { ...header, lineIndex: 0 });
    }
    // A click on a line: its press already put the cursor there.
    this.actions.requestRender();
    return true;
  }

  /* --------------------------------------------------------- actions */

  private startNote(): void {
    const current = this.currentHunk();
    if (!current) {
      this.setMessage("Select a hunk first (n/N), then press c.", "warning");
      return;
    }
    const input = new Input();
    const target = {
      input,
      path: current.file.path,
      hunkId: current.hunk.id,
      range: hunkRangeText(current.hunk),
    };
    input.onSubmit = (value) => {
      this.noteInput = undefined;
      const text = value.replaceAll(/\s+/gu, " ").trim();
      if (text.length === 0) {
        this.setMessage("Empty note discarded.");
        return;
      }
      this.actions.addNote?.(current.file, current.hunk, text);
    };
    input.onEscape = () => {
      this.noteInput = undefined;
      this.setMessage("Note cancelled.");
    };
    this.noteInput = target;
  }

  /**
   * The reveal action (`v`): show a hidden sensitive file at once, for this
   * view only. Nothing is saved, so the file is hidden again when the view reopens.
   */
  private reveal(): void {
    const file = this.selectedFile();
    if (!file) return;
    if (!isSensitiveFile(file)) {
      this.setMessage("This file is not on the sensitive list; its contents are already shown.");
      return;
    }
    if (this.revealed.has(file.path)) {
      this.setMessage("Contents already shown.");
      return;
    }
    const path = file.path;
    this.revealed.add(path);
    this.expanded.add(path);
    this.ensureBody(path);
    this.setMessage(`Showing ${path} until this view closes.`, "warning");
    this.dropCachedBlocks(path);
  }

  /** What the cursor is on: selected lines, a hunk, or a file; undefined without a file. */
  private cursorTarget(): AskTarget | undefined {
    const current = this.currentHunk();
    if (current) {
      const shown = this.currentDisplayHunk();
      const cursor = this.lineCursor();
      const selected = shown && cursor ? selectedLineIndexes(shown.hunk, cursor) : [];
      const first = selected[0];
      const last = selected.at(-1);
      if (shown && first !== undefined && last !== undefined) {
        return { file: shown.file, hunk: shown.hunk, lines: { first, last } };
      }
      return { file: current.file, hunk: current.hunk };
    }
    const file = this.selectedFile();
    return file ? { file } : undefined;
  }

  /** Hand the cursor's target to `action`, when the owner provides it. */
  private withTarget(action: ((target: AskTarget) => void) | undefined): void {
    if (!action) return;
    const target = this.cursorTarget();
    if (target) action(target);
    else this.setMessage("No file selected.");
  }

  handleKey(data: string): void {
    const actions = this.actions;
    if (actions.isToggleKey(data)) {
      this.noteInput = undefined;
      actions.close();
      return;
    }
    if (this.noteInput) {
      this.noteInput.input.handleInput(data);
      actions.requestRender();
      return;
    }
    const action = actionFor(this.keys, data);
    if (action === "back" && matchesKey(data, "escape") && this.helpOpen) {
      this.helpOpen = false;
      actions.requestRender();
      return;
    }
    if (action === "back" || actions.isFocusKey(data)) {
      actions.unfocus();
      return;
    }
    if (!this.options.keepMessages) this.message = undefined;
    const line = this.cursorMode === "line";
    switch (action) {
      case "extendDown":
        this.extendLineSelection(1);
        break;
      case "extendUp":
        this.extendLineSelection(-1);
        break;
      case "down":
        if (line) this.moveCursor(1);
        else this.select(this.selectedIndex + 1);
        break;
      case "up":
        if (line) this.moveCursor(-1);
        else this.select(this.selectedIndex - 1);
        break;
      case "fileDown":
        this.select(this.selectedIndex + 1);
        break;
      case "fileUp":
        this.select(this.selectedIndex - 1);
        break;
      case "toggle":
        if (line && this.options.enterFolds !== false) this.toggleLine();
        else this.toggleExpanded();
        break;
      case "pageDown":
        if (line) this.moveCursor(this.page());
        else this.scroller?.scrollBy(this.page());
        break;
      case "pageUp":
        if (line) this.moveCursor(-this.page());
        else this.scroller?.scrollBy(-this.page());
        break;
      case "first":
        if (line) this.moveCursor(-Number.MAX_SAFE_INTEGER);
        else this.select(0);
        this.scroller?.scrollTo(0);
        break;
      case "last":
        if (line) this.moveCursor(Number.MAX_SAFE_INTEGER);
        else this.select(this.files().length - 1);
        this.scroller?.scrollTo(Number.MAX_SAFE_INTEGER);
        break;
      case "wider":
        actions.resizeBy(KEYBOARD_RESIZE_STEP);
        break;
      case "narrower":
        actions.resizeBy(-KEYBOARD_RESIZE_STEP);
        break;
      case "refresh":
        actions.refresh();
        break;
      case "help":
        this.helpOpen = !this.helpOpen;
        break;
      case "nextHunk":
        this.moveHunk(1);
        break;
      case "previousHunk":
        this.moveHunk(-1);
        break;
      case "nextFinding":
        this.moveFinding(1);
        break;
      case "previousFinding":
        this.moveFinding(-1);
        break;
      case "ask":
        // Notes are asked about together; with none, the cursor's target is asked about.
        if (actions.sendNotes && (this.notes?.notes.length ?? 0) > 0) actions.sendNotes();
        else this.withTarget(actions.ask);
        break;
      case "copy":
        this.withTarget(actions.copy);
        break;
      case "note":
        this.startNote();
        break;
      case "cycleSource":
        actions.cycleSource?.();
        break;
      case "olderTurn":
        actions.stepTurn?.(-1);
        break;
      case "newerTurn":
        actions.stepTurn?.(1);
        break;
      case "review":
        actions.startReview?.();
        break;
      case "reveal":
        this.reveal();
        break;
      case undefined:
        return;
    }
    actions.requestRender();
  }
}
