/**
 * One file's block in the changes view: its row, its hunks as rendered and
 * cached, quoted excerpts, and loading its body from the store.
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { FileExcerpt, FileSummary } from "../git/model.ts";
import { leadingColumns, lineTextColumn, MIN_SPLIT_WIDTH } from "../render/diff-render.ts";
import {
  BODY_INDENT,
  bodyBlock,
  bodyNote,
  hunkRowOfLine,
  renderHunkRows,
  splitRowCount,
  type BodyAnnotation,
  type BodyBlockInput,
} from "./body-block.ts";
import { sanitizeTerminalText as safe, terminalSafeFile } from "../terminal-text.ts";
import type { DiffFile, DiffHunk } from "../types.ts";
import { excerptHeader, excerptLine, type ExcerptGroup, type PlacedItem } from "./items.ts";
import { bodyNotice, fileRow, type PaneColor, type RowBadge } from "./rows.ts";
import { noteStatus, type DiffNote } from "../notes.ts";
import { isSensitiveFile } from "../sensitive.ts";
import type { RuntimeValue } from "../../runtime-values.ts";
import { selectedLineIndexes, type CursorRow } from "./line-cursor.ts";
import {
  type LoadedBody,
  type RenderedHunks,
  type Block,
  type HunkSpan,
  type BodyLayout,
  MIN_CACHED_BLOCKS,
  HIDDEN_CONTENTS,
  findingKey,
} from "./changes-view-state.ts";
import { ChangesViewBody } from "./changes-view-body.ts";

export abstract class ChangesViewBlocks extends ChangesViewBody {
  protected badges(path: string): RowBadge[] {
    const badges: RowBadge[] = [];
    const findings = this.findings().byPath.get(path);
    if (findings && findings.length > 0) {
      const serious = findings.some((finding) => finding.class === "finding");
      badges.push({ text: `⚑${findings.length}`, color: serious ? "warning" : "muted" });
    }
    const notes = this.notes?.forPath(path).length ?? 0;
    if (notes > 0) badges.push({ text: `✎${notes}`, color: "accent" });
    const comments = this.findings().commentsByPath.get(path)?.length ?? 0;
    if (comments > 0) badges.push({ text: `●${comments}`, color: "accent" });
    if (this.rowBadges) badges.push(...this.rowBadges(path));
    return badges;
  }

  protected decorationKey(path: string): string {
    const index = this.findings();
    const ids = [
      ...(index.byPath.get(path) ?? []).map((finding) => `finding:${findingKey(finding)}`),
      ...(index.commentsByPath.get(path) ?? []).map((comment) => `comment:${comment.id}`),
    ];
    // Which items are closed: toggling one draws its file again.
    const closed = ids.filter((id) => !this.isItemOpen(id)).join("\u0001");
    return [
      this.notes?.version ?? 0,
      this.recordedVersion,
      this.commentsVersion,
      this.selectedHunk?.path === path ? this.selectedHunk.hunkId : "",
      this.selectedPath === path ? (this.selectedItem ?? "") : "",
      closed,
      this.revealed.has(path) ? 1 : 0,
      // Host badges can change without a new snapshot (a risk score is not one).
      this.rowBadges ? JSON.stringify(this.rowBadges(path)) : "",
      this.selectedHunk?.path === path ? `${this.cursorLine ?? ""}/${this.anchorLine ?? ""}` : "",
    ].join(",");
  }

  protected fileBlock(file: FileSummary, revision: number, width: number): Block {
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
      if (body.hunks) {
        block.hunks = body.hunks.map((span) => ({
          ...span,
          start: span.start + bodyOffset,
          end: span.end + bodyOffset,
        }));
      }
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

  protected bodyBlock(file: FileSummary, width: number): Block {
    const styler = this.styler;
    const path = file.path;
    const note = (text: string, color: PaneColor = "dim") => bodyNote(text, width, styler, color);
    const placed = this.fileItems(file);
    const notes = this.notes?.forPath(path) ?? [];
    const out: string[] = [];
    const stops: Array<CursorRow | undefined> = [];
    let anchor: number | undefined;
    const push = (row: string, stop?: CursorRow) => {
      out.push(row);
      stops.push(stop);
    };
    const pushItem = (entry: PlacedItem, textColumn?: number) => {
      const itemId = entry.item.id;
      if (this.selectedItem === itemId && this.selectedPath === path) anchor = out.length;
      for (const row of this.itemRows(entry.item, path, width, textColumn)) {
        push(row, { path, itemId });
      }
    };
    // Items between hunks: those without a line, then each quote of the file with its items.
    const pushGap = (hunkIndex: number) => {
      const here = placed.items.filter(
        (entry) => entry.place.kind === "before" && entry.place.hunkIndex === hunkIndex,
      );
      if (here.length === 0) return;
      for (const entry of here) if (!placed.groupOf.has(entry.item.id)) pushItem(entry);
      for (const group of placed.groups) {
        if (group.hunkIndex !== hunkIndex) continue;
        const members = here.filter((entry) => placed.groupOf.get(entry.item.id) === group);
        this.pushExcerpt(file, group, members, width, push, pushItem);
      }
    };
    const pushEnd = (hunkIds: ReadonlySet<string>) => {
      for (const entry of placed.items) {
        const place = entry.place;
        const lost =
          (place.kind === "line" || place.kind === "header") && !hunkIds.has(place.hunkId);
        if (lost) pushItem(entry);
      }
      for (const entry of placed.items) if (entry.place.kind === "end") pushItem(entry);
    };
    const hunkSpans: HunkSpan[] = [];
    const done = (): Block => {
      const block: Block = { lines: out, stops };
      if (anchor !== undefined) block.anchor = anchor;
      if (hunkSpans.length > 0) block.hunks = hunkSpans;
      return block;
    };
    if (!this.canShowContents(file)) {
      // Never quoted: the items are listed, as the contents are not.
      push(note(HIDDEN_CONTENTS, "warning"));
      for (const entry of placed.items) pushItem(entry);
      for (const entry of notes) push(this.noteLine(entry, false, width));
      return done();
    }
    const loaded = this.bodies.get(path);
    if (!loaded) return { lines: [note("Loading…")] };
    const notice = bodyNotice(loaded.body);
    if (notice !== undefined || loaded.body.kind !== "text") {
      push(note(notice ?? ""));
      pushGap(0);
      pushEnd(new Set());
      for (const entry of notes) push(this.noteLine(entry, true, width));
      for (const row of this.options.fileTrailer?.(path, [], width) ?? []) push(row);
      return done();
    }
    const line = this.cursorMode === "line";
    const raw = loaded.body.file;
    const innerWidth = Math.max(1, width - BODY_INDENT.length);
    const selectedHunkId = this.selectedHunk?.path === path ? this.selectedHunk.hunkId : undefined;
    const decorated =
      line || placed.items.length > 0 || notes.length > 0 || selectedHunkId !== undefined;
    const indent = (row: string) => truncateToWidth(BODY_INDENT + row, width, "…");
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

    // Notes whose hunk is gone come first; findings and comments sit at their lines.
    const hunkIds = new Set(diffFile.hunks.map((hunk) => hunk.id));
    for (const entry of notes) {
      if (!hunkIds.has(entry.hunkId)) push(this.noteLine(entry, true, width));
    }
    const annotations: BodyAnnotation[] = [];
    const itemAnnotations: Array<{ index: number; itemId: string }> = [];
    for (const entry of placed.items) {
      const place = entry.place;
      if ((place.kind !== "line" && place.kind !== "header") || !hunkIds.has(place.hunkId)) {
        continue;
      }
      // Under its line, at that line's text, the way a reviewer's note sits in the code.
      const hunk = diffFile.hunks.find((candidate) => candidate.id === place.hunkId);
      const codeLine = place.kind === "line" ? hunk?.lines[place.lineIndex] : undefined;
      const textColumn = BODY_INDENT.length + lineTextColumn(diffFile, codeLine, mode, innerWidth);
      itemAnnotations.push({ index: annotations.length, itemId: entry.item.id });
      annotations.push({
        hunkId: place.hunkId,
        place: place.kind === "header" ? "header" : { afterLine: place.lineIndex },
        lines: this.itemRows(entry.item, path, width, textColumn),
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
      input.foldMarker = (hunkId) => (this.foldedHunks.has(hunkId) ? "▸" : "▾");
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
    const blockStops = Array.from(
      { length: block.lines.length },
      (): CursorRow | undefined => undefined,
    );
    for (const hunk of diffFile.hunks) {
      const start = block.hunkStart.get(hunk.id);
      if (start === undefined) continue;
      blockStops[start] = { path, hunkId: hunk.id };
      hunk.lines.forEach((_line, lineIndex) => {
        // A line without a row of its own (a folded hunk) reports the header's.
        const row = block.rowOfLine(hunk.id, lineIndex);
        if (row !== undefined && row !== start) {
          blockStops[row] ??= { path, hunkId: hunk.id, lineIndex };
        }
      });
    }
    let selectedItemRow: number | undefined;
    for (const { index, itemId } of itemAnnotations) {
      const start = block.annotationRows[index] ?? -1;
      const count = annotations[index]?.lines.length ?? 0;
      if (start < 0) continue;
      if (this.selectedItem === itemId && this.selectedPath === path) selectedItemRow = start;
      for (let row = start; row < start + count; row += 1) blockStops[row] = { path, itemId };
    }
    // The hunks in order, with the quoted lines between them.
    const placedRow = Array.from({ length: block.lines.length }, () => -1);
    diffFile.hunks.forEach((hunk, hunkIndex) => {
      pushGap(hunkIndex);
      const start = block.hunkStart.get(hunk.id) ?? block.lines.length;
      const next = diffFile.hunks[hunkIndex + 1];
      const end = next ? (block.hunkStart.get(next.id) ?? block.lines.length) : block.lines.length;
      if (start < end)
        hunkSpans.push({ hunkId: hunk.id, start: out.length, end: out.length + end - start });
      for (let row = start; row < end; row += 1) {
        placedRow[row] = out.length;
        push(block.lines[row] ?? "", blockStops[row]);
      }
    });
    pushGap(diffFile.hunks.length);
    pushEnd(hunkIds);
    const blockAnchor = (row: number | undefined): number | undefined => {
      if (row === undefined) return undefined;
      const at = placedRow[row] ?? -1;
      return at < 0 ? undefined : at;
    };
    if (anchor === undefined && selectedItemRow !== undefined) {
      anchor = blockAnchor(selectedItemRow);
    }
    if (anchor === undefined && selectedHunkId !== undefined) {
      const onLine = line && this.cursorLine !== undefined && !this.foldedHunks.has(selectedHunkId);
      const start = onLine
        ? block.rowOfLine(selectedHunkId, this.cursorLine ?? 0)
        : block.hunkStart.get(selectedHunkId);
      anchor = blockAnchor(start);
    }
    for (const row of this.options.fileTrailer?.(path, diffFile.hunks, width) ?? []) push(row);
    return done();
  }

  /**
   * Lines of the file around findings between two hunks, each item after its
   * line. While the quote loads, or when the store cannot quote, the items
   * are drawn alone; an unavailable quote says why in one row.
   */
  protected pushExcerpt(
    file: FileSummary,
    group: ExcerptGroup,
    members: readonly PlacedItem[],
    width: number,
    push: (row: string) => void,
    pushItem: (entry: PlacedItem, textColumn?: number) => void,
  ): void {
    const styler = this.styler;
    const excerpt = this.excerptFor(file, group);
    if (excerpt?.kind !== "lines" || excerpt.lines.length === 0) {
      if (excerpt?.kind === "unavailable") {
        push(excerptHeader(group, width, styler, excerpt.reason));
      }
      for (const entry of members) pushItem(entry);
      return;
    }
    push(excerptHeader(group, width, styler));
    const last = excerpt.from + excerpt.lines.length - 1;
    const numberWidth = String(last).length;
    excerpt.lines.forEach((text, offset) => {
      const number = excerpt.from + offset;
      push(excerptLine(number, text, numberWidth, width, styler));
      // `number ┆ ` behind the body indent; a tab is drawn as one picture column.
      const textColumn = BODY_INDENT.length + numberWidth + 3 + leadingColumns(text, 1);
      for (const entry of members) if (entry.line === number) pushItem(entry, textColumn);
    });
    // The file ends before an item's line: it follows the last line quoted.
    for (const entry of members) if ((entry.line ?? 0) > last) pushItem(entry);
  }

  /**
   * The quote of a group for the snapshot shown, or undefined while it loads
   * (the first call starts the read) and when the store cannot quote.
   * Hidden sensitive files are never quoted.
   */
  protected excerptFor(file: FileSummary, group: ExcerptGroup): FileExcerpt | undefined {
    const store = this.store;
    if (!store.loadContext || !this.canShowContents(file) || this.state.kind !== "ready") {
      return undefined;
    }
    const key = JSON.stringify([file.path, group.from, group.to]);
    const known = this.excerpts.get(key);
    if (known === "loading") return undefined;
    if (known) return known;
    this.excerpts.set(key, "loading");
    const revision = this.state.snapshot.revision;
    const path = file.path;
    const accept = (excerpt: FileExcerpt, at: number) => {
      if (this.disposed || this.excerpts.get(key) !== "loading") return;
      const current = this.state.kind === "ready" ? this.state.snapshot.revision : undefined;
      // A quote of another snapshot is dropped; the view asks again for its own.
      if (at !== revision || current !== revision) return;
      this.excerpts.set(key, excerpt);
      this.dropCachedBlocks(path);
      this.actions.requestRender();
    };
    void store
      .loadContext(path, group.from, group.to)
      .then(
        (result) => accept(result.excerpt, result.revision),
        (error: RuntimeValue) =>
          accept(
            {
              kind: "unavailable",
              reason: error instanceof Error ? error.message : String(error),
            },
            revision,
          ),
      )
      .catch((error: RuntimeValue) => this.bodyFailed(path, error));
    return undefined;
  }

  /**
   * A loaded file's hunks, made terminal-safe, and their rendered rows. They
   * are kept until the body, the width or the layout changes, or the view is
   * invalidated (a fold, revealed context, a new theme): the cursor, notes
   * and findings are drawn around these rows and never change them. Rows the
   * frame's budget cut short are not kept, so a later frame draws them in full.
   */
  protected hunksRendered(
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
  protected layout(): BodyLayout {
    return {
      mode: this.options.mode?.() ?? "unified",
      fold: (hunkId) => this.foldedHunks.has(hunkId),
      foldReason: (hunkId) => this.options.foldReason?.(hunkId) ?? "folded",
    };
  }

  /** Rows of the cursor's hunk drawn inverted: the selected lines, or its header or placeholder. */
  protected invertedRows(hunk: DiffHunk, rowCount: number, mode: "unified" | "split"): Set<number> {
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

  protected dropCachedBlocks(path: string): void {
    this.renderedHunks.delete(path);
    this.layouts.delete(path);
    for (const key of this.cache.keys()) {
      if (key.split("\u0000")[2] === path) this.cache.delete(key);
    }
  }

  /** Load hunks for an expanded file unless the current revision is loaded or requested. */
  protected ensureBody(path: string): void {
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
  protected bodyFailed(path: string, error: RuntimeValue): void {
    if (this.disposed) return;
    const detail = error instanceof Error ? error.message : String(error);
    this.setMessage(`Cannot show ${path}: ${detail}`, "error");
    try {
      this.actions.requestRender();
    } catch {
      // The message is drawn with the next frame the host renders.
    }
  }

  protected acceptBody(path: string, requestedAt: number, result: LoadedBody): void {
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
    // Placed against the new body; an item f/F went to while it loaded gets the cursor now.
    this.layouts.delete(path);
    const item = this.pendingItem;
    if (item?.path === path) {
      this.pendingItem = undefined;
      if (this.selectedPath === path && this.hasItemStop(path, item.itemId)) {
        this.setCursor({ path, itemId: item.itemId });
      }
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
}
