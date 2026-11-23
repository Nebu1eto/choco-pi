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

export type AskTarget = {
  file: FileSummary;
  hunk?: DiffHunk;
  lines?: { first: number; last: number };
};

export type PaneActions = {
  unfocus(): void;
  close(): void;
  resizeBy(delta: number): void;
  refresh(): void;
  requestRender(): void;
  isToggleKey(data: string): boolean;
  isFocusKey(data: string): boolean;
  ask?(target: AskTarget): void;
  copy?(target: AskTarget): void;
  addNote?(file: FileSummary, hunk: DiffHunk, text: string): void;
  sendNotes?(): void;
  cycleSource?(): void;
  stepTurn?(delta: -1 | 1): void;
  startReview?(): void;
};

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

export type ViewStore = Pick<DiffStore, "loadFile"> &
  Partial<Pick<DiffStore, "loadContext">> & {
    peekFile?(path: string): LoadedBody | undefined;
  };

export type RenderedHunks = { raw: DiffFile; key: string; file: DiffFile; rows: HunkRows[] };

export const MIN_CACHED_BLOCKS = 32;
export const MAX_FITTED_ROWS = 50_000;

export type Block = {
  lines: string[];
  anchor?: number;
  stops?: Array<CursorRow | undefined>;
  hunks?: HunkSpan[];
};

export type HunkSpan = { hunkId: string; start: number; end: number };

export type PinnedRow = { row: number; path: string; hunkId?: string };

export type FindingsIndex = {
  byPath: Map<string, RecordedFinding[]>;
  unlisted: RecordedFinding[];
  commentsByPath: Map<string, PaneComment[]>;
  unlistedComments: PaneComment[];
};

export type PaneMessage = { text: string; color: PaneColor };

export type RowDetail = { text: string; color: PaneColor };

export type ChangesViewOptions = {
  store: ViewStore;
  styler: PaneStyler;
  actions: PaneActions;
  renderFileBody?: FileBodyRenderer;
  keyHint: string;
  helpLines: readonly string[];
  keepMessages?: boolean;
  keys?: ChangesKeyTable;
  fileOrder?: (files: readonly FileSummary[]) => readonly FileSummary[];
  rowBadges?: (path: string) => readonly RowBadge[];
  title?: string;
  boxedHeader?: boolean;
  cursor?: "hunk" | "line";
  hunkStops?: boolean;
  freeSelection?: boolean;
  enterFolds?: boolean;
  foldReason?: (hunkId: string) => string | undefined;
  reviewedHunks?: () => ReadonlySet<string>;
  mode?: () => "unified" | "split";
  search?: (query: string) => readonly LineTarget[];
  expandContext?: (hunk: DiffHunk) => DiffHunk;
  annotations?: (path: string, hunks: readonly DiffHunk[], width: number) => BodyAnnotation[];
  fileTrailer?: (path: string, hunks: readonly DiffHunk[], width: number) => string[];
  rowDetails?: (path: string, expanded: boolean) => readonly RowDetail[];
  trailer?: (width: number) => string[];
};

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
  selectedHunk: { path: string; hunkId: string } | undefined;
  readonly expanded = new Set<string>();
  readonly bodies = new Map<string, LoadedBody>();
  readonly revealed = new Set<string>();
  blockRenders = 0;
  lastRenderBudget: IntralineBudget | undefined;
  styler: PaneStyler;
  disposed = false;
  helpOpen = false;
  message: PaneMessage | undefined;
  notes: NotesBook | undefined;
  recorded: FindingsSummary = EMPTY_FINDINGS;
  comments: readonly PaneComment[] = [];
  changeTimes: ReadonlyMap<string, number | null> = new Map();
  selectedItem: string | undefined;
  readonly itemOpen = new Map<string, boolean>();
  headerBox: HeaderBoxRenderer | undefined;
  noteInput: { input: Input; path: string; hunkId: string; range: string } | undefined;

  readonly store: ViewStore;
  readonly actions: PaneActions;
  readonly renderFileBody: FileBodyRenderer;
  protected readonly cache = new Map<string, Block>();
  protected readonly renderedHunks = new Map<string, RenderedHunks>();
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
  protected readonly layouts = new Map<string, { raw: DiffFile | undefined; items: FileItems }>();
  protected readonly excerpts = new Map<string, FileExcerpt | "loading">();
  protected pendingHunk: { path: string; direction: 1 | -1 } | undefined;
  protected pendingLine: LineTarget | undefined;
  protected pendingItem: { path: string; itemId: string } | undefined;
  protected blockRows: Array<{ start: number; block: Block; row: string; path: string }> = [];
  protected pinned: PinnedRow[] = [];
  protected pinning = false;

  cursorLine: number | undefined;
  anchorLine: number | undefined;
  readonly foldedHunks = new Set<string>();
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

  setRecorded(recorded: FindingsSummary, changeTimes: ReadonlyMap<string, number | null>): void {
    this.recorded = recorded;
    this.changeTimes = changeTimes;
    this.recordedVersion += 1;
    this.itemsChanged();
  }

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
    this.message = { text: safe(text), color };
  }

  clearMessage(): void {
    this.message = undefined;
  }

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

  protected abstract fileBlock(file: FileSummary, revision: number, width: number): Block;
  protected abstract ensureBody(path: string): void;
  abstract canShowContents(file: FileSummary): boolean;
  protected abstract itemIds(path: string | undefined): string[];
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
