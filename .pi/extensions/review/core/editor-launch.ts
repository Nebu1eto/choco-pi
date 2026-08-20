import { spawn as nodeSpawn } from "node:child_process";
import type { EditorConfig } from "./types.ts";

export type EditorLocation = {
  path: string;
  line: number;
  column?: number;
  dir: string;
};

export type EditorSpawnOptions = {
  cwd: string;
  detached?: boolean;
  stdio: "ignore" | "inherit";
};

export type SpawnedEditor = {
  once(event: "spawn", listener: () => void): SpawnedEditor;
  once(event: "error", listener: (error: Error) => void): SpawnedEditor;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): SpawnedEditor;
  unref(): void;
};

export type SpawnEditor = (
  command: string,
  args: readonly string[],
  options: EditorSpawnOptions,
) => SpawnedEditor;

export type TuiLifecycle = {
  stop(): void;
  start(): void;
  requestRender(force?: boolean): void;
};

export type ResolvedEditorCommand = {
  command: string;
  args: string[];
};

const TOKENS = /\{(?:path|line|column|dir)\}/g;

/** Substitute every supported token, including tokens embedded inside an argument. */
export function resolveEditorCommand(
  config: EditorConfig,
  location: EditorLocation,
): ResolvedEditorCommand {
  if (config.command.length === 0) throw new Error("Editor command must not be empty.");
  if (!Number.isInteger(location.line) || location.line < 1)
    throw new Error("Editor line must be a positive integer.");
  const column = location.column ?? 1;
  if (!Number.isInteger(column) || column < 1)
    throw new Error("Editor column must be a positive integer.");
  const values: Record<string, string> = {
    "{path}": location.path,
    "{line}": String(location.line),
    "{column}": String(column),
    "{dir}": location.dir,
  };
  const substituted = config.command.map((part) => part.replace(TOKENS, (token) => values[token]!));
  return { command: substituted[0]!, args: substituted.slice(1) };
}

function waitForSpawn(child: SpawnedEditor): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function waitForExit(child: SpawnedEditor): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else
        reject(
          new Error(
            signal
              ? `Editor exited after signal ${signal}.`
              : `Editor exited with status ${String(code)}.`,
          ),
        );
    });
  });
}

const defaultSpawn: SpawnEditor = (command, args, options) =>
  nodeSpawn(command, [...args], options) as SpawnedEditor;

/**
 * Launch a configured editor. Terminal editors always restore and redraw the
 * TUI, whether spawning fails or the editor exits unsuccessfully.
 */
export async function launchEditor(
  config: EditorConfig,
  location: EditorLocation,
  tui: TuiLifecycle,
  spawnEditor: SpawnEditor = defaultSpawn,
): Promise<void> {
  const resolved = resolveEditorCommand(config, location);
  if (config.mode === "gui") {
    const child = spawnEditor(resolved.command, resolved.args, {
      cwd: location.dir,
      detached: true,
      stdio: "ignore",
    });
    await waitForSpawn(child);
    child.unref();
    return;
  }

  tui.stop();
  try {
    const child = spawnEditor(resolved.command, resolved.args, {
      cwd: location.dir,
      stdio: "inherit",
    });
    await waitForExit(child);
  } finally {
    tui.start();
    tui.requestRender(true);
  }
}

/** Open the review root using the same editor template and lifecycle rules. */
export function launchEditorProject(
  config: EditorConfig,
  dir: string,
  tui: TuiLifecycle,
  spawnEditor: SpawnEditor = defaultSpawn,
): Promise<void> {
  return launchEditor(config, { path: dir, line: 1, column: 1, dir }, tui, spawnEditor);
}
