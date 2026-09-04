import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";
import { type BoundaryValue, errorCode, parseJsonLine } from "../boundary.ts";
import { PiCommandResolutionError, resolvePiLaunch } from "./command.ts";
import {
  decodePiAvailableModels,
  decodePiCommands,
  decodePiCompactResult,
  decodePiExportHtml,
  decodePiMessages,
  decodePiRpcEvent,
  decodePiRpcResponse,
  decodePiSessionStats,
  decodePiState,
  type PiAvailableModels,
  type PiCommands,
  type PiCompactResult,
  type PiExportHtml,
  type PiExtensionUiResponse,
  type PiMessages,
  type PiPromptImage,
  type PiRpcEvent,
  type PiRpcResponse,
  type PiSessionStats,
  type PiState,
  type PiThinkingLevel,
  type PiTurnMode,
} from "./protocol.ts";

export type { PiRpcEvent } from "./protocol.ts";

export type PiRpcSpawnErrorOptions = {
  code?: string;
  cause?: BoundaryValue;
};

export class PiRpcSpawnError extends Error {
  /** Underlying spawn error code, e.g. ENOENT, EACCES */
  code?: string;

  constructor(message: string, opts?: PiRpcSpawnErrorOptions) {
    super(message, { cause: opts?.cause });
    this.name = "PiRpcSpawnError";
    this.code = opts?.code;
  }
}

const ESC = String.fromCharCode(0x1b);
const CSI = String.fromCharCode(0x9b);

