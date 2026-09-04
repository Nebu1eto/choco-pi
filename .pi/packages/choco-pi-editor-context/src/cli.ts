import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createEditorContextStore, type EditorContextStore } from "./context-store.ts";
import {
  canonicalizeCwd,
  createContextTargetStore,
  type ContextTargetStore,
} from "./context-target.ts";
import {
  canonicalCwdMatches,
  createLiveSessionClient,
  HEARTBEAT_STALE_MS,
  parseLiveState,
  readJson,
  type LiveSessionClient,
  type LiveSessionState,
} from "./live-session-client.ts";
import type { EditorContextDocument } from "./protocol.ts";
import { DEFAULT_SELECTION_TEXT_BYTES, validateEditorContextDocument } from "./security.ts";

const DEFAULT_CONTEXT_TTL_MS = 30_000;
const MAX_LISTED_SESSIONS = 20;
const MAX_OUTPUT_CHARS = 4_096;
const NO_SELECTION_ENV = "CHOCO_PI_EDITOR_CONTEXT_NO_SELECTION";

type Output = (line: string) => void;

export interface EditorContextCliDependencies {
  liveClient?: LiveSessionClient;
  store?: EditorContextStore;
  now?: () => number;
  output?: Output;
  readSelectionFile?: (path: string) => Promise<string>;
  environment?: Readonly<Record<string, string | undefined>>;
  targetStore?: ContextTargetStore;
  pidAlive?: (pid: number) => boolean;
  commandPath?: string;
  cliPath?: string;
}

type ParsedArguments = Readonly<{
  command: string | undefined;
  values: ReadonlyMap<string, string>;
  flags: ReadonlySet<string>;
}>;

function bounded(value: string): string {
  const singleLine = value.replaceAll("\r", " ").replaceAll("\n", " ");
  return singleLine.length <= MAX_OUTPUT_CHARS
    ? singleLine
    : `${singleLine.slice(0, MAX_OUTPUT_CHARS - 1)}…`;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const command = argv[0];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith("--")) throw new Error("INVALID_ARGUMENT");
    if (
      argument === "--dry-run" ||
      argument === "--zero-based-position" ||
      argument === "--clear" ||
      argument === "--no-selection-text"
    ) {
      flags.add(argument);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error("MISSING_ARGUMENT_VALUE");
    values.set(argument, value);
    index += 1;
  }
  return { command, values, flags };
}

function required(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`MISSING_${name.slice(2).replaceAll("-", "_").toUpperCase()}`);
  return value;
}

function optionalPositiveInteger(
  values: ReadonlyMap<string, string>,
  name: string,
): number | undefined {
  const raw = values.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`INVALID_${name.slice(2).toUpperCase()}`);
  return value;
}

function optionalPosition(
  values: ReadonlyMap<string, string>,
  name: string,
  zeroBased: boolean,
): number | undefined {
  if (!zeroBased) return optionalPositiveInteger(values, name);
  const raw = values.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER) {
    throw new Error(`INVALID_${name.slice(2).toUpperCase()}`);
  }
  return value + 1;
}

