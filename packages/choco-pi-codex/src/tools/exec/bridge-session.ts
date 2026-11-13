import { StringDecoder } from "node:string_decoder";
import { getCodexShellArgs } from "../../adapter/prompt/runtime-shell.ts";
import {
  chunkToBytes,
  createExecBridgeClient,
  type BridgeReadResponse,
  type ExecBridgeClient,
} from "./bridge-client.ts";
import { formatDroppedOutputNotice } from "./output.ts";

const EXIT_OUTPUT_GRACE_MS = 100;

export interface BridgeExecInput {
  command: string;
  executionCommand: string;
  executionEnv: NodeJS.ProcessEnv;
  tty?: boolean | undefined;
  login?: boolean | undefined;
}

export interface BridgeExecSession {
  id: number;
  processId: string;
  startup: Promise<void>;
  started: boolean;
  tty: boolean;
  command: string;
  buffer: string;
  bufferStartOffset: number;
  emittedOffset: number;
  outputVersion: number;
  exitCode: number | null | undefined;
  listeners: Set<() => void>;
  interactive: boolean;
  nextEmptyPollYieldMs?: number | undefined;
  lastSeq: number;
  /** Chunks the bridge discarded before the host read them (see {@link poll}). */
  droppedChunks: number;
  startedAt: number;
  updatedAt: number;
  finalized: boolean;
  exposed: boolean;
  terminating: boolean;
  outputDecoders: Record<"stdout" | "stderr" | "pty", StringDecoder>;
  outputDecodersFlushed: boolean;
  postExitIdleSince?: number | undefined;
  observedExitCode?: number | null | undefined;
}

export interface BridgeSessionHooks {
  isOwned(session: BridgeExecSession): boolean;
  onOutput(session: BridgeExecSession, text: string): void;
  onExit(session: BridgeExecSession): void;
}

export interface BridgeSessionRuntime {
  create(args: {
    id: number;
    input: BridgeExecInput;
    workdir: string;
    shell: string;
    signal?: AbortSignal | undefined;
    hooks: BridgeSessionHooks;
  }): BridgeExecSession;
  poll(
    session: BridgeExecSession,
    hooks: BridgeSessionHooks,
    waitMs?: number,
    maxBytes?: number,
  ): Promise<void>;
  waitForStartup(session: BridgeExecSession, signal?: AbortSignal): Promise<void>;
  write(session: BridgeExecSession, chars: string): Promise<void>;
  terminate(session: BridgeExecSession): Promise<void>;
  shutdown(): Promise<void>;
}

/** Exit code of a closed session that has none yet. A terminated session without a real failure code exits 143 (SIGTERM). */
function setClosedExitCode(session: BridgeExecSession, code: number | null | undefined): void {
  if (session.exitCode !== undefined && session.exitCode !== null) return;
  if (session.terminating) {
    session.exitCode = code ? code : 143;
    return;
  }
  session.exitCode = code ?? 1;
}

function failSession(session: BridgeExecSession, hooks: BridgeSessionHooks, message: string): void {
  hooks.onOutput(session, `${message}\n`);
  session.exitCode = 1;
  hooks.onExit(session);
}

/**
 * The bridge keeps a bounded ring (about 8 MiB) of unread output per process and discards the
 * oldest chunks when the host does not read in time, for example while the event loop is
 * stalled. The discard is only visible as a gap before the first returned chunk; surface it in
 * the transcript so the reader never mistakes a truncated head for the whole output. `nextSeq`
 * alone is not evidence: the bridge spends sequence numbers on exit records that never arrive
 * as chunks.
 */
function noteDroppedChunks(
  session: BridgeExecSession,
  hooks: BridgeSessionHooks,
  firstSeq: number | undefined,
): void {
  if (firstSeq === undefined || firstSeq <= session.lastSeq + 1) return;
  const dropped = firstSeq - session.lastSeq - 1;
  session.droppedChunks += dropped;
  hooks.onOutput(session, formatDroppedOutputNotice(dropped));
  session.lastSeq = firstSeq - 1;
}

/** Decodes and emits the chunks; returns whether there were any. */
function emitChunks(
  session: BridgeExecSession,
  hooks: BridgeSessionHooks,
  chunks: BridgeReadResponse["chunks"],
): boolean {
  for (const chunk of chunks ?? []) {
    hooks.onOutput(session, session.outputDecoders[chunk.stream].write(chunkToBytes(chunk.chunk)));
    session.lastSeq = Math.max(session.lastSeq, chunk.seq);
  }
  return (chunks?.length ?? 0) > 0;
}

function noteExit(
  session: BridgeExecSession,
  exitCode: number | null | undefined,
  receivedOutput: boolean,
): void {
  session.observedExitCode = exitCode;
  if (session.postExitIdleSince === undefined || receivedOutput) {
    session.postExitIdleSince = Date.now();
  }
}

function postExitIdleElapsed(session: BridgeExecSession): boolean {
  return (
    session.postExitIdleSince !== undefined &&
    Date.now() - session.postExitIdleSince >= EXIT_OUTPUT_GRACE_MS
  );
}

