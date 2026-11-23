import { join } from "node:path";
import { arr, compile, int, obj, str, type Static } from "@earendil-works/pi-schema";
import { anchorStatus, type AnchorStatus } from "./annotations.ts";
import type { DiffHunk } from "./types.ts";
import type { RuntimeValue } from "../runtime-values.ts";

export type NotesIo = {
  read(path: string): Promise<string | undefined>;
  write(path: string, contents: string): Promise<void>;
};

const NoteSchema = obj({
  id: str({ minLength: 1 }),
  path: str({ minLength: 1 }),
  hunkId: str({ minLength: 1 }),
  range: str(),
  text: str({ minLength: 1 }),
  createdAt: int({ minimum: 0 }),
});
const NotesFileSchema = obj({
  version: int({ minimum: 1, maximum: 1 }),
  notes: arr(NoteSchema),
});
const isNotesFile = compile(NotesFileSchema).check;

export type DiffNote = Static<typeof NoteSchema>;

export type NoteStatus = AnchorStatus<DiffHunk>;

export function notesFilePath(scratchDir: string, sessionId: string): string {
  const safe = sessionId.replaceAll(/[^A-Za-z0-9_.-]/gu, "_");
  return join(scratchDir, "diff-notes", `${safe}.json`);
}

export function noteStatus(
  note: DiffNote,
  listed: boolean,
  hunks: readonly DiffHunk[] | undefined,
): NoteStatus {
  return anchorStatus(note.hunkId, listed, hunks);
}

export class NotesBook {
  notes: DiffNote[] = [];
  version = 0;
  private sequence = 0;
  private readonly io: NotesIo | undefined;
  private readonly file: string | undefined;
  private loaded: Promise<void> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private readonly onChange: () => void;

  constructor(options: { io?: NotesIo; file?: string; onChange?: () => void } = {}) {
    this.io = options.io;
    this.file = options.file;
    this.onChange = options.onChange ?? (() => {});
  }

  load(): Promise<void> {
    this.loaded ??= this.readFile();
    return this.loaded;
  }

  private async readFile(): Promise<void> {
    const io = this.io;
    const file = this.file;
    if (!io || !file) return;
    let text: string | undefined;
    try {
      text = await io.read(file);
    } catch {
      return;
    }
    if (text === undefined) return;
    let parsed: RuntimeValue;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!isNotesFile(parsed)) return;
    const known = new Set(this.notes.map((note) => note.id));
    const restored = parsed.notes.filter((note) => !known.has(note.id));
    if (restored.length === 0) return;
    const rewrite = this.notes.length > 0;
    this.notes = [...restored, ...this.notes];
    this.changed(rewrite);
  }

  forPath(path: string): DiffNote[] {
    return this.notes.filter((note) => note.path === path);
  }

  add(input: { path: string; hunk: DiffHunk; range: string; text: string; now: number }): DiffNote {
    this.sequence += 1;
    const note: DiffNote = {
      id: `${input.now.toString(36)}-${this.sequence}`,
      path: input.path,
      hunkId: input.hunk.id,
      range: input.range,
      text: input.text,
      createdAt: Math.max(0, Math.floor(input.now)),
    };
    this.notes = [...this.notes, note];
    this.changed(true);
    return note;
  }

  clear(): number {
    const count = this.notes.length;
    if (count === 0) return 0;
    this.notes = [];
    this.changed(true);
    return count;
  }

  remove(notes: readonly DiffNote[]): void {
    const gone = new Set(notes.map((note) => note.id));
    const kept = this.notes.filter((note) => !gone.has(note.id));
    if (kept.length === this.notes.length) return;
    this.notes = kept;
    this.changed(true);
  }

  flush(): Promise<void> {
    return this.chain;
  }

  private changed(persist: boolean): void {
    this.version += 1;
    if (persist) this.persist();
    this.onChange();
  }

  private persist(): void {
    const io = this.io;
    const file = this.file;
    if (!io || !file) return;
    const contents = `${JSON.stringify({ version: 1, notes: this.notes })}\n`;
    this.chain = this.chain.then(() => io.write(file, contents)).catch(() => undefined);
  }
}
