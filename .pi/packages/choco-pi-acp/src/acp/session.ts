import type {
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  McpServer,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import {
  type BoundaryValue,
  isBoolean,
  isBoundaryArray,
  isBoundaryRecord,
  isFiniteNumber,
  isNumber,
  isObjectValue,
  isString,
  parseJsonLine,
} from "../boundary.ts";
import {
  PiRpcProcess,
  PiRpcSpawnError,
  PiRpcStaleContextError,
  type PiRpcEvent,
  type PiRpcExit,
  type PiRpcProcessLike,
} from "../pi-rpc/process.ts";
import {
  recordField,
  stringField,
  type PiAssistantMessageEvent,
  type PiAssistantToolCall,
  type PiAutoRetryStartEvent,
  type PiExtensionUiRequestEvent,
  type PiPromptImage,
  type PiState,
  type PiToolArguments,
  type PiToolResult,
} from "../pi-rpc/protocol.ts";
import { maybeAuthRequiredError } from "./auth-required.ts";
import { SessionStore } from "./session-store.ts";
import { expandSlashCommand, type FileSlashCommand } from "./slash-commands.ts";
import {
  bashCommand,
  bashExitCode,
  bashOutputDelta,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool,
  type BashTerminalExit,
  type BashTerminalInfo,
  type BashTerminalOutput,
} from "./translate/bash.ts";
import { toolResultToText } from "./translate/pi-tools.ts";
import {
  ToolPresentationTracker,
  type EditorToolPresentation,
} from "../translate/tool-presentation.ts";

/**
 * The subset of the ACP client connection this adapter's sessions call.
 *
 * `AgentSideConnection` carries private state, so no structural value is
 * assignable to it. Declaring the contract the session actually uses lets both
 * the real SDK connection and narrow client fakes satisfy it without assertions.
 */
export type AcpConnection = {
  sessionUpdate(params: SessionNotification): Promise<void>;
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  unstable_createElicitation?(params: CreateElicitationRequest): Promise<CreateElicitationResponse>;
};

type SessionCreateParams = {
  cwd: string;
  mcpServers: McpServer[];
  conn: AcpConnection;
  fileCommands?: import("./slash-commands.ts").FileSlashCommand[];
  piCommand?: string;
};

export const DEFAULT_PI_ACP_MAX_LIVE_SESSIONS = 8;
export const DEFAULT_PI_ACP_SESSION_IDLE_MS = 10 * 60_000;

/** Decode a numeric setting supplied as a number or an integral decimal string. */
function integerSetting(value: BoundaryValue): number | undefined {
  let parsed = Number.NaN;
  if (isNumber(value)) parsed = value;
  else if (isString(value) && /^[+-]?\d+$/.test(value.trim())) parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return undefined;
  return parsed;
}

function boundedMaxLiveSessions(value: BoundaryValue): number {
  const parsed = integerSetting(value);
  if (parsed === undefined) return DEFAULT_PI_ACP_MAX_LIVE_SESSIONS;
  return Math.max(1, Math.min(32, parsed));
}

export const PI_ACP_MAX_LIVE_SESSIONS = boundedMaxLiveSessions(
  process.env.PI_ACP_MAX_LIVE_SESSIONS,
);

export function boundedSessionIdleMs(value: BoundaryValue): number {
  const parsed = integerSetting(value);
  if (parsed === undefined) return DEFAULT_PI_ACP_SESSION_IDLE_MS;
  return Math.max(60_000, Math.min(120 * 60_000, parsed));
}

export const PI_ACP_SESSION_IDLE_MS = boundedSessionIdleMs(process.env.PI_ACP_SESSION_IDLE_MS);

export type StopReason = "end_turn" | "cancelled" | "error";

type PendingTurn = {
  resolve: (reason: StopReason) => void;
  reject: (error: BoundaryValue) => void;
  settling: boolean;
};

type QueuedTurn = {
  message: string;
  images: PiPromptImage[];
  resolve: (reason: StopReason) => void;
  reject: (error: BoundaryValue) => void;
};

type PermissionResponse = RequestPermissionResponse;

type PendingExtensionUi = {
  generation: number;
  timer: ReturnType<typeof setTimeout>;
  cancelled: Promise<null>;
  release: () => void;
};

type TurnSettlement =
  | { type: "resolve"; reason: StopReason }
  | { type: "reject"; error: BoundaryValue };

/** Bounded report of how a tool call's raw input was shortened before publication. */
type RawInputTruncation = {
  truncated: true;
  originalCharacters?: number;
  limitCharacters: number;
};

type BoundedToolRawInput = {
  rawInput: PiToolArguments;
  truncation?: RawInputTruncation;
};

/** The `tool_call_update` variant of an ACP session update. */
type ToolCallUpdateNotification = Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>;

/** The `session_info_update` variant of an ACP session update. */
type SessionInfoNotification = Extract<SessionUpdate, { sessionUpdate: "session_info_update" }>;

/** ACP `_meta` payload published alongside a non-bash tool call. */
type ToolCallMeta = {
  editorToolPresentation: EditorToolPresentation;
  piAcp?: { rawInputTruncation: RawInputTruncation };
};

/** ACP `_meta` payload published alongside a bash tool call. */
type BashToolCallMeta = {
  terminal_info: BashTerminalInfo;
  editorToolPresentation: EditorToolPresentation | undefined;
};

/** ACP `_meta` payload published for streamed bash terminal output. */
type BashOutputMeta = {
  terminal_output?: BashTerminalOutput;
  terminal_exit?: BashTerminalExit;
  editorToolPresentation: EditorToolPresentation | undefined;
};

/**
 * The sanitized, bounded projection of an extension UI request published to the
 * client, either as ACP `_meta` or as a synthetic tool call's `rawInput`.
 */
type ExtensionUiRawInput = {
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
};

/** The synthetic ACP tool call standing in for an extension UI request on legacy clients. */
type ExtensionUiToolCall = {
  toolCallId: string;
  title: string;
  kind: "other";
  status: "pending";
  rawInput: ExtensionUiRawInput;
};

/** One `{ oldText, newText }` pair pi's edit tool applies to a file. */
type ParsedEdit = {
  oldText: string;
  newText: string;
};

type ExtensionUiResponse =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true };

const CONFIRM_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: "yes", name: "Yes", kind: "allow_once" },
  { optionId: "no", name: "No", kind: "reject_once" },
];
const CHOICE_OPTION_PREFIX = "choice-";
const EXTENSION_UI_TIMEOUT_MS = 60_000;
const MAX_EXTENSION_UI_FALLBACK_LENGTH = 2_000;
const MAX_EXTENSION_UI_TEXT_LENGTH = 10_000;
const EXTENSION_UI_TOMBSTONE_CAPACITY = 8_192;
/** One active turn plus at most this many explicitly queued ACP prompts. */
const MAX_QUEUED_TURNS = 64;
const SENSITIVE_UI_REQUEST =
  /\b(?:auth(?:entication|orization)?|credential|login|pass(?:code|phrase|word)?|secret|token|api[ _-]?key|private[ _-]?key)\b/i;

