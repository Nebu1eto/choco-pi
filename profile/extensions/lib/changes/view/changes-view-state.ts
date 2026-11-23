/**
 * The changes view's types and its state: every field the view's layers
 * share, the constructor, and the setters hosts call. `ChangesView` in
 * `changes-view.ts` is the class hosts use; the layers in between add
 * the header, the body, file blocks and navigation.
 */
import { Input } from "@earendil-works/pi-tui";
import type {
  DiffSource,
  DiffStore,
  DiffStoreState,
  FileBody,
  FileExcerpt,
  FileSummary,
} from "../git/model.ts";
import { renderDiffFile, type IntralineBudget } from "../render/diff-render.ts";
import type { HunkRows, BodyAnnotation } from "./body-block.ts";
import { createHighlight, DEFAULT_HIGHLIGHT } from "../render/highlight.ts";
import { sanitizeTerminalText as safe, terminalSafeFile } from "../terminal-text.ts";
import type { DiffFile, DiffHunk } from "../types.ts";
import {
  EMPTY_FINDINGS,
  type FindingsSummary,
  type RecordedFinding,
  type ReviewTone,
} from "../findings.ts";
import { PANE_KEYS, type ChangesKeyTable } from "./keys.ts";
import type { HeaderBoxRenderer } from "./header-box.ts";
import type { FileItems, PaneComment } from "./items.ts";
import type { PaneScroller } from "./surface.ts";
import type { PaneColor, PaneStyler, RowBadge } from "./rows.ts";
import type { NotesBook } from "../notes.ts";
import type { CursorRow, LineCursor, LineTarget } from "./line-cursor.ts";

export type { CommentPlacement, PaneComment } from "./items.ts";

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

export type LoadedBody = { revision: number; body: FileBody };

/**
 * Where the view reads bodies. `peekFile` returns a body the store already
 * holds for the current revision, so it can be drawn without a loading row;
 * `loadContext` quotes the file around findings outside every hunk (without
 * it, those findings are drawn without a quote).
 */
export type ViewStore = Pick<DiffStore, "loadFile"> &
  Partial<Pick<DiffStore, "loadContext">> & {
    peekFile?(path: string): LoadedBody | undefined;
  };

/** A loaded file's hunks as rendered at one width and layout (`key`), from one body (`raw`). */
export type RenderedHunks = { raw: DiffFile; key: string; file: DiffFile; rows: HunkRows[] };

/** Blocks kept however few files are listed; see `fileBlock`. */
export const MIN_CACHED_BLOCKS = 32;
/** Past this many, the rows measured so far are forgotten and measured again as they are drawn. */
export const MAX_FITTED_ROWS = 50_000;

export type Block = {
  lines: string[];
  /** Offset of the line to keep visible, when not the file row. */ anchor?: number;
  /** What each row shows, for the mouse: a file row, a hunk header or a line. */
  stops?: Array<CursorRow | undefined>;
  /** Each drawn hunk's rows: its header's offset and the offset after its last row (its items included). */
  hunks?: HunkSpan[];
};

export type HunkSpan = { hunkId: string; start: number; end: number };

/** A row drawn over the top of the body while the rows under it scroll: a file's, then its hunk's. */
export type PinnedRow = { row: number; path: string; hunkId?: string };

export type FindingsIndex = {
  byPath: Map<string, RecordedFinding[]>;
  unlisted: RecordedFinding[];
  commentsByPath: Map<string, PaneComment[]>;
  unlistedComments: PaneComment[];
};

export type PaneMessage = { text: string; color: PaneColor };

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
   * Draw the header as a labeled box (the pane), like zentui's prompt frame;
   * plain lines otherwise, and below {@link HEADER_BOX_MIN_WIDTH} columns.
   */
  boxedHeader?: boolean;
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

export function findingRange(finding: RecordedFinding): string {
  const start = finding.startLine;
  if (start === undefined) return "";
  const end = finding.endLine;
  return end !== undefined && end !== start ? `L${start}-${end}` : `L${start}`;
}

export const TONE_COLORS = {
  success: "success",
  error: "error",
  warning: "warning",
  muted: "muted",
} satisfies Record<ReviewTone, PaneColor>;

export { terminalSafeFile };

/** A finding path made repository-relative with forward slashes. */
export function normalizeFindingPath(path: string, repoRoot: string): string {
  let result = path.replaceAll("\\", "/");
  const root = repoRoot.replaceAll("\\", "/").replace(/\/+$/u, "");
  if (root.length > 0 && result.startsWith(`${root}/`)) result = result.slice(root.length + 1);
  while (result.startsWith("./")) result = result.slice(2);
  return result;
}

export abstract class ChangesViewState {
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
  /** `/review-assist` comments of reviews of this session or branch, shown read-only. */
  comments: readonly PaneComment[] = [];
  /** Epoch ms of each listed file's last change; null when it could not be read. */
  changeTimes: ReadonlyMap<string, number | null> = new Map();
  /** The finding or comment the cursor is on (its item id); absent everywhere else. */
  selectedItem: string | undefined;
  /** Findings and comments closed or opened by the user, by item id; absent means open. */
  readonly itemOpen = new Map<string, boolean>();
  /** zentui's box for the header; the theme's own box when absent or failing. */
  headerBox: HeaderBoxRenderer | undefined;
  noteInput: { input: Input; path: string; hunkId: string; range: string } | undefined;

