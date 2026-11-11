/**
 * Pane preferences: whether the pane was open, its width, and whether it may
 * open by itself when the agent changes code (`autoOpen`, on by default).
 *
 * Stored as `<agentDir>/choco-pi/diff-pane.json`. The file is user state in
 * the agent directory, not a tracked `.pi/extensions/*.json` sidecar, so the
 * install profile neither links nor migrates it. A file that fails to parse
 * or validate is ignored and rewritten with the defaults. Writes are debounced
 * and atomic (temporary file, then rename).
 *
 * `autoOpen` is optional and written only when off, so a file from before it
 * existed still loads (as on), and an unknown key or a non-boolean `autoOpen`
 * falls back to the default instead of discarding the open state and width.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { bool, compile, int, obj, type Static } from "@earendil-works/pi-schema";
import type { RuntimeValue } from "../../lib/runtime-values.ts";
import type { DiffClock } from "../../lib/changes/git/clock.ts";
import { DEFAULT_PANE_WIDTH } from "../host/geometry.ts";

const PanePrefsSchema = obj(
  {
    version: int({ minimum: 1, maximum: 1 }),
    open: bool(),
    width: int({ minimum: 1, maximum: 10_000 }),
  },
  { open: true },
);
const isPanePrefsFile = compile(PanePrefsSchema).check;

export type PanePrefsFile = Static<typeof PanePrefsSchema> & { autoOpen?: boolean };
export type PanePrefs = { open: boolean; width: number; autoOpen: boolean };

export const DEFAULT_PANE_PREFS: PanePrefs = {
  open: false,
  width: DEFAULT_PANE_WIDTH,
  autoOpen: true,
};
export const PREFS_DEBOUNCE_MS = 200;

export function prefsPath(agentDir: string): string {
  return join(agentDir, "choco-pi", "diff-pane.json");
}

/** File access seam; tests replace it with an in-memory map. */
export type PrefsIo = {
  /** File contents, or undefined when the file does not exist. */
  read(path: string): Promise<string | undefined>;
  /** Replace the file atomically. */
  write(path: string, contents: string): Promise<void>;
};

function isMissingFile(error: Error): boolean {
  return "code" in error && error.code === "ENOENT";
}

export const fileSystemPrefsIo: PrefsIo = {
  async read(path) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error instanceof Error && isMissingFile(error)) return undefined;
      throw error;
    }
  },
  async write(path, contents) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  },
};

/** Parse stored text; undefined when it is not a valid preferences file. */
export function parsePrefs(text: string): PanePrefs | undefined {
  let value: RuntimeValue;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isPanePrefsFile(value)) return undefined;
  // Only an explicit false turns automatic opening off.
  const autoOpen = !("autoOpen" in value && value.autoOpen === false);
  return { open: value.open, width: value.width, autoOpen };
}

export function serializePrefs(prefs: PanePrefs): string {
  const file: PanePrefsFile = { version: 1, open: prefs.open, width: Math.floor(prefs.width) };
  if (!prefs.autoOpen) file.autoOpen = false;
  return `${JSON.stringify(file)}\n`;
}

export type PrefsStore = {
  load(): Promise<PanePrefs>;
  /** Debounced write of the latest preferences. */
  save(prefs: PanePrefs): void;
  /** Cancel the debounce timer and start any pending write now. */
  flush(): Promise<void>;
};

export function createPrefsStore(path: string, io: PrefsIo, clock: DiffClock): PrefsStore {
  let pending: PanePrefs | undefined;
  let timer: ReturnType<DiffClock["setTimeout"]> | undefined;
  let chain: Promise<void> = Promise.resolve();

  function startWrite(): Promise<void> {
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
    const prefs = pending;
    pending = undefined;
    if (!prefs) return chain;
    const contents = serializePrefs(prefs);
    // A failed write leaves the previous file; the next change retries.
    chain = chain.then(() => io.write(path, contents)).catch(() => undefined);
    return chain;
  }

  const store: PrefsStore = {
    async load() {
      let text: string | undefined;
      try {
        text = await io.read(path);
      } catch {
        return { ...DEFAULT_PANE_PREFS };
      }
      if (text === undefined) return { ...DEFAULT_PANE_PREFS };
      const prefs = parsePrefs(text);
      if (prefs) return prefs;
      store.save({ ...DEFAULT_PANE_PREFS });
      return { ...DEFAULT_PANE_PREFS };
    },
    save(prefs) {
      pending = { ...prefs };
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = clock.setTimeout(() => {
        timer = undefined;
        void startWrite();
      }, PREFS_DEBOUNCE_MS);
    },
    flush: startWrite,
  };
  return store;
}