/** Convert bounded TUI-oriented extension text into portable ACP text. */
export function sanitizeExtensionUiText(input: string): string {
  const source = input.slice(0, MAX_EXTENSION_UI_TEXT_LENGTH);
  const output: string[] = [];
  let index = 0;
  while (index < source.length) {
    const code = source.charCodeAt(index);

    if (code === 0x1b || code === 0x9d) {
      const isOsc = code === 0x9d || source.charCodeAt(index + 1) === 0x5d;
      if (isOsc) {
        index += code === 0x1b ? 2 : 1;
        while (index < source.length) {
          const current = source.charCodeAt(index);
          if (current === 0x07 || current === 0x9c) {
            index += 1;
            break;
          }
          if (current === 0x1b && source.charCodeAt(index + 1) === 0x5c) {
            index += 2;
            break;
          }
          index += 1;
        }
        continue;
      }

      if (code === 0x1b && source.charCodeAt(index + 1) === 0x5b) {
        index += 2;
        while (index < source.length) {
          const current = source.charCodeAt(index++);
          if (current >= 0x40 && current <= 0x7e) break;
        }
        continue;
      }

      index += 1;
      while (index < source.length) {
        const current = source.charCodeAt(index);
        if (current >= 0x20 && current <= 0x2f) {
          index += 1;
          continue;
        }
        if (current >= 0x30 && current <= 0x7e) index += 1;
        break;
      }
      continue;
    }

    if (code === 0x9b) {
      index += 1;
      while (index < source.length) {
        const current = source.charCodeAt(index++);
        if (current >= 0x40 && current <= 0x7e) break;
      }
      continue;
    }

    if (code === 0x0d) {
      if (source.charCodeAt(index + 1) === 0x0a) output.push("\n");
      index += source.charCodeAt(index + 1) === 0x0a ? 2 : 1;
      continue;
    }
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)) {
      index += 1;
      continue;
    }

    if ((code >= 0x2500 && code <= 0x259f) || code === 0x25ac) {
      let runLength = 0;
      while (index < source.length) {
        const current = source.charCodeAt(index);
        if (!((current >= 0x2500 && current <= 0x259f) || current === 0x25ac)) break;
        runLength += 1;
        index += 1;
      }
      // A maximal progress/decoration run becomes a readable bar capped at 32 cells.
      output.push("#".repeat(Math.min(runLength, 32)));
      continue;
    }

    output.push(source[index]!);
    index += 1;
  }
  return output.join("");
}

/** Cancel a session's dialogs, then await its child's bounded shutdown. */
async function shutdownSession(session: PiAcpSession, graceMs?: number): Promise<void> {
  await session.closeExtensionUi();
  await session.proc.shutdown?.(graceMs);
}

function settleTurn(
  turn: Pick<QueuedTurn, "resolve" | "reject">,
  settlement: TurnSettlement,
): void {
  if (settlement.type === "reject") {
    turn.reject(settlement.error);
  } else {
    turn.resolve(settlement.reason);
  }
}

class BoundedRequestIdTombstones {
  private readonly ids = new Set<string>();

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    if (this.ids.has(id)) return;
    if (this.ids.size === EXTENSION_UI_TOMBSTONE_CAPACITY) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    this.ids.add(id);
  }
}

function findUniqueLineNumber(text: string, needle: string): number | undefined {
  if (!needle) return undefined;

  const first = text.indexOf(needle);
  if (first < 0) return undefined;

  const second = text.indexOf(needle, first + needle.length);
  if (second >= 0) return undefined;

  let line = 1;
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function getToolPath(args: PiToolArguments): string | undefined {
  return stringField(args, "path") ?? stringField(args, "file_path");
}

/**
 * The entries of a tool call's `edits` field. Pi also normalizes stringified
 * edits, so a JSON string is decoded before the array shape is checked.
 */
function editEntries(args: PiToolArguments): BoundaryValue[] {
  if (!isBoundaryRecord(args)) return [];
  const edits = args.edits;
  const decoded = isString(edits) ? parseJsonLine(edits) : edits;
  return isBoundaryArray(decoded) ? decoded : [];
}

// Match pi's current edit schema: { path, edits: [{ oldText, newText }] }, with
// legacy top-level oldText/newText still accepted. Pi also normalizes stringified edits.
// https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/tools/edit.ts
function getParsedEdits(args: PiToolArguments): ParsedEdit[] {
  const parsed: ParsedEdit[] = [];

  const rootOldText = stringField(args, "oldText");
  const rootNewText = stringField(args, "newText");
  if (rootOldText !== undefined && rootNewText !== undefined) {
    parsed.push({ oldText: rootOldText, newText: rootNewText });
  }

  for (const edit of editEntries(args)) {
    const oldText = stringField(edit, "oldText");
    const newText = stringField(edit, "newText");
    if (oldText !== undefined && newText !== undefined) parsed.push({ oldText, newText });
  }

  return parsed;
}

function getEditOldTexts(args: PiToolArguments): string[] {
  const oldTexts = getParsedEdits(args).map((edit) => edit.oldText);

  const rootOldText = stringField(args, "oldText");
  if (rootOldText !== undefined && !oldTexts.includes(rootOldText)) oldTexts.push(rootOldText);

  for (const edit of editEntries(args)) {
    const oldText = stringField(edit, "oldText");
    if (oldText !== undefined && !oldTexts.includes(oldText)) oldTexts.push(oldText);
  }

  return oldTexts;
}

function toToolCallLocations(
  args: PiToolArguments,
  cwd: string,
  line?: number,
): ToolCallLocation[] | undefined {
  const path = getToolPath(args);
  if (!path) return undefined;

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path);
  const location: ToolCallLocation = { path: resolvedPath };
  if (line !== undefined) location.line = line;
  return [location];
}

export class SessionManager {
  private sessions = new Map<string, PiAcpSession>();
  private readonly recency = new Map<string, true>();
  private readonly store = new SessionStore();
  private readonly sessionIdleMs: number;
  private generation = 0;
  private active = true;

  constructor(options: { sessionIdleMs?: number } = {}) {
    this.sessionIdleMs = options.sessionIdleMs ?? PI_ACP_SESSION_IDLE_MS;
  }

  private assertCurrent(generation: number): void {
    if (!this.active || this.generation !== generation) throw new PiRpcStaleContextError();
  }

  /** Dispose all sessions and their underlying pi subprocesses. */
  disposeAll(): void {
    if (!this.active) return;
    this.active = false;
    this.generation += 1;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.recency.clear();
    for (const session of sessions) {
      void session.closeExtensionUi().finally(() => session.proc.dispose?.());
    }
  }

