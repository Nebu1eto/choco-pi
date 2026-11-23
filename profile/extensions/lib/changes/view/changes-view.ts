import { Input, matchesKey } from "@earendil-works/pi-tui";
import { actionFor } from "./keys.ts";
import { KEYBOARD_RESIZE_STEP, type PaneSurface, type PointerGesture } from "./surface.ts";
import { hunkRangeText } from "../references.ts";
import { isSensitiveFile } from "../sensitive.ts";
import { cursorRows, selectedLineIndexes, type CursorRow } from "./line-cursor.ts";
import type { AskTarget } from "./changes-view-state.ts";
import { ChangesViewNavigation } from "./navigation.ts";
export type { CommentPlacement, PaneComment } from "./items.ts";
export {
  findingKey,
  HIDDEN_CONTENTS,
  normalizeFindingPath,
  renderUnifiedBody,
  terminalSafeFile,
  type AskTarget,
  type BodyLayout,
  type ChangesViewOptions,
  type FileBodyRenderer,
  type PaneActions,
  type RowDetail,
  type ViewStore,
} from "./changes-view-state.ts";

export class ChangesView extends ChangesViewNavigation implements PaneSurface {
  rowTarget(row: number): CursorRow | undefined {
    for (const entry of this.blockRows) {
      const offset = row - entry.start;
      if (offset >= 0 && offset < entry.block.lines.length) return entry.block.stops?.[offset];
    }
    return undefined;
  }

  protected lineRows(path: string, hunkId: string): Array<{ row: number; lineIndex: number }> {
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

  protected dragTo(row: number): boolean {
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

  pointer(gesture: PointerGesture): boolean {
    if (this.noteInput || this.disposed) return false;
    const pinned = this.pinned.find((pin) => pin.row === gesture.row);
    if (pinned && gesture.kind !== "drag") {
      if (gesture.kind !== "click") return false;
      const index = this.files().findIndex((file) => file.path === pinned.path);
      if (index < 0) return false;
      if (!this.options.keepMessages) this.message = undefined;
      if (pinned.hunkId === undefined) this.select(index);
      else {
        const header = { path: pinned.path, hunkId: pinned.hunkId };
        this.setCursor(this.options.hunkStops ? header : { ...header, lineIndex: 0 });
      }
      this.actions.requestRender();
      return true;
    }
    const line = this.cursorMode === "line";
    if (gesture.kind === "drag") {
      if (!line) return false;
      if (this.dragTo(gesture.row)) this.actions.requestRender();
      return true;
    }
    const target = this.rowTarget(gesture.row);
    if (!target) return false;
    if (target.itemId !== undefined) {
      if (gesture.kind !== "click") return false;
      if (!this.options.keepMessages) this.message = undefined;
      this.setCursor({ path: target.path, itemId: target.itemId });
      this.toggleItem(target.itemId);
      this.actions.requestRender();
      return true;
    }
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
      const header = { path: target.path, hunkId: target.hunkId };
      const stop =
        !line ||
        cursorRows(this.cursorFiles()).some(
          (row) =>
            row.path === header.path && row.hunkId === header.hunkId && row.lineIndex === undefined,
        );
      this.setCursor(stop ? header : { ...header, lineIndex: 0 });
      if (line && this.options.hunkStops && stop) this.toggleHunk(header.hunkId);
    }
    this.actions.requestRender();
    return true;
  }

  protected startNote(): void {
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

  protected reveal(): void {
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

  protected cursorTarget(): AskTarget | undefined {
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

  protected withTarget(action: ((target: AskTarget) => void) | undefined): void {
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
        if (this.selectedItem !== undefined) this.toggleItem(this.selectedItem);
        else if (line && this.options.enterFolds !== false) this.toggleLine();
        else {
          const header = line ? this.headerHunkId() : undefined;
          if (header !== undefined) this.toggleHunk(header);
          else this.toggleExpanded();
        }
        break;
      case "toggleItems":
        this.toggleFileItems();
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