const ANSI_ESCAPE_REGEX = new RegExp(
  `[${ESC}${CSI}][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  "g",
);

function stripAnsi(s: string): string {
  // Basic ANSI escape stripping (colors, cursor movement, etc.)
  return s.replace(ANSI_ESCAPE_REGEX, "");
}

type PiRpcCommand =
  | { type: "prompt"; id?: string; message: string; images?: PiPromptImage[] }
  | { type: "abort"; id?: string }
  | { type: "get_state"; id?: string }
  // Model
  | { type: "get_available_models"; id?: string }
  | { type: "set_model"; id?: string; provider: string; modelId: string }
  // Thinking
  | {
      type: "set_thinking_level";
      id?: string;
      level: PiThinkingLevel;
    }
  // Modes
  | { type: "set_follow_up_mode"; id?: string; mode: PiTurnMode }
  | { type: "set_steering_mode"; id?: string; mode: PiTurnMode }
  // Compaction
  | { type: "compact"; id?: string; customInstructions?: string }
  | { type: "set_auto_compaction"; id?: string; enabled: boolean }
  // Session
  | { type: "get_session_stats"; id?: string }
  | { type: "set_session_name"; id?: string; name: string }
  | { type: "export_html"; id?: string; outputPath?: string }
  | { type: "switch_session"; id?: string; sessionPath: string }
  // Messages
  | { type: "get_messages"; id?: string }
  // Commands
  | { type: "get_commands"; id?: string };

type SpawnParams = {
  cwd: string;
  /** Optional override for `pi` executable name/path */
  piCommand?: string;
  /** If set, pi will persist the session to this exact file (via `--session <path>`). */
  sessionPath?: string;
};

export type PiRpcInitialState = {
  state: PiState;
  availableModels: PiAvailableModels;
  commands: PiCommands;
};

export type PiRpcExit = { code: number | null; signal: NodeJS.Signals | null };

/** Bounded human-readable stdout retained before Pi's NDJSON protocol starts. */
export type PiRpcPrelude = {
  lines: string[];
  truncated: boolean;
};

/**
 * The subset of `PiRpcProcess` that sessions, the agent, and test fakes depend on.
 * Only event subscription and prompting are mandatory; every other member is
 * optional so a narrow fake stays assignable without a type assertion.
 */
export type PiRpcProcessLike = {
  onEvent(handler: (ev: PiRpcEvent) => void): () => void;
  prompt(message: string, images?: PiPromptImage[]): Promise<void>;
  onExit?(listener: (exit: PiRpcExit) => void): () => void;
  abort?(): Promise<void>;
  getState?(): Promise<PiState>;
  getAvailableModels?(): Promise<PiAvailableModels>;
  getCommands?(): Promise<PiCommands>;
  getMessages?(): Promise<PiMessages>;
  compact?(customInstructions?: string): Promise<PiCompactResult>;
  setModel?(provider: string, modelId: string): Promise<void>;
  setThinkingLevel?(level: PiThinkingLevel): Promise<void>;
  setFollowUpMode?(mode: PiTurnMode): Promise<void>;
  setSteeringMode?(mode: PiTurnMode): Promise<void>;
  setAutoCompaction?(enabled: boolean): Promise<void>;
  getSessionStats?(): Promise<PiSessionStats>;
  setSessionName?(name: string): Promise<void>;
  exportHtml?(outputPath?: string): Promise<PiExportHtml>;
  sendExtensionUiResponse?(response: PiExtensionUiResponse): Promise<void>;
  shutdown?(graceMs?: number): Promise<PiRpcExit>;
  dispose?(): void;
};

export const DEFAULT_SHUTDOWN_GRACE_MS = 1_500;
export const PI_RPC_PRELUDE_MAX_BYTES = 64 * 1_024;
export const PI_RPC_PRELUDE_MAX_LINES = 256;

export class PiRpcStaleContextError extends Error {
  constructor() {
    super("Pi RPC process is shutting down");
    this.name = "PiRpcStaleContextError";
  }
}

type PendingRequest = {
  resolve: (value: PiRpcResponse) => void;
  reject: (error: BoundaryValue) => void;
};

function failureText(response: PiRpcResponse): string {
  return response.error ?? JSON.stringify(response.data);
}

export class PiRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private eventHandlers: Array<(ev: PiRpcEvent) => void> = [];
  private readonly preludeLines: string[] = [];
  private preludeBytes = 0;
  private preludeTruncated = false;
  private receivedJsonFrame = false;
  private readonly exitPromise: Promise<PiRpcExit>;
  private settleExit!: (exit: PiRpcExit) => void;
  private exit: PiRpcExit | null = null;
  private exitListeners: Array<(exit: PiRpcExit) => void> = [];
  private generation = 0;
  private active = true;
  private shutdownPromise: Promise<PiRpcExit> | null = null;
  private shutdownCause: BoundaryValue;
  private stderrDiagnostic = "";

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.exitPromise = new Promise<PiRpcExit>((resolve) => {
      this.settleExit = resolve;
    });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      // `parseJsonLine` reports malformed input as undefined; JSON text never decodes
      // to undefined, so this stays an unambiguous decode failure.
      const frame = parseJsonLine(line);
      if (frame === undefined) {
        // pi may emit a human-readable prelude on stdout before NDJSON starts.
        // Capture a bounded prefix so the ACP adapter can surface it on session
        // start. Once NDJSON starts, fail closed instead of treating malformed
        // protocol content as more human-readable output.
        if (this.receivedJsonFrame) {
          const error = new Error(
            `Malformed Pi RPC stdout frame after protocol start (bytes=${Buffer.byteLength(line, "utf8")}).`,
          );
          void this.stop(DEFAULT_SHUTDOWN_GRACE_MS, error, "on-exit");
          return;
        }
        const cleaned = stripAnsi(String(line)).trimEnd();
        if (this.preludeTruncated) return;
        const bytes = Buffer.byteLength(cleaned, "utf8");
        if (!cleaned) return;
        if (
          this.preludeLines.length >= PI_RPC_PRELUDE_MAX_LINES ||
          this.preludeBytes + bytes > PI_RPC_PRELUDE_MAX_BYTES
        ) {
          this.preludeTruncated = true;
          return;
        }
        this.preludeLines.push(cleaned);
        this.preludeBytes += bytes;
        return;
      }

      this.receivedJsonFrame = true;

      const response = decodePiRpcResponse(frame);
      if (response) {
        const id = response.id;
        if (id) {
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            pending.resolve(response);
            return;
          }
        }
      }

      const event = decodePiRpcEvent(frame);
      for (const h of this.eventHandlers) h(event);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (this.stderrDiagnostic.length >= 8_192) return;
      this.stderrDiagnostic += stripAnsi(chunk.toString("utf8")).slice(0, 8_192);
    });

    // `close` waits for the separated stdio streams to close, so any bounded stderr
    // diagnostic is available before pending initialization requests are rejected.
    child.on("close", (code, signal) => this.finish({ code, signal }));

    child.on("error", (err) => {
      this.finish({ code: null, signal: null }, err);
    });
  }

  private finish(exit: PiRpcExit, cause?: BoundaryValue): void {
    if (this.exit) return;
    this.exit = exit;
    this.active = false;
    this.generation += 1;
    const trustFailure = /untrusted|project trust|approve/i.test(this.stderrDiagnostic);
    const error = trustFailure
      ? new PiRpcSpawnError(
          "Pi refused project-local configuration because this project is not trusted. Run `choco-pi-acp --terminal-trust <absolute-project-path>` once in a terminal, review the project files, and approve only if you trust them. The ACP adapter never adds --approve automatically.",
          { cause },
        )
      : (cause ??
        this.shutdownCause ??
        new Error(`pi process exited (code=${exit.code}, signal=${exit.signal})`));
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.settleExit(exit);
    // Exit notification is the single place session-level state learns the child
    // is gone. Listeners are detached before dispatch so each fires exactly once
    // even if a listener re-enters, and a throwing listener cannot starve the
    // rest: the child is already dead, so there is nothing left to abort.
    const listeners = this.exitListeners;
    this.exitListeners = [];
    for (const listener of listeners) {
      try {
        listener(exit);
      } catch {
        // A failed observer must not suppress the remaining observers.
      }
    }
  }

  /** Resolves with the recorded exit once the child has fully exited. */
  get exited(): Promise<PiRpcExit> {
    return this.exitPromise;
  }

  /**
   * Subscribe to child exit. The listener runs exactly once. A subscriber that
   * registers after the child already exited is invoked immediately with the
   * recorded exit, so a late subscriber can never miss the event and hang.
   * Returns an unsubscribe function that is safe to call more than once.
   */
  onExit(listener: (exit: PiRpcExit) => void): () => void {
    const recorded = this.exit;
    if (recorded) {
      try {
        listener(recorded);
      } catch {
        // Matches the dispatch path in `finish`.
      }
      return () => {};
    }
    this.exitListeners.push(listener);
    return () => {
      const index = this.exitListeners.indexOf(listener);
      if (index >= 0) this.exitListeners.splice(index, 1);
    };
  }

  private assertCurrent(generation: number): void {
    if (!this.active || this.generation !== generation) throw new PiRpcStaleContextError();
  }

  static async spawn(params: SpawnParams): Promise<PiRpcProcess> {
    let launch;
    try {
      launch = resolvePiLaunch(params.piCommand);
    } catch (error) {
      if (error instanceof PiCommandResolutionError) {
        throw new PiRpcSpawnError(error.message, { code: error.code, cause: error });
      }
      throw error;
    }

    // Speed/robustness for ACP:
    // - themes are irrelevant in rpc mode and can be noisy/slow to load.
    // Keep extensions + prompt templates enabled because ACP users may rely on them
    // (e.g. MCP extensions, prompt templates for workflows).
    const args = [...launch.argsPrefix, "--mode", "rpc", "--no-themes"];
    if (params.sessionPath) args.push("--session", params.sessionPath);

    const child = spawn(launch.command, args, {
      cwd: params.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      shell: false,
    });
    const proc = new PiRpcProcess(child);
    const generation = proc.generation;
    const launchCommand = launch.command;

    // Ensure spawn failures (e.g. ENOENT when pi isn't installed) are surfaced as a
    // deterministic error instead of later EPIPE/internal-error noise.
    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup();
          resolve();
        };
        const onError = (err: Error) => {
          cleanup();
          reject(err);
        };
        const cleanup = () => {
          child.off("spawn", onSpawn);
          child.off("error", onError);
        };

        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
    } catch (failure) {
      // SAFETY: a rejected spawn settlement carries an arbitrary runtime value;
      // `errorCode` performs the object/string checks before reading `code`.
      const cause = failure as BoundaryValue;
      const code = errorCode(cause);
      if (code === "ENOENT") {
        throw new PiRpcSpawnError(
          `Could not start pi: executable not found (${launchCommand}). Pi needs to be installed before it can run in ACP clients. Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH. Then try again.`,
          { code, cause },
        );
      }

      if (code === "EACCES") {
        throw new PiRpcSpawnError(`Could not start pi: permission denied (${launchCommand}).`, {
          code,
          cause,
        });
      }

      throw new PiRpcSpawnError(`Could not start pi (${launchCommand}).`, { code, cause });
    }

    proc.assertCurrent(generation);

    return proc;
  }

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
    };
  }

  dispose(): void {
    void this.shutdown();
  }

  shutdown(graceMs = DEFAULT_SHUTDOWN_GRACE_MS): Promise<PiRpcExit> {
    return this.stop(graceMs, new PiRpcStaleContextError());
  }

  private stop(
    graceMs: number,
    cause: BoundaryValue,
    pendingSettlement: "immediate" | "on-exit" = "immediate",
  ): Promise<PiRpcExit> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (this.exit) return Promise.resolve(this.exit);

    this.shutdownCause = cause;
    this.active = false;
    this.generation += 1;
    if (pendingSettlement === "immediate") {
      for (const pending of this.pending.values()) pending.reject(cause);
      this.pending.clear();
    }

    const child = this.child;
    try {
      child.kill("SIGTERM");
    } catch {
      // The exit/error handlers remain the canonical settlement path.
    }

    const boundedGraceMs = Math.max(0, Math.min(graceMs, 30_000));
    const timer = setTimeout(() => {
      if (this.exit) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // The exit/error handlers remain the canonical settlement path.
      }
    }, boundedGraceMs);
    timer.unref();

    this.shutdownPromise = this.exitPromise.finally(() => clearTimeout(timer));
    return this.shutdownPromise;
  }

  /**
   * Consumes the bounded prefix of human-readable stdout lines emitted before RPC
   * NDJSON begins (e.g. Context/Skills/Extensions info), and reports whether the
   * child emitted additional nonempty prelude lines beyond either retention cap.
   */
  consumePreludeLines(): PiRpcPrelude {
    const lines = this.preludeLines.splice(0, this.preludeLines.length);
    return { lines, truncated: this.preludeTruncated };
  }

  async prompt(message: string, images: PiPromptImage[] = []): Promise<void> {
    const res = await this.request({ type: "prompt", message, images });
    if (!res.success) throw new Error(`pi prompt failed: ${failureText(res)}`);
  }

  async abort(): Promise<void> {
    const res = await this.request({ type: "abort" });
    if (!res.success) throw new Error(`pi abort failed: ${failureText(res)}`);
  }

  async getState(): Promise<PiState> {
    const res = await this.request({ type: "get_state" });
    if (!res.success) throw new Error(`pi get_state failed: ${failureText(res)}`);
    return decodePiState(res.data);
  }

  async getAvailableModels(): Promise<PiAvailableModels> {
    const res = await this.request({ type: "get_available_models" });
    if (!res.success) throw new Error(`pi get_available_models failed: ${failureText(res)}`);
    return decodePiAvailableModels(res.data);
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const res = await this.request({ type: "set_model", provider, modelId });
    if (!res.success) throw new Error(`pi set_model failed: ${failureText(res)}`);
  }

  async setThinkingLevel(level: PiThinkingLevel): Promise<void> {
    const res = await this.request({ type: "set_thinking_level", level });
    if (!res.success) throw new Error(`pi set_thinking_level failed: ${failureText(res)}`);
  }

  async setFollowUpMode(mode: PiTurnMode): Promise<void> {
    const res = await this.request({ type: "set_follow_up_mode", mode });
    if (!res.success) throw new Error(`pi set_follow_up_mode failed: ${failureText(res)}`);
  }

  async setSteeringMode(mode: PiTurnMode): Promise<void> {
    const res = await this.request({ type: "set_steering_mode", mode });
    if (!res.success) throw new Error(`pi set_steering_mode failed: ${failureText(res)}`);
  }

  async compact(customInstructions?: string): Promise<PiCompactResult> {
    const res = await this.request({ type: "compact", customInstructions });
    if (!res.success) throw new Error(`pi compact failed: ${failureText(res)}`);
    return decodePiCompactResult(res.data);
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    const res = await this.request({ type: "set_auto_compaction", enabled });
    if (!res.success) throw new Error(`pi set_auto_compaction failed: ${failureText(res)}`);
  }

  async getSessionStats(): Promise<PiSessionStats> {
    const res = await this.request({ type: "get_session_stats" });
    if (!res.success) throw new Error(`pi get_session_stats failed: ${failureText(res)}`);
    return decodePiSessionStats(res.data);
  }

  async setSessionName(name: string): Promise<void> {
    const res = await this.request({ type: "set_session_name", name });
    if (!res.success) throw new Error(`pi set_session_name failed: ${failureText(res)}`);
  }

  async exportHtml(outputPath?: string): Promise<PiExportHtml> {
    const res = await this.request({ type: "export_html", outputPath });
    if (!res.success) throw new Error(`pi export_html failed: ${failureText(res)}`);
    return decodePiExportHtml(res.data);
  }

  async switchSession(sessionPath: string): Promise<void> {
    const res = await this.request({ type: "switch_session", sessionPath });
    if (!res.success) throw new Error(`pi switch_session failed: ${failureText(res)}`);
  }

  async getMessages(): Promise<PiMessages> {
    const res = await this.request({ type: "get_messages" });
    if (!res.success) throw new Error(`pi get_messages failed: ${failureText(res)}`);
    return decodePiMessages(res.data);
  }

  async getCommands(): Promise<PiCommands> {
    const res = await this.request({ type: "get_commands" });
    if (!res.success) throw new Error(`pi get_commands failed: ${failureText(res)}`);
    return decodePiCommands(res.data);
  }

  async sendExtensionUiResponse(response: PiExtensionUiResponse): Promise<void> {
    await this.writeLine(`${JSON.stringify({ type: "extension_ui_response", ...response })}\n`);
  }

  private request(cmd: PiRpcCommand): Promise<PiRpcResponse> {
    const generation = this.generation;
    this.assertCurrent(generation);
    const id = crypto.randomUUID();
    const withId = { ...cmd, id };

    const line = `${JSON.stringify(withId)}\n`;

    return new Promise<PiRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      void this.writeLine(line, generation).catch((error) => {
        if (this.generation !== generation) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private writeLine(line: string, generation = this.generation): Promise<void> {
    this.assertCurrent(generation);
    const stdin = this.child.stdin;
    return new Promise<void>((resolve, reject) => {
      try {
        stdin.write(line, (error) => {
          if (this.generation !== generation || !this.active) {
            reject(new PiRpcStaleContextError());
            return;
          }
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }
}