async function defaultReadSelectionFile(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(DEFAULT_SELECTION_TEXT_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function shellToken(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sessionSummary(
  state: LiveSessionState,
  cwd: string,
  commandPath: string,
  cliPath: string,
): string {
  const command = [
    commandPath,
    cliPath,
    "select",
    "--session-id",
    state.sessionId,
    "--owner-id",
    state.ownerId,
    "--cwd",
    cwd,
  ]
    .map(shellToken)
    .join(" ");
  return bounded(
    `${command} # status=${state.status} model=${JSON.stringify(state.model ?? "unknown")}`,
  );
}

async function matchingSessions(
  liveClient: LiveSessionClient,
  cwd: string,
): Promise<LiveSessionState[]> {
  const states = await liveClient.listLiveStates();
  const matches = await Promise.all(
    states.map(async (state) => ((await canonicalCwdMatches(cwd, state.cwd)) ? state : undefined)),
  );
  return matches
    .filter((state): state is LiveSessionState => state !== undefined)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

async function runList(
  parsed: ParsedArguments,
  liveClient: LiveSessionClient,
  output: Output,
  commandPath: string,
  cliPath: string,
): Promise<number> {
  const cwdValue = required(parsed.values, "--cwd");
  if (!isAbsolute(cwdValue)) throw new Error("PATH_NOT_ABSOLUTE");
  const cwd = resolve(cwdValue);
  const matches = await matchingSessions(liveClient, cwd);
  output(`Matching live sessions: ${matches.length}`);
  for (const state of matches.slice(0, MAX_LISTED_SESSIONS)) {
    output(sessionSummary(state, cwd, commandPath, cliPath));
  }
  if (matches.length > MAX_LISTED_SESSIONS) {
    output(`Additional matches omitted: ${matches.length - MAX_LISTED_SESSIONS}`);
  }
  return matches.length === 0 ? 1 : 0;
}

async function currentLiveState(
  liveClient: LiveSessionClient,
  sessionId: string,
  ownerId: string,
  cwd: string | undefined,
  now: () => number,
  pidAlive: (pid: number) => boolean,
): Promise<LiveSessionState> {
  const exactState = parseLiveState(await readJson(liveClient.liveStatePath(sessionId, ownerId)));
  const state = exactState ?? (await liveClient.readLiveState(sessionId));
  if (!state) throw new Error("LIVE_SESSION_NOT_FOUND");
  if (state.ownerId !== ownerId) throw new Error("LIVE_OWNER_MISMATCH");
  if (cwd !== undefined && !(await canonicalCwdMatches(cwd, state.cwd))) {
    throw new Error("LIVE_CWD_MISMATCH");
  }
  const heartbeatFresh = now() - Date.parse(state.updatedAt) <= HEARTBEAT_STALE_MS;
  if (!heartbeatFresh && !pidAlive(state.pid)) throw new Error("LIVE_SESSION_STALE");
  return state;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // SAFETY: Caught process.kill failures are inspected only through Node's optional errno code.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isStaleTargetError(message: string | undefined): boolean {
  if (message === undefined) return false;
  return new Set([
    "LIVE_SESSION_NOT_FOUND",
    "LIVE_OWNER_MISMATCH",
    "LIVE_CWD_MISMATCH",
    "LIVE_SESSION_STALE",
    "TARGET_CWD_MISMATCH",
  ]).has(message);
}

async function resolvePublishTarget(
  values: ReadonlyMap<string, string>,
  liveClient: LiveSessionClient,
  targetStore: ContextTargetStore,
  cwd: string,
  now: () => number,
  pidAlive: (pid: number) => boolean,
  output: Output,
): Promise<LiveSessionState> {
  const sessionId = values.get("--session-id");
  const ownerId = values.get("--owner-id");
  if ((sessionId === undefined) !== (ownerId === undefined)) {
    throw new Error("LIVE_TARGET_REQUIRES_SESSION_ID_AND_OWNER_ID");
  }
  if (sessionId !== undefined && ownerId !== undefined) {
    return currentLiveState(liveClient, sessionId, ownerId, undefined, now, pidAlive);
  }

  const persisted = await targetStore.read(cwd);
  if (persisted !== undefined) {
    try {
      if (!(await canonicalCwdMatches(cwd, persisted.cwd))) throw new Error("TARGET_CWD_MISMATCH");
      return await currentLiveState(
        liveClient,
        persisted.sessionId,
        persisted.ownerId,
        cwd,
        now,
        pidAlive,
      );
    } catch (error) {
      if (!isStaleTargetError(error instanceof Error ? error.message : undefined)) throw error;
      await targetStore.clear(cwd);
      output("TARGET_STALE_CLEARED");
    }
  }

  const matches = await matchingSessions(liveClient, cwd);
  const [match, additionalMatch] = matches;
  if (match === undefined) throw new Error("LIVE_TARGET_NOT_FOUND");
  if (additionalMatch !== undefined) {
    throw new Error(
      "LIVE_TARGET_AMBIGUOUS: run Choco Pi: List Live Sessions, then run the printed select command in Zed's terminal.",
    );
  }
  return match;
}

async function runSelect(
  parsed: ParsedArguments,
  liveClient: LiveSessionClient,
  targetStore: ContextTargetStore,
  now: () => number,
  pidAlive: (pid: number) => boolean,
  output: Output,
): Promise<number> {
  const cwdValue = required(parsed.values, "--cwd");
  if (!isAbsolute(cwdValue)) throw new Error("PATH_NOT_ABSOLUTE");
  const cwd = await canonicalizeCwd(cwdValue);
  if (parsed.flags.has("--clear")) {
    if (parsed.values.has("--session-id") || parsed.values.has("--owner-id")) {
      throw new Error("CLEAR_DOES_NOT_ACCEPT_TARGET");
    }
    await targetStore.clear(cwd);
    output("Context target cleared.");
    return 0;
  }
  const sessionId = required(parsed.values, "--session-id");
  const ownerId = required(parsed.values, "--owner-id");
  await currentLiveState(liveClient, sessionId, ownerId, cwd, now, pidAlive);
  await targetStore.write(cwd, sessionId, ownerId);
  output("Context target selected.");
  return 0;
}

function selectionFromEnvironment(
  values: ReadonlyMap<string, string>,
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const name = values.get("--selection-env");
  if (name === undefined) return undefined;
  const value = environment[name];
  if (value === undefined) throw new Error("SELECTION_ENV_NOT_SET");
  if (Buffer.byteLength(value, "utf8") > DEFAULT_SELECTION_TEXT_BYTES) {
    throw new Error("SELECTION_TEXT_TOO_LARGE");
  }
  return value;
}

async function runPublish(
  parsed: ParsedArguments,
  liveClient: LiveSessionClient,
  store: EditorContextStore,
  now: () => number,
  readSelectionFile: (path: string) => Promise<string>,
  environment: Readonly<Record<string, string | undefined>>,
  output: Output,
  targetStore: ContextTargetStore,
  pidAlive: (pid: number) => boolean,
): Promise<number> {
  const cwdValue = required(parsed.values, "--cwd");
  const bufferPathValue = parsed.values.get("--path");
  if (!isAbsolute(cwdValue) || (bufferPathValue !== undefined && !isAbsolute(bufferPathValue))) {
    throw new Error("PATH_NOT_ABSOLUTE");
  }
  const cwd = resolve(cwdValue);
  const bufferPath = bufferPathValue === undefined ? undefined : resolve(bufferPathValue);
  const zeroBasedPosition = parsed.flags.has("--zero-based-position");
  const line = optionalPosition(parsed.values, "--line", zeroBasedPosition);
  const column = optionalPosition(parsed.values, "--column", zeroBasedPosition);
  const generation = optionalPositiveInteger(parsed.values, "--generation") ?? 1;
  if ((line === undefined) !== (column === undefined))
    throw new Error("CURSOR_REQUIRES_LINE_AND_COLUMN");
  if (
    bufferPath === undefined &&
    (parsed.values.has("--language") || parsed.values.has("--symbol"))
  ) {
    throw new Error("BUFFER_METADATA_REQUIRES_PATH");
  }
  const selectionFile = parsed.values.get("--selection-file");
  const selectionTextDisabled =
    parsed.flags.has("--no-selection-text") || environment[NO_SELECTION_ENV] === "1";
  if (
    !selectionTextDisabled &&
    selectionFile !== undefined &&
    parsed.values.has("--selection-env")
  ) {
    throw new Error("SELECTION_FILE_AND_ENV_CONFLICT");
  }
  const target = await resolvePublishTarget(
    parsed.values,
    liveClient,
    targetStore,
    cwd,
    now,
    pidAlive,
    output,
  );
  const { sessionId, ownerId } = target;
  let selectionText: string | undefined;
  if (!selectionTextDisabled) {
    selectionText =
      selectionFile === undefined
        ? selectionFromEnvironment(parsed.values, environment)
        : await readSelectionFile(selectionFile);
  }
  const capturedAt = now();
  const document: EditorContextDocument = {
    version: 1,
    requestId: randomUUID(),
    editor: { name: "zed" },
    session: { sessionId, ownerId, generation },
    workspace: { root: cwd },
    buffer:
      bufferPath === undefined
        ? undefined
        : {
            path: bufferPath,
            language: parsed.values.get("--language"),
            symbol: parsed.values.get("--symbol"),
          },
    cursor: line === undefined || column === undefined ? undefined : { line, column },
    selection: selectionText === undefined ? undefined : { text: selectionText },
    capturedAt: new Date(capturedAt).toISOString(),
    expiresAt: new Date(capturedAt + DEFAULT_CONTEXT_TTL_MS).toISOString(),
  };
  const validation = validateEditorContextDocument(document, {
    cwd: target.cwd,
    sessionId,
    ownerId,
    generation,
    now: () => capturedAt,
  });
  if (!validation.ok) {
    output(`Editor context rejected: ${validation.diagnostics.map(({ code }) => code).join(", ")}`);
    return 1;
  }

  await currentLiveState(liveClient, sessionId, ownerId, undefined, now, pidAlive);
  if (parsed.flags.has("--dry-run")) {
    output("Dry run: editor context is valid; no file written.");
    return 0;
  }
  await store.write(validation.document);
  output("Editor context published.");
  return 0;
}

export async function runEditorContextCli(
  argv: readonly string[],
  dependencies: EditorContextCliDependencies = {},
): Promise<number> {
  const output = dependencies.output ?? console.log;
  try {
    const parsed = parseArguments(argv);
    const liveClient = dependencies.liveClient ?? createLiveSessionClient();
    const now = dependencies.now ?? Date.now;
    const targetStore =
      dependencies.targetStore ??
      createContextTargetStore({ bridgeDirectory: liveClient.bridgeDirectory, now });
    const pidAlive = dependencies.pidAlive ?? processIsAlive;
    if (parsed.command === "list" || parsed.command === "diagnose") {
      return await runList(
        parsed,
        liveClient,
        output,
        dependencies.commandPath ?? process.execPath,
        dependencies.cliPath ?? process.argv[1] ?? "cli.ts",
      );
    }
    if (parsed.command === "select") {
      return await runSelect(parsed, liveClient, targetStore, now, pidAlive, output);
    }
    if (parsed.command === "publish") {
      const store = dependencies.store ?? createEditorContextStore();
      return await runPublish(
        parsed,
        liveClient,
        store,
        now,
        dependencies.readSelectionFile ?? defaultReadSelectionFile,
        dependencies.environment ?? process.env,
        output,
        targetStore,
        pidAlive,
      );
    }
    output("Usage: cli.ts publish|select|list|diagnose [options] (publish: --no-selection-text)");
    return 2;
  } catch (error) {
    output(
      `Editor context command failed: ${bounded(error instanceof Error ? error.message : "UNKNOWN")}`,
    );
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  const argv = process.argv.slice(2);
  void runEditorContextCli(argv).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
