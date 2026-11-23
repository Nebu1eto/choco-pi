import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { bool, compile, int, obj, opt, type Static } from "@earendil-works/pi-schema";
import type { RuntimeValue } from "../../lib/runtime-values.ts";
import type { DiffClock } from "../../lib/changes/git/clock.ts";
import { DEFAULT_PANE_WIDTH } from "../host/geometry.ts";

const PanePrefsSchema = obj(
  {
    version: int({ minimum: 1, maximum: 1 }),
    width: int({ minimum: 1, maximum: 10_000 }),
    open: opt(bool()),
  },
  { open: true },
);
const isPanePrefsFile = compile(PanePrefsSchema).check;

export type PanePrefsFile = Static<typeof PanePrefsSchema>;
export type PanePrefs = { width: number };

export const DEFAULT_PANE_PREFS: PanePrefs = {
  width: DEFAULT_PANE_WIDTH,
};
export const PREFS_DEBOUNCE_MS = 200;

export function prefsPath(agentDir: string): string {
  return join(agentDir, "choco-pi", "diff-pane.json");
}

export type PrefsIo = {
  read(path: string): Promise<string | undefined>;
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

export function parsePrefs(text: string): PanePrefs | undefined {
  let value: RuntimeValue;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isPanePrefsFile(value)) return undefined;
  return { width: value.width };
}

export function serializePrefs(prefs: PanePrefs): string {
  const file: PanePrefsFile = { version: 1, width: Math.floor(prefs.width) };
  return `${JSON.stringify(file)}\n`;
}

export type PrefsStore = {
  load(): Promise<PanePrefs>;
  save(prefs: PanePrefs): void;
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