  /** Invalidate every session synchronously, then await bounded child shutdown. */
  async shutdownAll(graceMs?: number): Promise<void> {
    if (!this.active) return;
    this.active = false;
    this.generation += 1;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.recency.clear();
    const shutdowns: Array<Promise<void>> = [];
    for (const session of sessions) shutdowns.push(shutdownSession(session, graceMs));
    await Promise.all(shutdowns);
  }

  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId: string): PiAcpSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  close(sessionId: string): void {
    this.recency.delete(sessionId);
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    void s.closeExtensionUi().finally(() => {
      try {
        s.proc.dispose?.();
      } catch {
        // ignore
      }
    });
  }

  private reapIdle(sessionId: string, session: PiAcpSession): void {
    if (!this.active || this.sessions.get(sessionId) !== session) return;
    this.sessions.delete(sessionId);
    this.recency.delete(sessionId);
    session.reap();
  }

  /** Mark one session as active and close only sessions beyond the bounded LRU cap. */
  retainRecent(activeSessionId: string, maxLive: number): string[] {
    if (this.sessions.has(activeSessionId)) {
      this.recency.delete(activeSessionId);
      this.recency.set(activeSessionId, true);
    }

    const limit = boundedMaxLiveSessions(maxLive);
    const closed: string[] = [];
    while (this.sessions.size > limit) {
      const leastRecent = this.recency.keys().next().value;
      if (!leastRecent) break;
      closed.push(leastRecent);
      this.close(leastRecent);
    }
    return closed;
  }

  async create(params: SessionCreateParams): Promise<PiAcpSession> {
    const generation = this.generation;
    const cwd = params.cwd;
    const piCommand = params.piCommand;
    const mcpServers = params.mcpServers;
    const conn = params.conn;
    const fileCommands = params.fileCommands ?? [];
    const store = this.store;
    this.assertCurrent(generation);

    // Let pi manage session persistence in its default location (~/.pi/agent/sessions/...)
    // so sessions are visible to the regular `pi` CLI.
    let proc: PiRpcProcess;
    try {
      proc = await PiRpcProcess.spawn({
        cwd,
        piCommand,
      });
    } catch (e) {
      if (e instanceof PiRpcSpawnError) {
        throw RequestError.internalError({ code: e.code }, e.message);
      }
      throw e;
    }

    try {
      this.assertCurrent(generation);
    } catch (error) {
      await proc.shutdown();
      throw error;
    }

    let state: PiState | null = null;
    try {
      state = await proc.getState();
      this.assertCurrent(generation);
    } catch (error) {
      if (!this.active || this.generation !== generation) {
        await proc.shutdown();
        throw new PiRpcStaleContextError();
      }
      if (error instanceof PiRpcSpawnError) {
        await proc.shutdown();
        throw RequestError.internalError({ code: error.code }, error.message);
      }
      state = null;
    }

    const sessionId = state?.sessionId ?? crypto.randomUUID();
    const sessionFile = state?.sessionFile ?? null;

    if (sessionFile) {
      store.upsert({ sessionId, cwd, sessionFile });
    }

    let session!: PiAcpSession;
    session = new PiAcpSession({
      sessionId,
      cwd,
      mcpServers,
      proc,
      conn,
      fileCommands,
      idleMs: this.sessionIdleMs,
      onIdle: () => this.reapIdle(sessionId, session),
    });

    this.sessions.set(sessionId, session);
    this.recency.delete(sessionId);
    this.recency.set(sessionId, true);
    return session;
  }

  get(sessionId: string): PiAcpSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`);
    return s;
  }

  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered.
   */
  getOrCreate(
    sessionId: string,
    params: SessionCreateParams & { proc: PiRpcProcessLike },
  ): PiAcpSession {
    this.assertCurrent(this.generation);
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    let session!: PiAcpSession;
    session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      idleMs: this.sessionIdleMs,
      onIdle: () => this.reapIdle(sessionId, session),
    });

    this.sessions.set(sessionId, session);
    this.recency.set(sessionId, true);
    return session;
  }
}

export class PiAcpSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly mcpServers: McpServer[];

  private startupInfo: string | null = null;
  private startupInfoSent = false;

  readonly proc: PiRpcProcessLike;
  private readonly conn: AcpConnection;
  private readonly fileCommands: FileSlashCommand[];
  private unsubscribeProcExit: () => void = () => {};

  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  private cancelRequested = false;

  // Current in-flight turn (if any). Additional prompts are queued.
  private pendingTurn: PendingTurn | null = null;
  private readonly turnQueue: QueuedTurn[] = [];
  private turnQueueClosedError: Error | null = null;
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  private currentToolCalls = new Map<string, "pending" | "in_progress">();

  // pi can emit multiple `turn_end` and `agent_end` events for a single user prompt
  // when retry, compaction, or queued continuations run. The session-level prompt
  // completes only when `agent_settled` is emitted.
  // For ACP diff support: capture file contents before edit/write mutations,
  // then emit ToolCallContent {type:"diff"}. Compatible structured edit/write
  // events may need to be implemented in pi in the future.
  private fileSnapshots = new Map<string, { path: string; oldText: string | null }>();
  private fileMutationToolCallIds = new Set<string>();
  private bashToolCallIds = new Set<string>();
  private bashOutputSnapshots = new Map<string, string>();
  private readonly toolPresentations = new ToolPresentationTracker();

  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  private lastEmit: Promise<void> = Promise.resolve();
  private extensionUiGeneration = 0;
  private extensionUiActive = true;
  private readonly pendingExtensionUi = new Map<string, PendingExtensionUi>();
  private readonly extensionUiTaskState = { active: 0 };
  private readonly settledExtensionUi = new BoundedRequestIdTombstones();
  private readonly idleMs: number | undefined;
  private readonly onIdle: (() => void) | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleGeneration = 0;

  constructor(opts: {
    sessionId: string;
    cwd: string;
    mcpServers: McpServer[];
    proc: PiRpcProcessLike;
    conn: AcpConnection;
    fileCommands?: FileSlashCommand[];
    idleMs?: number;
    onIdle?: () => void;
  }) {
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd;
    this.mcpServers = opts.mcpServers;
    this.proc = opts.proc;
    this.conn = opts.conn;
    this.fileCommands = opts.fileCommands ?? [];
    this.idleMs = opts.idleMs;
    this.onIdle = opts.onIdle;

    this.proc.onEvent((ev) => this.handlePiEvent(ev));
    this.unsubscribeProcExit = this.proc.onExit?.((exit) => this.handlePiExit(exit)) ?? (() => {});
    this.armIdleTimer();
  }

  /** Give newly submitted session activity a fresh idle window. */
  activate(): void {
    this.cancelIdleTimer();
    this.armIdleTimer();
  }

  /** Start a fresh idle window after non-turn session activity completes. */
  markIdle(): void {
    this.armIdleTimer();
  }

  /** Cancel dialogs exactly once, then stop an idle subprocess through the bounded shutdown path. */
  reap(): void {
    this.cancelIdleTimer();
    const proc = this.proc;
    void this.closeExtensionUi().finally(() => void proc.shutdown?.());
  }

  private cancelIdleTimer(): void {
    this.idleGeneration += 1;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private armIdleTimer(): void {
    if (
      this.idleMs === undefined ||
      this.onIdle === undefined ||
      !this.extensionUiActive ||
      this.pendingTurn ||
      this.turnQueue.length > 0
    ) {
      return;
    }
    this.cancelIdleTimer();
    const generation = this.idleGeneration;
    const onIdle = this.onIdle;
    const timer = setTimeout(() => {
      if (
        this.idleTimer !== timer ||
        this.idleGeneration !== generation ||
        this.pendingTurn ||
        this.turnQueue.length > 0
      ) {
        return;
      }
      this.idleTimer = null;
      onIdle();
    }, this.idleMs);
    timer.unref?.();
    this.idleTimer = timer;
  }

  setStartupInfo(text: string) {
    this.startupInfo = text;
    this.startupInfoSent = false;
  }

  /**
   * Best-effort attempt to send startup info outside of a prompt turn.
   * Some clients (e.g. Zed) may only render agent messages once the UI is ready;
   * callers can invoke this shortly after session/new returns.
   */
  sendStartupInfoIfPending(): void {
    if (this.startupInfoSent || !this.startupInfo) return;
    this.startupInfoSent = true;

    this.emit({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: this.startupInfo },
    });
  }

  async prompt(message: string, images: PiPromptImage[] = []): Promise<StopReason> {
    this.activate();
    // pi RPC mode disables slash command expansion, so we do it here.
    const expandedMessage = expandSlashCommand(message, this.fileCommands);

    const turnPromise = new Promise<StopReason>((resolve, reject) => {
      const queued: QueuedTurn = { message: expandedMessage, images, resolve, reject };
      if (this.turnQueueClosedError) {
        reject(this.turnQueueClosedError);
        return;
      }

      // If a turn is already running, enqueue.
      if (this.pendingTurn) {
        if (this.turnQueue.length >= MAX_QUEUED_TURNS) {
          reject(
            new Error(
              `Pi ACP turn queue is full (maximum ${MAX_QUEUED_TURNS} queued prompts). Wait for a queued prompt to complete before sending another.`,
            ),
          );
          return;
        }
        this.turnQueue.push(queued);

        // Best-effort: notify client that a prompt was queued.
        // This doesn't work in Zed yet, needs to be revisited
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `Queued message (position ${this.turnQueue.length}).`,
          },
        });

        // Also publish queue depth via session info metadata.
        // This also not visible in the client
        this.emit({
          sessionUpdate: "session_info_update",
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } },
        });

        return;
      }

      // No turn is running; start immediately.
      this.startTurn(queued);
    });

    return turnPromise;
  }

  async cancel(): Promise<void> {
    // Cancel current and clear any queued prompts.
    this.cancelRequested = true;

    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length);
      for (const turn of queued) settleTurn(turn, { type: "resolve", reason: "cancelled" });

      this.emit({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Cleared queued prompts." },
      });
      this.emit({
        sessionUpdate: "session_info_update",
        _meta: { piAcp: { queueDepth: 0, running: Boolean(this.pendingTurn) } },
      });
    }

    // Abort the currently running turn (if any). If nothing is running, this is a no-op.
    await this.proc.abort?.();
  }

  wasCancelRequested(): boolean {
    return this.cancelRequested;
  }

  /** Invalidate and settle UI requests before the owning subprocess is stopped. */
  async closeExtensionUi(): Promise<void> {
    this.cancelIdleTimer();
    if (!this.extensionUiActive) return;
    this.extensionUiActive = false;
    this.extensionUiGeneration += 1;
    const pending = [...this.pendingExtensionUi.entries()];
    this.pendingExtensionUi.clear();
    const proc = this.proc;
    for (const [id, entry] of pending) {
      this.settledExtensionUi.add(id);
      clearTimeout(entry.timer);
      entry.release();
      try {
        void proc.sendExtensionUiResponse?.({ id, cancelled: true }).catch(() => {});
      } catch {
        // The transport may already be disconnected; the request is still locally settled.
      }
    }
  }

  private emit(update: SessionUpdate): void {
    // Serialize update delivery.
    this.lastEmit = this.lastEmit
      .then(() =>
        this.conn.sessionUpdate({
          sessionId: this.sessionId,
          update,
        }),
      )
      .catch(() => {
        // Ignore notification errors (client may have gone away). We still want
        // prompt completion.
      });
  }

  private async flushEmits(): Promise<void> {
    const emits = this.lastEmit;
    await emits;
  }

  private emitBashToolCall(params: {
    sessionUpdate: "tool_call" | "tool_call_update";
    toolCallId: string;
    toolName: string;
    args: PiToolArguments;
    status: "pending" | "in_progress";
    locations?: ToolCallLocation[];
    includeTerminal: boolean;
    presentation?: EditorToolPresentation;
  }): void {
    this.bashToolCallIds.add(params.toolCallId);
    const title = bashCommand(params.args) ?? params.toolName;

    if (params.includeTerminal) {
      const meta: BashToolCallMeta = {
        terminal_info: bashTerminalInfoMeta(params.toolCallId, this.cwd).terminal_info,
        editorToolPresentation: params.presentation,
      };
      this.emit({
        sessionUpdate: params.sessionUpdate,
        toolCallId: params.toolCallId,
        title,
        kind: "execute",
        status: params.status,
        locations: params.locations,
        content: bashTerminalContent(params.toolCallId),
        _meta: meta,
      });
      return;
    }

    this.emit({
      sessionUpdate: params.sessionUpdate,
      toolCallId: params.toolCallId,
      title,
      kind: "execute",
      status: params.status,
      locations: params.locations,
    });
  }

  private emitBashOutputUpdate(params: {
    toolCallId: string;
    status: "in_progress" | "completed" | "failed";
    result: PiToolResult;
    textOverride?: string;
    isError?: boolean;
    presentation?: EditorToolPresentation;
    locations?: ToolCallLocation[];
  }): void {
    const text = params.textOverride ?? bashResultText(params.result);
    const previous = this.bashOutputSnapshots.get(params.toolCallId) ?? "";
    const delta = bashOutputDelta(previous, text);
    this.bashOutputSnapshots.set(params.toolCallId, text);

    const meta: BashOutputMeta = { editorToolPresentation: params.presentation };
    if (delta) {
      meta.terminal_output = bashTerminalOutputMeta(params.toolCallId, delta).terminal_output;
    }
    if (params.status === "completed" || params.status === "failed") {
      meta.terminal_exit = bashTerminalExitMeta(
        params.toolCallId,
        bashExitCode(params.result, Boolean(params.isError)),
      ).terminal_exit;
    }

    this.emit({
      sessionUpdate: "tool_call_update",
      toolCallId: params.toolCallId,
      status: params.status,
      locations: params.locations,
      _meta: meta,
    });
  }

  private cleanupToolCall(toolCallId: string): void {
    this.currentToolCalls.delete(toolCallId);
    this.fileSnapshots.delete(toolCallId);
    this.fileMutationToolCallIds.delete(toolCallId);
    this.bashToolCallIds.delete(toolCallId);
    this.bashOutputSnapshots.delete(toolCallId);
  }

  private settlePendingTurn(
    settlement: TurnSettlement,
    options: { startNext?: boolean; queuedSettlement?: TurnSettlement } = {},
  ): void {
    if (options.queuedSettlement) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length);
      for (const turn of queued) settleTurn(turn, options.queuedSettlement);
    }

    const pending = this.pendingTurn;
    if (!pending || pending.settling) return;
    pending.settling = true;
    void this.flushEmits().finally(() => {
      if (this.pendingTurn !== pending || !pending.settling) return;
      this.pendingTurn = null;
      settleTurn(pending, settlement);

      if (options.startNext) {
        const next = this.turnQueue.shift();
        if (next) {
          this.emit({
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `Starting queued message. (${this.turnQueue.length} remaining)`,
            },
          });
          this.startTurn(next);
          return;
        }
      }

      this.emit({
        sessionUpdate: "session_info_update",
        _meta: {
          piAcp: { queueDepth: this.turnQueue.length, running: false },
        },
      });
      this.armIdleTimer();
    });
  }

  private handlePiExit(exit: PiRpcExit): void {
    this.cancelIdleTimer();
    const unsubscribe = this.unsubscribeProcExit;
    this.unsubscribeProcExit = () => {};
    unsubscribe();

    this.turnQueueClosedError = new Error(
      `pi process exited (code=${exit.code}, signal=${exit.signal})`,
    );
    const reason: StopReason = this.cancelRequested ? "cancelled" : "error";
    const settlement: TurnSettlement = { type: "resolve", reason };
    this.settlePendingTurn(settlement, { queuedSettlement: settlement });
    void this.closeExtensionUi();
  }

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false;
    this.pendingTurn = { resolve: t.resolve, reject: t.reject, settling: false };

    // Publish queue depth (0 because we're starting the turn now).
    this.emit({
      sessionUpdate: "session_info_update",
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } },
    });

    // Kick off pi, but completion is determined by pi events, not the RPC response.
    // The prompt RPC only acknowledges acceptance; retry, compaction, or queued
    // continuations may emit multiple `agent_end` events before `agent_settled`.
    this.proc.prompt(t.message, t.images).catch((err) => {
      // If this looks like an auth/config issue, surface AUTH_REQUIRED so clients can offer terminal login.
      const authErr = maybeAuthRequiredError(err);
      let settlement: TurnSettlement;
      if (authErr) {
        settlement = { type: "reject", error: authErr };
      } else {
        const reason: StopReason = this.cancelRequested ? "cancelled" : "error";
        settlement = { type: "resolve", reason };
      }
      // A prompt acknowledgement failure leaves Pi's health unknown, so queued turns
      // must settle rather than being started against the same process automatically.
      this.settlePendingTurn(settlement, { queuedSettlement: settlement });
    });
  }

  /** Surface a tool call while the model is still streaming its arguments. */
  private handleStreamedToolCall(toolCall: PiAssistantToolCall | undefined): void {
    const toolCallId = toolCall?.id ?? "";
    const toolName = toolCall?.name ?? "tool";
    if (!toolCallId) return;

    const rawInput = streamedToolArguments(toolCall);
    const normalized = this.toolPresentations.start({
      toolCallId,
      toolName,
      args: rawInput,
      cwd: this.cwd,
    });
    const locations = normalized.presentation.locations ?? toToolCallLocations(rawInput, this.cwd);
    const boundedInput = boundedToolRawInput(rawInput);
    const existingStatus = this.currentToolCalls.get(toolCallId);
    // IMPORTANT: never downgrade status (e.g. if we already marked in_progress via tool_execution_start).
    const status = existingStatus ?? "pending";

    if (isBashTool(toolName)) {
      if (!existingStatus) this.currentToolCalls.set(toolCallId, "pending");
      this.emitBashToolCall({
        sessionUpdate: existingStatus ? "tool_call_update" : "tool_call",
        toolCallId,
        toolName,
        args: rawInput,
        status,
        locations,
        includeTerminal: !existingStatus,
        presentation: normalized.presentation,
      });
      return;
    }

    if (!existingStatus) {
      this.currentToolCalls.set(toolCallId, "pending");
      this.emit({
        sessionUpdate: "tool_call",
        toolCallId,
        title: normalized.presentation.title ?? toolName,
        kind: toToolKind(toolName),
        status,
        locations,
        rawInput: boundedInput.rawInput,
        _meta: toolCallMeta(normalized.presentation, boundedInput),
      });
      return;
    }

    // Best-effort: keep rawInput updated while args are streaming.
    // Keep the existing status (pending or in_progress).
    this.emit({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status,
      locations,
      rawInput: boundedInput.rawInput,
      _meta: toolCallMeta(normalized.presentation, boundedInput),
    });
  }

  /** Render one streamed assistant message event as ACP session updates. */
  private handleAssistantMessageEvent(ame: PiAssistantMessageEvent | undefined): void {
    if (ame === undefined) return;

    // Stream assistant text.
    if (ame.type === "text_delta") {
      this.emit({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: ame.delta } satisfies ContentBlock,
      });
      return;
    }

    if (ame.type === "thinking_delta") {
      this.emit({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: ame.delta } satisfies ContentBlock,
      });
      return;
    }

    // Surface tool calls ASAP so clients (e.g. Zed) can show a tool-in-use/loading UI
    // while the model is still streaming tool call args.
    if (
      ame.type === "toolcall_start" ||
      ame.type === "toolcall_delta" ||
      ame.type === "toolcall_end"
    ) {
      this.handleStreamedToolCall(ame.toolCall);
    }

    // Ignore other delta/event types for now.
  }

  private handlePiEvent(ev: PiRpcEvent): void {
    switch (ev.type) {
      case "message_update": {
        this.handleAssistantMessageEvent(ev.assistantMessageEvent);
        break;
      }

      case "tool_execution_start": {
        const toolCallId = ev.toolCallId ?? crypto.randomUUID();
        const toolName = ev.toolName ?? "tool";
        const args = ev.args;
        const normalized = this.toolPresentations.start({
          toolCallId,
          toolName,
          args,
          cwd: this.cwd,
        });
        let line: number | undefined;

        if (isBashTool(toolName)) {
          const locations =
            normalized.presentation.locations ?? toToolCallLocations(args, this.cwd);
          const existingStatus = this.currentToolCalls.get(toolCallId);
          this.currentToolCalls.set(toolCallId, "in_progress");
          this.emitBashToolCall({
            sessionUpdate: existingStatus ? "tool_call_update" : "tool_call",
            toolCallId,
            toolName,
            args,
            status: "in_progress",
            locations,
            includeTerminal: !existingStatus,
            presentation: normalized.presentation,
          });
          break;
        }

        // Capture pre-mutation file contents so we can emit a structured ACP diff.
        const isFileMutation = toolName === "edit" || toolName === "write";
        let snapshotOldText: string | null | undefined;
        if (isFileMutation) {
          this.fileMutationToolCallIds.add(toolCallId);
          const p = getToolPath(args);
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p);
              snapshotOldText = readFileSync(abs, "utf8");
              this.fileSnapshots.set(toolCallId, { path: p, oldText: snapshotOldText });

              if (toolName === "edit") {
                for (const needle of getEditOldTexts(args)) {
                  line = findUniqueLineNumber(snapshotOldText, needle);
                  if (line !== undefined) break;
                }
              }
            } catch {
              snapshotOldText = null;
              this.fileSnapshots.set(toolCallId, { path: p, oldText: null });
            }
          }
        }

        const locations =
          line === undefined
            ? (normalized.presentation.locations ?? toToolCallLocations(args, this.cwd))
            : toToolCallLocations(args, this.cwd, line);
        const boundedInput = boundedToolRawInput(args);

        // If we already surfaced the tool call while the model streamed it, just transition.
        const alreadySurfaced = this.currentToolCalls.has(toolCallId);
        this.currentToolCalls.set(toolCallId, "in_progress");
        if (alreadySurfaced) {
          this.emit({
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
            locations,
            rawInput: boundedInput.rawInput,
            _meta: toolCallMeta(normalized.presentation, boundedInput),
          });
        } else {
          this.emit({
            sessionUpdate: "tool_call",
            toolCallId,
            title: normalized.presentation.title ?? toolName,
            kind: toToolKind(toolName),
            status: "in_progress",
            locations,
            rawInput: boundedInput.rawInput,
            _meta: toolCallMeta(normalized.presentation, boundedInput),
          });
        }

        break;
      }

      case "tool_execution_update": {
        const toolCallId = ev.toolCallId ?? "";
        if (!toolCallId) break;

        const partial = ev.partialResult;
        let normalized = this.toolPresentations.update({ toolCallId, result: partial });
        if (!normalized && this.toolPresentations.isTerminal(toolCallId)) break;
        if (normalized?.text === undefined) {
          normalized =
            this.toolPresentations.update({
              toolCallId,
              result: toolResultToText(partial),
            }) ?? normalized;
        }
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({
            toolCallId,
            status: "in_progress",
            result: partial,
            textOverride: normalized?.text,
            presentation: normalized?.presentation,
          });
          break;
        }

        const isFileMutation = this.fileMutationToolCallIds.has(toolCallId);
        const text = isFileMutation ? "" : (normalized?.text ?? toolResultToText(partial));

        const update: ToolCallUpdateNotification = {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "in_progress",
          content: text
            ? ([{ type: "content", content: { type: "text", text } }] satisfies ToolCallContent[])
            : undefined,
          _meta: normalized ? { editorToolPresentation: normalized.presentation } : undefined,
        };
        // A file mutation publishes its diff instead of the raw tool payload.
        if (!isFileMutation) update.rawOutput = partial;
        this.emit(update);
        break;
      }

      case "tool_execution_end": {
        const toolCallId = ev.toolCallId ?? "";
        if (!toolCallId) break;

        const result = ev.result;
        const isError = ev.isError ?? false;
        if (this.toolPresentations.isTerminal(toolCallId)) break;
        this.toolPresentations.update({ toolCallId, result: toolResultToText(result) });
        const normalized = this.toolPresentations.end({ toolCallId, result, isError });
        const presentationDiffs = isError
          ? undefined
          : normalized?.presentation.diffs?.slice(0, 256);
        if (presentationDiffs?.length) {
          this.emit({
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            content: presentationDiffs.map(({ path, oldText, newText }) => ({
              type: "diff" as const,
              path,
              oldText,
              newText,
            })),
            locations: normalized?.presentation.locations,
            _meta: { editorToolPresentation: normalized?.presentation },
          });
          this.cleanupToolCall(toolCallId);
          break;
        }
        if (this.bashToolCallIds.has(toolCallId)) {
          if (normalized?.presentation.terminal) {
            normalized.presentation.terminal.exitCode = bashExitCode(result, isError);
          }
          this.emitBashOutputUpdate({
            toolCallId,
            status: isError ? "failed" : "completed",
            result,
            textOverride: normalized?.text,
            isError,
            presentation: normalized?.presentation,
            locations: normalized?.presentation.locations,
          });
          this.cleanupToolCall(toolCallId);
          break;
        }

        const text = toolResultToText(result);

        const snapshot = this.fileSnapshots.get(toolCallId);
        let content: ToolCallContent[] | undefined;
        let hasStructuredDiff = false;

        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path)
              ? snapshot.path
              : resolvePath(this.cwd, snapshot.path);
            const newText = readFileSync(abs, "utf8");
            if (snapshot.oldText === null || newText !== snapshot.oldText) {
              hasStructuredDiff = true;
              content = [
                {
                  type: "diff",
                  path: snapshot.path,
                  oldText: snapshot.oldText,
                  newText,
                },
              ];
            }
          } catch {
            // ignore; fall back to text only
          }
        }

        if (!content && !hasStructuredDiff && text) {
          content = [
            { type: "content", content: { type: "text", text } },
          ] satisfies ToolCallContent[];
        }

        const update: ToolCallUpdateNotification = {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: isError ? "failed" : "completed",
          content,
          locations: normalized?.presentation.locations,
          _meta: normalized ? { editorToolPresentation: normalized.presentation } : undefined,
        };
        // A structured diff already carries the mutation; the raw payload would duplicate it.
        if (!hasStructuredDiff) update.rawOutput = result;
        this.emit(update);

        this.cleanupToolCall(toolCallId);
        break;
      }

      case "extension_ui_request": {
        const taskState = this.extensionUiTaskState;
        const task = this.handleExtensionUiRequest(ev);
        taskState.active += 1;
        void task.then(
          () => {
            taskState.active -= 1;
          },
          () => {
            taskState.active -= 1;
          },
        );
        break;
      }

      case "auto_retry_start": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: formatAutoRetryMessage(ev) } satisfies ContentBlock,
        });
        break;
      }

      case "auto_retry_end": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Retry finished, resuming." } satisfies ContentBlock,
        });
        break;
      }

      case "auto_compaction_start": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Context nearing limit, running automatic compaction...",
          } satisfies ContentBlock,
        });
        break;
      }

      case "auto_compaction_end": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Automatic compaction finished; context was summarized to continue the session.",
          } satisfies ContentBlock,
        });
        break;
      }

      case "agent_start": {
        break;
      }

      case "turn_end": {
        // pi uses `turn_end` for sub-steps (e.g. tool_use) and will often start another turn.
        // Do NOT resolve the ACP `session/prompt` here; wait for `agent_settled`.
        break;
      }

      case "agent_end": {
        // One low-level run ended. Pi may still retry, compact, or process a queued
        // continuation, so keep the ACP turn open until `agent_settled`.
        break;
      }

      case "agent_settled": {
        const reason: StopReason = this.cancelRequested ? "cancelled" : "end_turn";
        this.settlePendingTurn({ type: "resolve", reason }, { startNext: true });
        break;
      }

      default:
        break;
    }
  }

  private async handleExtensionUiRequest(ev: PiExtensionUiRequestEvent): Promise<void> {
    const id = ev.id;
    const method = ev.method;
    if (
      !id ||
      !this.extensionUiActive ||
      this.pendingExtensionUi.has(id) ||
      this.settledExtensionUi.has(id)
    ) {
      return;
    }

    const generation = this.extensionUiGeneration;
    const timeoutMs = extensionUiTimeoutMs(ev);
    const timer = setTimeout(() => {
      void this.settleExtensionUi(id, generation, { id, cancelled: true });
    }, timeoutMs);
    timer.unref?.();
    let release!: () => void;
    const cancelled = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });
    this.pendingExtensionUi.set(id, { generation, timer, cancelled, release });

    try {
      if (isSensitiveUiRequest(ev)) {
        this.emitExtensionUiMessage(
          "Pi requested sensitive authentication or credential input. Open a Terminal Thread and complete the authentication flow in the terminal; sensitive content was not sent through ACP.",
        );
        await this.settleExtensionUi(id, generation, { id, cancelled: true });
        return;
      }

      if (method === "select") {
        await this.handleExtensionSelect(ev, id, generation);
        return;
      }

      if (method === "confirm") {
        await this.handleExtensionConfirm(ev, id, generation);
        return;
      }

      if (method === "input" || method === "editor") {
        await this.handleExtensionText(ev, id, generation, method);
        return;
      }

      if (method === "notify") {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: sanitizeExtensionUiText(ev.message ?? "Pi notification"),
          } satisfies ContentBlock,
          _meta: {
            piAcp: {
              notify: {
                level: sanitizeExtensionUiText(ev.notifyType ?? "info"),
              },
            },
          },
        });
        await this.settleExtensionUi(id, generation, { id, cancelled: true });
        return;
      }

      if (method === "setTitle") {
        const title = extensionUiTitle(ev);
        const update: SessionInfoNotification = {
          sessionUpdate: "session_info_update",
          _meta: { piAcp: { extensionUi: boundedExtensionUiRawInput(ev) } },
        };
        // An empty or unusable title must leave the client's current title untouched.
        if (title) update.title = title;
        this.emit(update);
        await this.settleExtensionUi(id, generation, { id, cancelled: true });
        return;
      }

      if (method === "setStatus" || method === "setWidget") {
        this.emit({
          sessionUpdate: "session_info_update",
          _meta: { piAcp: { extensionUi: boundedExtensionUiRawInput(ev) } },
        });
        await this.settleExtensionUi(id, generation, { id, cancelled: true });
        return;
      }

      this.emitExtensionUiMessage(extensionUiFallbackMessage(ev));
      await this.settleExtensionUi(id, generation, { id, cancelled: true });
    } catch {
      await this.settleExtensionUi(id, generation, { id, cancelled: true });
    }
  }

  private async handleExtensionSelect(
    ev: PiExtensionUiRequestEvent,
    id: string,
    generation: number,
  ): Promise<void> {
    const rawOptions = ev.options ?? [];
    const options = rawOptions
      .slice(0, 100)
      .map((option) => String(option).slice(0, MAX_EXTENSION_UI_TEXT_LENGTH));
    const displayOptions = options.map(sanitizeExtensionUiText);
    if (!options.length) {
      await this.settleExtensionUi(id, generation, { id, cancelled: true });
      return;
    }

    if (this.conn.unstable_createElicitation === undefined) {
      const permissionOptions: PermissionOption[] = displayOptions.map((name, index) => ({
        optionId: `${CHOICE_OPTION_PREFIX}${index}`,
        name,
        kind: "allow_once",
      }));
      const selected = await this.requestLegacyExtensionPermission(
        id,
        generation,
        ev,
        permissionOptions,
      );
      if (!this.isCurrentExtensionUi(id, generation)) return;
      const selectedOptionId =
        selected?.outcome.outcome === "selected" ? selected.outcome.optionId : null;
      const index = selectedOptionId === null ? null : optionIndex(selectedOptionId);
      const value = index === null ? null : (options.at(index) ?? null);
      await this.settleExtensionUi(
        id,
        generation,
        value === null ? { id, cancelled: true } : { id, value },
      );
      return;
    }

    const response = await this.requestExtensionPermission(id, generation, {
      mode: "form",
      sessionId: this.sessionId,
      message: extensionUiMessage(ev),
      requestedSchema: {
        type: "object",
        properties: {
          value: {
            type: "string",
            title: sanitizeExtensionUiText(ev.title ?? "Select"),
            oneOf: displayOptions.map((title, index) => ({
              const: `${CHOICE_OPTION_PREFIX}${index}`,
              title,
            })),
          },
        },
        required: ["value"],
      },
    });
    if (!this.isCurrentExtensionUi(id, generation)) return;
    let selectedIndex: number | undefined;
    for (const candidate of acceptedElicitationValues(response, "value", ["optionId"])) {
      if (!isString(candidate)) continue;
      const indexed = optionIndex(candidate);
      const displayIndex = displayOptions.indexOf(candidate);
      const index = indexed ?? (displayIndex >= 0 ? displayIndex : options.indexOf(candidate));
      if (index >= 0 && index < options.length) {
        selectedIndex = index;
        break;
      }
    }
    const value = selectedIndex === undefined ? null : (options[selectedIndex] ?? null);
    await this.settleExtensionUi(
      id,
      generation,
      value === null ? { id, cancelled: true } : { id, value },
    );
  }

  private async handleExtensionConfirm(
    ev: PiExtensionUiRequestEvent,
    id: string,
    generation: number,
  ): Promise<void> {
    if (this.conn.unstable_createElicitation === undefined) {
      const selected = await this.requestLegacyExtensionPermission(
        id,
        generation,
        ev,
        CONFIRM_PERMISSION_OPTIONS,
      );
      if (!this.isCurrentExtensionUi(id, generation)) return;
      await this.settleExtensionUi(
        id,
        generation,
        selected?.outcome.outcome === "selected"
          ? { id, confirmed: selected.outcome.optionId === "yes" }
          : { id, cancelled: true },
      );
      return;
    }

    const response = await this.requestExtensionPermission(id, generation, {
      mode: "form",
      sessionId: this.sessionId,
      message: extensionUiMessage(ev),
      requestedSchema: {
        type: "object",
        properties: {
          confirmed: {
            type: "boolean",
            title: sanitizeExtensionUiText(ev.title ?? "Confirm"),
          },
        },
        required: ["confirmed"],
      },
    });
    if (!this.isCurrentExtensionUi(id, generation)) return;
    const confirmed = acceptedElicitationValues(response, "confirmed").find(isBoolean);
    await this.settleExtensionUi(
      id,
      generation,
      confirmed === undefined ? { id, cancelled: true } : { id, confirmed },
    );
  }

  private async requestExtensionPermission(
    id: string,
    generation: number,
    request: CreateElicitationRequest,
  ): Promise<CreateElicitationResponse | null> {
    const pending = this.pendingExtensionUi.get(id);
    if (!pending || pending.generation !== generation) return null;
    const conn = this.conn;
    const createElicitation = conn.unstable_createElicitation;
    if (createElicitation === undefined) return null;
    const cancelled = pending.cancelled;
    try {
      return await Promise.race([createElicitation.call(conn, request), cancelled]);
    } catch {
      return null;
    }
  }

  private async requestLegacyExtensionPermission(
    id: string,
    generation: number,
    ev: PiExtensionUiRequestEvent,
    options: PermissionOption[],
  ): Promise<PermissionResponse | null> {
    const pending = this.pendingExtensionUi.get(id);
    if (!pending || pending.generation !== generation) return null;
    const conn = this.conn;
    const sessionId = this.sessionId;
    const toolCall = extensionUiToolCall(id, ev);
    const cancelled = pending.cancelled;
    try {
      return await Promise.race([
        conn.requestPermission({ sessionId, toolCall, options }),
        cancelled,
      ]);
    } catch {
      return null;
    }
  }

  private async handleExtensionText(
    ev: PiExtensionUiRequestEvent,
    id: string,
    generation: number,
    method: "input" | "editor",
  ): Promise<void> {
    if (this.conn.unstable_createElicitation === undefined) {
      this.emitExtensionUiMessage(
        `Pi ${method} UI request is not supported in ACP yet; cancelling it.`,
      );
      await this.settleExtensionUi(id, generation, { id, cancelled: true });
      return;
    }

    const response = await this.requestExtensionPermission(id, generation, {
      mode: "form",
      sessionId: this.sessionId,
      message: extensionUiMessage(ev),
      requestedSchema: {
        type: "object",
        properties: {
          value: {
            type: "string",
            title:
              boundedExtensionUiString(ev.title, MAX_EXTENSION_UI_FALLBACK_LENGTH) ??
              (method === "editor" ? "Edit text" : "Input"),
            description: boundedExtensionUiString(ev.placeholder, MAX_EXTENSION_UI_TEXT_LENGTH),
            default: boundedExtensionUiString(ev.prefill, MAX_EXTENSION_UI_TEXT_LENGTH),
            maxLength: MAX_EXTENSION_UI_TEXT_LENGTH,
            _meta: method === "editor" ? { piAcp: { multiline: true } } : undefined,
          },
        },
        required: ["value"],
      },
    });
    if (!this.isCurrentExtensionUi(id, generation)) return;
    const value = acceptedElicitationValues(response, "value").find(isString);
    await this.settleExtensionUi(
      id,
      generation,
      value === undefined
        ? { id, cancelled: true }
        : { id, value: value.slice(0, MAX_EXTENSION_UI_TEXT_LENGTH) },
    );
  }

  private isCurrentExtensionUi(id: string, generation: number): boolean {
    const pending = this.pendingExtensionUi.get(id);
    return (
      this.extensionUiActive &&
      this.extensionUiGeneration === generation &&
      pending?.generation === generation
    );
  }

  private async settleExtensionUi(
    id: string,
    generation: number,
    response: ExtensionUiResponse,
  ): Promise<void> {
    const pending = this.pendingExtensionUi.get(id);
    if (!pending || pending.generation !== generation) return;
    this.pendingExtensionUi.delete(id);
    this.settledExtensionUi.add(id);
    clearTimeout(pending.timer);
    pending.release();
    const proc = this.proc;
    try {
      await proc.sendExtensionUiResponse?.(response);
    } catch {
      // A disconnected subprocess cannot receive the response; do not retry it.
    }
  }

  private emitExtensionUiMessage(text: string): void {
    this.emit({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: sanitizeExtensionUiText(text) } satisfies ContentBlock,
    });
  }
}

/**
 * Candidate values a client may have supplied for one elicitation field.
 *
 * Clients place accepted content in `content`, in `_meta`, or in `_meta.content`,
 * and some place it directly on the response, so every source is inspected in
 * that precedence order.
 */
function acceptedElicitationValues(
  response: CreateElicitationResponse | null,
  field: string,
  aliases: readonly string[] = [],
): BoundaryValue[] {
  if (!response || response.action !== "accept") return [];
  const responseValue: BoundaryValue = response;
  if (!isBoundaryRecord(responseValue)) return [];
  const content = recordField(responseValue, "content");
  const meta = recordField(responseValue, "_meta");
  const metaContent = meta === undefined ? undefined : recordField(meta, "content");
  const keys = [field, ...aliases];
  const values: BoundaryValue[] = [];
  for (const source of [content, meta, metaContent, responseValue]) {
    if (!source) continue;
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined) values.push(value);
    }
  }
  return values;
}

function extensionUiTimeoutMs(ev: PiExtensionUiRequestEvent): number {
  const value = ev.timeoutMs;
  return value !== undefined && value > 0
    ? Math.min(value, EXTENSION_UI_TIMEOUT_MS)
    : EXTENSION_UI_TIMEOUT_MS;
}

function extensionUiMessage(ev: PiExtensionUiRequestEvent): string {
  const title = sanitizeExtensionUiText(ev.title ?? "").trim();
  const message = sanitizeExtensionUiText(ev.message ?? "").trim();
  if (title && message && title !== message) return `${title}\n\n${message}`;
  return title || message || "Pi requests input";
}

function extensionUiTitle(ev: PiExtensionUiRequestEvent): string | undefined {
  for (const candidate of [ev.title, ev.value, ev.text]) {
    const value = sanitizeExtensionUiText(candidate ?? "").trim();
    if (value) return value.slice(0, MAX_EXTENSION_UI_FALLBACK_LENGTH);
  }
  return undefined;
}

function isSensitiveUiRequest(ev: PiExtensionUiRequestEvent): boolean {
  const parts: string[] = [ev.method ?? ""];
  for (const value of [ev.title, ev.message, ev.placeholder]) {
    if (value !== undefined) parts.push(value);
  }
  return SENSITIVE_UI_REQUEST.test(parts.join(" "));
}

/**
 * Tool arguments while the model is still streaming them: the decoded object when
 * pi already supplies one, otherwise the partial JSON text decoded if it parses.
 */
function streamedToolArguments(toolCall: PiAssistantToolCall | undefined): PiToolArguments {
  const args = toolCall?.arguments;
  if (isObjectValue(args) || isBoundaryArray(args)) return args;

  const partialArgs = toolCall?.partialArgs ?? "";
  if (!partialArgs) return undefined;
  const parsed = parseJsonLine(partialArgs);
  return parsed === undefined ? { partialArgs } : parsed;
}

function boundedToolRawInput(value: PiToolArguments): BoundedToolRawInput {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return {
      rawInput: { preview: "Raw input could not be serialized." },
      truncation: { truncated: true, limitCharacters: MAX_EXTENSION_UI_TEXT_LENGTH },
    };
  }
  if (serialized === undefined || serialized.length <= MAX_EXTENSION_UI_TEXT_LENGTH) {
    return { rawInput: value };
  }

  const indicator = "\n…[truncated]";
  return {
    rawInput: {
      preview: `${serialized.slice(0, MAX_EXTENSION_UI_TEXT_LENGTH - indicator.length)}${indicator}`,
    },
    truncation: {
      truncated: true,
      originalCharacters: serialized.length,
      limitCharacters: MAX_EXTENSION_UI_TEXT_LENGTH,
    },
  };
}

function toolCallMeta(
  presentation: EditorToolPresentation,
  boundedInput: BoundedToolRawInput,
): ToolCallMeta {
  const meta: ToolCallMeta = { editorToolPresentation: presentation };
  const truncation = boundedInput.truncation;
  // Untruncated raw input needs no truncation report at all.
  if (truncation) meta.piAcp = { rawInputTruncation: truncation };
  return meta;
}

/** One extension UI option list, bounded in both entry count and entry length. */
function boundedExtensionUiOptions(options: BoundaryValue[], maxLength: number): string[] {
  return options
    .slice(0, 100)
    .map((item) => sanitizeExtensionUiText(String(item).slice(0, maxLength)));
}

/**
 * Sanitize and bound every renderable field of an extension UI request.
 *
 * `maxLength` bounds each individual string; `EXTENSION_UI_RAW_INPUT_KEYS` records
 * the published field set this mirrors.
 */
function extensionUiRawInput(
  ev: PiExtensionUiRequestEvent,
  maxLength: number,
): ExtensionUiRawInput {
  const rawInput: ExtensionUiRawInput = {
    method: sanitizeExtensionUiText(ev.method ?? "ui"),
  };
  if (ev.title !== undefined) {
    rawInput.title = sanitizeExtensionUiText(ev.title.slice(0, maxLength));
  }
  if (ev.message !== undefined) {
    rawInput.message = sanitizeExtensionUiText(ev.message.slice(0, maxLength));
  }
  if (ev.options !== undefined) {
    rawInput.options = boundedExtensionUiOptions(ev.options, maxLength);
  }
  if (ev.placeholder !== undefined) {
    rawInput.placeholder = sanitizeExtensionUiText(ev.placeholder.slice(0, maxLength));
  }
  if (ev.prefill !== undefined) {
    rawInput.prefill = sanitizeExtensionUiText(ev.prefill.slice(0, maxLength));
  }
  return rawInput;
}

function boundedExtensionUiRawInput(ev: PiExtensionUiRequestEvent): ExtensionUiRawInput {
  return extensionUiRawInput(ev, MAX_EXTENSION_UI_FALLBACK_LENGTH);
}

function extensionUiFallbackMessage(ev: PiExtensionUiRequestEvent): string {
  const method = sanitizeExtensionUiText(ev.method ?? "unknown");
  const detail = extensionUiMessage(ev).slice(0, MAX_EXTENSION_UI_FALLBACK_LENGTH);
  return `Pi ${method} UI request is not supported; cancelling it. Open a Terminal Thread to use the interactive Pi UI. ${detail}`;
}

function extensionUiToolCall(id: string, ev: PiExtensionUiRequestEvent): ExtensionUiToolCall {
  const method = sanitizeExtensionUiText(ev.method ?? "ui");
  const title = sanitizeExtensionUiText(ev.title ?? `Pi ${method}`);
  const rawInput = extensionUiRawInput(ev, MAX_EXTENSION_UI_TEXT_LENGTH);
  rawInput.method = method;

  return {
    toolCallId: `pi-ui-${id}`,
    title,
    kind: "other",
    status: "pending",
    rawInput,
  };
}

function boundedExtensionUiString(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  return value === undefined ? undefined : sanitizeExtensionUiText(value.slice(0, maxLength));
}

function optionIndex(optionId: string): number | null {
  if (!optionId.startsWith(CHOICE_OPTION_PREFIX)) {
    return null;
  }

  const rawIndex = optionId.slice(CHOICE_OPTION_PREFIX.length);
  if (!rawIndex) {
    return null;
  }

  const index = Number(rawIndex);
  return Number.isSafeInteger(index) && index >= 0 && String(index) === rawIndex ? index : null;
}

function formatAutoRetryMessage(ev: PiAutoRetryStartEvent): string {
  const attempt = ev.attempt;
  const maxAttempts = ev.maxAttempts;
  const delayMs = ev.delayMs;

  // Fail closed on absent or non-finite counters rather than rendering NaN to the client.
  if (!isFiniteNumber(attempt) || !isFiniteNumber(maxAttempts) || !isFiniteNumber(delayMs)) {
    return "Retrying...";
  }

  let delaySeconds = Math.round(delayMs / 1000);
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1;

  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`;
}

function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case "read":
      return "read";
    case "write":
    case "edit":
      return "edit";
    case "bash":
      return "execute";
    default:
      return "other";
  }
}
