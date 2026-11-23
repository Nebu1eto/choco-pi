import type { DiffSource, DiffStore, FileBody, FileSummary } from "../../lib/changes/git/model.ts";
import { plural } from "../../lib/changes/view/rows.ts";
import type { DiffHunk } from "../../lib/changes/types.ts";
import type { RuntimeValue } from "../../lib/runtime-values.ts";
import { NotesBook, noteStatus, type DiffNote } from "../../lib/changes/notes.ts";
import type { AskTarget } from "./pane-view.ts";
import {
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
import { type Session, type DiffPaneController, errorText } from "./pane-state.ts";
import { ensureStore, say, reportFailure, insertIntoEditor } from "./pane-session.ts";

export function mentionFor(pane: DiffPaneController, session: Session, path: string): string {
  const state = session.store?.getState();
  const root = state?.kind === "ready" ? state.snapshot.repoRoot : session.ctx.cwd;
  return fileMention(editorPath(root, session.ctx.cwd, path));
}

export function ask(pane: DiffPaneController, session: Session, target: AskTarget): void {
  const mention = mentionFor(pane, session, target.file.path);
  const sensitive = isSensitiveFile(target.file);
  const hunk: DiffHunk | undefined = target.hunk;
  if (!hunk) {
    insertIntoEditor(pane, session, mention);
    say(
      pane,
      session,
      sensitive
        ? `Sensitive file: only its path is in the editor. Type your question.`
        : "File reference added to the editor. Type your question; nothing was sent.",
      sensitive ? "warning" : "muted",
    );
    return;
  }
  const lines = target.lines;
  const shown = session.source;
  const context =
    shown.kind === "range" && shown.turnOnly
      ? `as the file was after ${shown.label}; it may have changed since`
      : undefined;
  const reference = lines
    ? linesReference(mention, hunk, lines, sensitive, context)
    : hunkReference(mention, hunk, sensitive, context);
  insertIntoEditor(pane, session, reference.text);
  if (sensitive) {
    say(
      pane,
      session,
      "Sensitive file: only its path was put in the editor, never its contents.",
      "warning",
    );
  } else if (!reference.includesContent) {
    say(
      pane,
      session,
      `The ${lines ? "selection" : "hunk"} is longer than 60 lines, so only its range was inserted.`,
      "warning",
    );
  } else {
    say(
      pane,
      session,
      `${lines ? "Selected lines" : "Hunk"} added to the editor. Type your question; nothing was sent.`,
    );
  }
}

export function copy(pane: DiffPaneController, session: Session, target: AskTarget): void {
  const hunk = target.hunk;
  if (!hunk) {
    say(pane, session, "Nothing to copy on a file's row: move to a line or a hunk with ↑/↓ first.");
    return;
  }
  const write = pane.deps.copyText;
  if (!write) {
    say(pane, session, "Copying is not available here.", "warning");
    return;
  }
  const lines = target.lines;
  const text = clipboardText(hunk, lines);
  const copied = lines
    ? `Copied ${plural(lines.last - lines.first + 1, "line")}.`
    : `Copied the hunk as a diff (${plural(hunk.lines.length, "line")}).`;
  void (async () => {
    await write(text);
    if (session.alive) say(pane, session, copied);
  })().catch((error: RuntimeValue) =>
    reportFailure(pane, session, `Cannot copy to the clipboard: ${errorText(error)}`, error),
  );
}

export function notesFor(pane: DiffPaneController, session: Session): NotesBook {
  if (session.notes) return session.notes;
  const book = new NotesBook({
    io: pane.deps.notesIo,
    file: pane.deps.notesIo ? pane.deps.notesFile?.(session.ctx) : undefined,
    onChange: () => {
      if (!session.alive) return;
      try {
        session.view?.invalidate();
        session.host?.requestRender();
      } catch (error) {
        reportFailure(pane, session, `Cannot redraw the diff pane: ${errorText(error)}`, error);
      }
    },
  });
  session.notes = book;
  if (session.view) session.view.notes = book;
  void book
    .load()
    .catch((error: RuntimeValue) =>
      reportFailure(pane, session, `Cannot read the diff notes: ${errorText(error)}`, error),
    );
  return book;
}

export function addNote(
  pane: DiffPaneController,
  session: Session,
  file: FileSummary,
  hunk: DiffHunk,
  text: string,
): void {
  notesFor(pane, session).add({
    path: file.path,
    hunk,
    range: hunkRangeText(hunk),
    text,
    now: pane.deps.clock.now(),
  });
  say(
    pane,
    session,
    `Note added on ${file.path} ${hunkRangeText(hunk)}. Press a to put the notes in the editor.`,
  );
}

export async function noteHunks(
  pane: DiffPaneController,
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

export async function sendNotes(pane: DiffPaneController, session: Session): Promise<void> {
  const book = notesFor(pane, session);
  await book.load();
  if (!session.alive) return;
  const read = book.notes;
  if (read.length === 0) {
    say(pane, session, "No notes yet: select a hunk (n/N) and press c.", "warning");
    return;
  }
  const store = ensureStore(pane, session);
  const loaded = await noteHunks(pane, session, store, read);
  if (!loaded) return;
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
    const status = noteStatus(note, file !== undefined, hunks.get(note.path));
    return {
      mention: mentionFor(pane, session, note.path),
      range: status.kind === "current" ? hunkRangeText(status.hunk) : note.range,
      outdated: status.kind !== "current",
      text: note.text,
    };
  });
  insertIntoEditor(pane, session, notesMessage(entries));
  book.remove(notes);
  say(
    pane,
    session,
    `${plural(entries.length, "note")} put in the editor and cleared from the pane; nothing was sent.`,
  );
}

export async function clearNotes(pane: DiffPaneController, session: Session): Promise<void> {
  const book = notesFor(pane, session);
  await book.load();
  if (!session.alive) return;
  const count = book.clear();
  say(
    pane,
    session,
    count === 0 ? "No notes to clear." : `Cleared ${count === 1 ? "1 note" : `${count} notes`}.`,
  );
}

export function startReview(pane: DiffPaneController, session: Session): void {
  const state = session.store?.getState();
  let source: DiffSource = state?.kind === "ready" ? state.snapshot.source : session.source;
  if (state?.kind === "ready" && source.kind === "session") {
    const baseline = state.snapshot.baseline;
    if (baseline?.kind === "checkpoint") {
      source = {
        kind: "since-checkpoint",
        checkpointId: state.snapshot.base,
        label: baseline.label,
      };
    }
  }
  insertIntoEditor(pane, session, reviewInstruction(source));
  say(pane, session, "Review instruction put in the editor; edit it and press Enter to start.");
}
