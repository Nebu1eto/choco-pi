/**
 * Moving through the changes view: files, hunks, findings and comments, the
 * line cursor with its Shift selection, folds, and search matches.
 */
import type { FileSummary } from "../git/model.ts";
import type { DiffHunk } from "../types.ts";
import {
  currentCommentPosition,
  cursorRows,
  extendSelection,
  moveLine,
  type CommentPosition,
  type CursorItem,
  type CursorFile,
  type LineCursor,
  type LineTarget,
} from "./line-cursor.ts";
import { ChangesViewBlocks } from "./file-block-renderer.ts";

export abstract class ChangesViewNavigation extends ChangesViewBlocks {
  /* ------------------------------------------------------- navigation */

  select(index: number): void {
    const files = this.files();
    if (files.length === 0) return;
    this.selectedIndex = Math.max(0, Math.min(index, files.length - 1));
    this.selectedPath = files[this.selectedIndex]?.path;
    this.selectedHunk = undefined;
    this.selectedItem = undefined;
    this.clearLine();
    this.keepSelectionVisible();
  }

  toggleExpanded(): void {
    const path = this.selectedPath;
    if (path === undefined) return;
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
      this.selectedItem = undefined;
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

  /**
   * f/F: the next or previous finding or comment on a listed file, in
   * display order, wrapping at the ends. With the cursor off every item, the
   * first one in or after the cursor's file (F: in or before it). Its file
   * expands; an item of a loading body gets the cursor when the body arrives.
   */
  moveFinding(direction: 1 | -1): void {
    const entries: Array<{ path: string; itemId: string; fileIndex: number }> = [];
    this.files().forEach((file, fileIndex) => {
      for (const entry of this.fileItems(file).items) {
        entries.push({ path: file.path, itemId: entry.item.id, fileIndex });
      }
    });
    if (entries.length === 0) {
      const elsewhere = this.recorded.findings.length > 0 || this.comments.length > 0;
      this.setMessage(
        elsewhere
          ? "No findings or comments on files in this diff; see the list at the bottom."
          : "No recorded review findings.",
      );
      return;
    }
    const count = entries.length;
    const at = entries.findIndex(
      (entry) => entry.itemId === this.selectedItem && entry.path === this.selectedPath,
    );
    let next: number;
    if (at >= 0) next = (at + direction + count) % count;
    else if (direction > 0) {
      next = Math.max(
        0,
        entries.findIndex((entry) => entry.fileIndex >= this.selectedIndex),
      );
    } else {
      const before = entries.filter((entry) => entry.fileIndex <= this.selectedIndex).length;
      next = before > 0 ? before - 1 : count - 1;
    }
    const target = entries[next];
    if (target) this.goToItem(target.path, target.itemId);
  }

  /** Put the cursor on an item: its file expands; a loading body is awaited. */
  goToItem(path: string, itemId: string): void {
    const index = this.files().findIndex((file) => file.path === path);
    if (index < 0) return;
    this.expand(path);
    if (this.hasItemStop(path, itemId)) {
      this.pendingItem = undefined;
      this.setCursor({ path, itemId });
      return;
    }
    this.pendingItem = { path, itemId };
    this.setCursor({ path });
  }

  /** True when the cursor can land on the item now (its file is open and placed). */
  protected hasItemStop(path: string, itemId: string): boolean {
    const file = this.cursorFiles().find((entry) => entry.path === path);
    return file !== undefined && cursorRows([file]).some((row) => row.itemId === itemId);
  }

  /** Open or close one finding or comment; the cursor stays on it. */
  toggleItem(itemId: string): void {
    this.itemOpen.set(itemId, !this.isItemOpen(itemId));
    this.keepSelectionVisible();
  }

  /** e: close every finding and comment of the cursor's file when all are open; else open them all. */
  toggleFileItems(): void {
    const path = this.selectedPath;
    const ids = this.itemIds(path);
    if (ids.length === 0) {
      this.setMessage("No findings or comments on this file.");
      return;
    }
    const open = !ids.every((id) => this.isItemOpen(id));
    for (const id of ids) this.itemOpen.set(id, open);
    this.keepSelectionVisible();
  }

  protected keepSelectionVisible(): void {
    const scroller = this.scroller;
    if (!scroller || this.lastWidth <= 0) return;
    this.renderBody(this.lastWidth, true);
    const height = scroller.viewportHeight();
    if (height <= 0) return;
    const top = scroller.top();
    const line = this.selectedLine;
    // The pinned rows at the top cover the rows under them: keep the line below them.
    const covered = this.pinning ? this.pinnedRowCount(top, height) : 0;
    if (line < top + covered) {
      scroller.scrollTo(this.pinning ? this.topShowing(line, height) : line);
    } else if (this.selectedLine >= top + height) scroller.scrollTo(this.selectedLine - height + 1);
  }

  protected page(): number {
    return Math.max(1, (this.scroller?.viewportHeight() ?? 10) - 1);
  }

  /* ------------------------------------------------------ line cursor */

  /**
   * Select a hunk; the line cursor starts on its first displayed line unless
   * it is folded or its header is a stop.
   */
  protected enterHunk(path: string, hunk: DiffHunk): void {
    this.selectedHunk = { path, hunkId: hunk.id };
    this.selectedItem = undefined;
    this.anchorLine = undefined;
    this.cursorLine =
      this.cursorMode === "line" &&
      !this.options.hunkStops &&
      !this.foldedHunks.has(hunk.id) &&
      hunk.lines.length > 0
        ? 0
        : undefined;
  }

  protected clearLine(): void {
    this.cursorLine = undefined;
    this.anchorLine = undefined;
  }

  /** Where the line cursor is; undefined with nothing listed. */
  lineCursor(): LineCursor | undefined {
    const path = this.selectedPath;
    if (path === undefined) return undefined;
    const cursor: LineCursor = { path };
    if (this.selectedItem !== undefined) {
      cursor.itemId = this.selectedItem;
      return cursor;
    }
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

  protected cursorFiles(): CursorFile[] {
    return this.files().map((file) => {
      const expanded = this.expanded.has(file.path);
      const shown = this.canShowContents(file);
      const cursorFile: CursorFile = {
        path: file.path,
        open: expanded && shown,
        hunks: this.displayHunks(file),
        folded: (hunkId) => this.foldedHunks.has(hunkId),
        hunkStops: this.options.hunkStops === true,
      };
      const items: CursorItem[] = this.fileItems(file).items.map((entry) => ({
        id: entry.item.id,
        place: entry.place,
      }));
      if (items.length > 0) cursorFile.items = items;
      // A hidden file's body lists its items under the hidden notice.
      if (expanded && !shown) cursorFile.itemsOnly = true;
      return cursorFile;
    });
  }

  /** Put the line cursor at `cursor` (a listed path) and keep it visible. */
  setCursor(cursor: LineCursor | undefined): void {
    if (!cursor) return;
    const index = this.files().findIndex((file) => file.path === cursor.path);
    if (index < 0) return;
    this.selectedIndex = index;
    this.selectedPath = cursor.path;
    this.selectedItem = cursor.itemId;
    if (cursor.itemId !== undefined || cursor.hunkId === undefined) {
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
      // Where headers are stops (the pane), the cursor stays on the header it folded from.
      this.cursorLine = folded || this.options.hunkStops ? undefined : 0;
    }
    this.invalidate();
  }

  /** Fold or unfold a hunk and keep the cursor in view. */
  protected toggleHunk(hunkId: string): void {
    this.setFolded(hunkId, !this.foldedHunks.has(hunkId));
    this.keepSelectionVisible();
  }

  /** The hunk whose header (or folded placeholder) the line cursor is on, not a line or item. */
  protected headerHunkId(): string | undefined {
    const hunk = this.selectedHunk;
    const onHeader =
      hunk !== undefined &&
      hunk.path === this.selectedPath &&
      this.selectedItem === undefined &&
      this.cursorLine === undefined;
    return onHeader ? hunk.hunkId : undefined;
  }

  /** Enter/space with the line cursor: fold the cursor's hunk, or expand its file row. */
  protected toggleLine(): void {
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
}