  readonly store: ViewStore;
  readonly actions: PaneActions;
  readonly renderFileBody: FileBodyRenderer;
  protected readonly cache = new Map<string, Block>();
  /**
   * Each loaded file's hunks as rendered, which no cursor position changes:
   * a cursor move lays the file's block out again from these instead of
   * highlighting and diffing the whole file once more.
   */
  protected readonly renderedHunks = new Map<string, RenderedHunks>();
  /** Rows already cut to `fittedWidth`; nearly every row of a frame was in the frame before. */
  protected readonly fittedRows = new Map<string, string>();
  protected fittedWidth = -1;
  protected readonly requested = new Map<string, number>();
  protected scroller: PaneScroller | undefined;
  protected lastWidth = 0;
  protected selectedLine = 0;
  protected cachedRevision: number | undefined;
  protected recordedVersion = 0;
  protected commentsVersion = 0;
  protected findingsCache: { key: string; index: FindingsIndex } | undefined;
  /** Each file's placed items, for the body it was placed against (undefined: no hunks shown). */
  protected readonly layouts = new Map<string, { raw: DiffFile | undefined; items: FileItems }>();
  /** Quotes of the current revision by path and range; "loading" while read. */
  protected readonly excerpts = new Map<string, FileExcerpt | "loading">();
  protected pendingHunk: { path: string; direction: 1 | -1 } | undefined;
  /** A search match whose body was loading when the cursor was sent there. */
  protected pendingLine: LineTarget | undefined;
  /** An item f/F went to while its file's body was loading. */
  protected pendingItem: { path: string; itemId: string } | undefined;
  /** Each file's block as last drawn: its first row, the file's row as drawn, and the path. */
  protected blockRows: Array<{ start: number; block: Block; row: string; path: string }> = [];
  /** The body rows the hosts drew pinned rows over in the last frame, for a click on them. */
  protected pinned: PinnedRow[] = [];
  /** The host pins file rows (it asked for one); hosts that never ask scroll as before. */
  protected pinning = false;

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
  protected readonly fileOrder: ChangesViewOptions["fileOrder"];
  protected readonly rowBadges: ChangesViewOptions["rowBadges"];
  protected readonly options: ChangesViewOptions;
  protected ordered: { state: DiffStoreState; files: readonly FileSummary[] } | undefined;

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
      this.excerpts.clear();
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
    if (
      this.selectedItem !== undefined &&
      !this.itemIds(this.selectedPath).includes(this.selectedItem)
    ) {
      this.selectedItem = undefined;
    }
    if (!this.selectedHunk) this.clearLine();
    for (const path of this.expanded) this.ensureBody(path);
  }

  /** Replace the recorded review summary and file change times. */
  setRecorded(recorded: FindingsSummary, changeTimes: ReadonlyMap<string, number | null>): void {
    this.recorded = recorded;
    this.changeTimes = changeTimes;
    this.recordedVersion += 1;
    this.itemsChanged();
  }

  /** Replace the review comments shown; their open or closed state is kept by id. */
  setComments(comments: readonly PaneComment[]): void {
    this.comments = comments;
    this.commentsVersion += 1;
    this.itemsChanged();
  }

  protected itemsChanged(): void {
    this.findingsCache = undefined;
    this.layouts.clear();
    if (
      this.selectedItem !== undefined &&
      !this.itemIds(this.selectedPath).includes(this.selectedItem)
    ) {
      this.selectedItem = undefined;
    }
  }

  setMessage(text: string, color: PaneColor = "muted"): void {
    // Messages often embed a file name, so the whole text is made terminal-safe.
    this.message = { text: safe(text), color };
  }

  clearMessage(): void {
    this.message = undefined;
  }

  /** Release references; late body loads are dropped. */
  dispose(): void {
    this.disposed = true;
    this.invalidate();
    this.bodies.clear();
    this.requested.clear();
    this.excerpts.clear();
    this.noteInput = undefined;
  }

  invalidate(): void {
    this.cache.clear();
    this.renderedHunks.clear();
    this.fittedRows.clear();
    this.layouts.clear();
  }

  /* ------------------------------------- implemented by the later layers */

  /** A file's block at one width, built or from the cache (`file-block-renderer.ts`). */
  protected abstract fileBlock(file: FileSummary, revision: number, width: number): Block;
  protected abstract ensureBody(path: string): void;
  abstract canShowContents(file: FileSummary): boolean;
  /** The finding and comment ids of a file, in drawn order (`changes-view-body.ts`). */
  protected abstract itemIds(path: string | undefined): string[];
  /* Navigation and the line cursor (`navigation.ts`). */
  protected abstract clearLine(): void;
  protected abstract enterHunk(path: string, hunk: DiffHunk): void;
  protected abstract hasItemStop(path: string, itemId: string): boolean;
  protected abstract keepSelectionVisible(): void;
  abstract displayHunks(file: FileSummary): readonly DiffHunk[] | undefined;
  abstract lineCursor(): LineCursor | undefined;
  abstract currentDisplayHunk(): { file: FileSummary; hunk: DiffHunk } | undefined;
  abstract goTo(target: LineTarget | undefined): void;
  abstract setCursor(cursor: LineCursor | undefined): void;
}