function closeSession(
  session: BridgeExecSession,
  hooks: BridgeSessionHooks,
  exitCode: number | null | undefined,
): void {
  if (!session.outputDecodersFlushed) {
    session.outputDecodersFlushed = true;
    for (const decoder of Object.values(session.outputDecoders))
      hooks.onOutput(session, decoder.end());
  }
  setClosedExitCode(session, exitCode ?? session.observedExitCode);
  hooks.onExit(session);
}

/** The runtime's `poll`, bound to one bridge client. */
function createSessionPoller(bridge: ExecBridgeClient): BridgeSessionRuntime["poll"] {
  return async (session, hooks, waitMs = 0, maxBytes) => {
    if (!hooks.isOwned(session)) return;
    const response = await bridge.read({
      op: "read",
      process_id: session.processId,
      after_seq: session.lastSeq,
      max_bytes: maxBytes,
      wait_ms: waitMs,
    });
    noteDroppedChunks(session, hooks, response.chunks?.[0]?.seq);
    const receivedOutput = emitChunks(session, hooks, response.chunks);
    session.lastSeq = Math.max(session.lastSeq, response.nextSeq - 1);
    if (response.exited) noteExit(session, response.exitCode, receivedOutput);
    if (response.closed || postExitIdleElapsed(session)) {
      closeSession(session, hooks, response.exitCode);
    }
  };
}

function newBridgeExecSession(id: number, input: BridgeExecInput): BridgeExecSession {
  const now = Date.now();
  return {
    id,
    processId: `pi-${id}`,
    startup: Promise.resolve(),
    started: false,
    tty: Boolean(input.tty),
    command: input.command,
    buffer: "",
    bufferStartOffset: 0,
    emittedOffset: 0,
    outputVersion: 0,
    exitCode: undefined,
    listeners: new Set(),
    interactive: Boolean(input.tty),
    lastSeq: 0,
    droppedChunks: 0,
    startedAt: now,
    updatedAt: now,
    finalized: false,
    exposed: false,
    terminating: false,
    outputDecoders: {
      stdout: new StringDecoder("utf8"),
      stderr: new StringDecoder("utf8"),
      pty: new StringDecoder("utf8"),
    },
    outputDecodersFlushed: false,
  };
}

async function waitForStartup(session: BridgeExecSession, signal?: AbortSignal): Promise<void> {
  if (!signal) return session.startup;
  if (signal.aborted) throw new Error("exec_command aborted");
  let removeAbortListener = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new Error("exec_command aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    await Promise.race([session.startup, aborted]);
  } finally {
    removeAbortListener();
  }
}

export function createBridgeSessionRuntime(
  binaryPath?: () => string | undefined,
): BridgeSessionRuntime {
  const bridge = createExecBridgeClient(binaryPath);
  const poll = createSessionPoller(bridge);
  let pollQueue = Promise.resolve();

  // Background polls run one at a time across sessions.
  async function pollBackground(
    session: BridgeExecSession,
    hooks: BridgeSessionHooks,
  ): Promise<void> {
    const previous = pollQueue;
    let release!: () => void;
    pollQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await poll(session, hooks, 250);
    } finally {
      release();
    }
  }

  async function pollLoop(session: BridgeExecSession, hooks: BridgeSessionHooks): Promise<void> {
    while (
      hooks.isOwned(session) &&
      (session.exitCode === undefined || session.exitCode === null)
    ) {
      try {
        await pollBackground(session, hooks);
      } catch (error) {
        failSession(session, hooks, error instanceof Error ? error.message : String(error));
        return;
      }
    }
  }

  async function start(
    session: BridgeExecSession,
    args: Parameters<BridgeSessionRuntime["create"]>[0],
  ): Promise<void> {
    const { input, workdir, shell, signal, hooks } = args;
    try {
      const shellArgs = getCodexShellArgs(shell, input.executionCommand, input.login ?? true);
      await bridge.request({
        op: "exec",
        process_id: session.processId,
        argv: [shell, ...shellArgs],
        cwd: workdir,
        env: input.executionEnv,
        tty: Boolean(input.tty),
        pipe_stdin: Boolean(input.tty),
        arg0: null,
      });
      session.started = true;
      if (signal?.aborted) {
        session.terminating = true;
        await bridge.request({ op: "terminate", process_id: session.processId });
      }
      void pollLoop(session, hooks);
    } catch (error) {
      failSession(session, hooks, error instanceof Error ? error.message : String(error));
    }
  }

  return {
    create(args) {
      const session = newBridgeExecSession(args.id, args.input);
      session.startup = start(session, args);
      return session;
    },
    poll,
    waitForStartup,
    write: async (session, chars) => {
      await bridge.request({
        op: "write",
        process_id: session.processId,
        chunk: Array.from(Buffer.from(chars, "utf8")),
      });
    },
    terminate: async (session) => {
      await bridge.request({ op: "terminate", process_id: session.processId });
    },
    shutdown: () => bridge.shutdown(),
  };
}
