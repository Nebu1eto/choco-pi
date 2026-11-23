import { PiRpcProcess, PiRpcSpawnError } from "../pi-rpc/process.ts";
import { parseSlashInvocation } from "./pi-commands.ts";
import {
  type LoadSessionRequest,
  type InitializeRequest,
  type ListSessionsRequest,
  type Agent as ACPAgent,
  RequestError,
  type InitializeResponse,
  type NewSessionRequest,
  type AuthenticateRequest,
  type PromptRequest,
  type PromptResponse,
  type StopReason,
  type CancelNotification,
  type ListSessionsResponse,
  type SessionInfo,
  type LoadSessionResponse,
  type DeleteSessionRequest,
  type DeleteSessionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import {
  SessionManager,
  type AcpConnection,
  type PiAcpSession,
  PI_ACP_MAX_LIVE_SESSIONS,
} from "./session.ts";
import { SessionStore } from "./session-store.ts";
import {
  recordField,
  booleanField,
  stringField,
  type PiCommands,
  type PiState,
  type PiAvailableModels,
  type PiMessages,
  arrayField,
} from "../pi-rpc/protocol.ts";
import { type BoundaryValue, isString } from "../boundary.ts";
import { getEnableSkillCommands, getQuietStartup, getAgentDir } from "./pi-settings.ts";
import { existsSync, unlinkSync, readFileSync, readdirSync, statSync } from "node:fs";
import { findPiSession, listPiSessions } from "./pi-sessions.ts";
import { getAuthMethods } from "./auth.ts";
import { SessionCommandCatalogs } from "./agent-command-catalogs.ts";
import { replayPiMessages } from "./agent-history-replay.ts";
import { runBuiltinCommand } from "./agent-builtin-commands.ts";
import { isAbsolute, join, basename, dirname } from "node:path";
import { loadSlashCommands } from "./slash-commands.ts";
import { missingPiCapability, attemptRpc, failureText } from "./agent-rpc.ts";
import { maybeAuthRequiredError } from "./auth-required.ts";
import {
  getSessionConfiguration,
  setSessionModel,
  emitConfigOptionsUpdate,
  isThinkingLevel,
  MODEL_CONFIG_ID,
  THOUGHT_LEVEL_CONFIG_ID,
} from "./agent-session-config.ts";
import { promptToPiMessage } from "./translate/prompt.ts";
import { fileURLToPath } from "node:url";
import { probePiStartup, startupInfoAgentDirs } from "./agent-pi-version.ts";

export { readPiVersion, findPiChangelog, startupInfoAgentDirs } from "./agent-pi-version.ts";

/** The `name`/`version` pair read out of the nearest package manifest. */
type PackageIdentity = {
  name?: string;
  version?: string;
};

/** Where a known session's transcript lives on disk. */
type StoredSessionLocation = {
  cwd: string;
  sessionFile: string;
};

/** Construction options for {@link PiAcpAgent}. */
type PiAcpAgentConfig = {
  piCommand?: string;
};

/** Overrides applied when a stored session is respawned. */
type RestoreSessionOptions = {
  cwd?: string;
  mcpServers?: LoadSessionRequest["mcpServers"];
};

/** Request parameters of the unstable per-session model selection method. */
type SetSessionModelRequest = {
  sessionId: string;
  modelId: string;
};

/**
 * The `SessionManager` surface this agent drives.
 *
 * `retainRecent` is optional so a narrow injected manager stays assignable without a
 * type assertion; the real manager always provides it.
 */
export type SessionManagerLike = Pick<
  SessionManager,
  "create" | "maybeGet" | "getOrCreate" | "close" | "disposeAll" | "shutdownAll"
> & {
  get?: SessionManager["get"];
  retainRecent?: SessionManager["retainRecent"];
};

/** The persistent session-index operations used by the agent. */
export type SessionStoreLike = Pick<SessionStore, "get" | "upsert" | "delete">;

/** Decode Zed's terminal-auth capability from ACP's open metadata object. */
function clientSupportsTerminalAuthMeta(params: InitializeRequest): boolean {
  const capabilities = recordField(params, "clientCapabilities");
  const metadata = recordField(capabilities, "_meta");
  return booleanField(metadata, "terminal-auth") === true;
}

/** Decode the unstable cwd extension accepted by session/list clients. */
function listSessionsCwd(params: ListSessionsRequest): string | undefined {
  const cwd = stringField(params, "cwd");
  return cwd?.trim() ? cwd : undefined;
}

const pkg = readNearestPackageJson(import.meta.url);

export class PiAcpAgent implements ACPAgent {
  private readonly conn: AcpConnection;
  private readonly sessions: SessionManagerLike;
  private readonly store: SessionStoreLike = new SessionStore();
  private readonly restoringSessions = new Map<string, Promise<PiAcpSession>>();
  private readonly commandCatalogs = new SessionCommandCatalogs();
  private readonly piCommand?: string;
  private generation = 0;
  private active = true;

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    this.generation += 1;
    this.commandCatalogs.clear();
    this.sessions.disposeAll();
  }

  async shutdown(graceMs?: number): Promise<void> {
    if (!this.active) return;
    const sessions = this.sessions;
    this.active = false;
    this.generation += 1;
    this.commandCatalogs.clear();
    await sessions.shutdownAll(graceMs);
  }

  // Remember recent session cwd and use it as the default filter.
  private lastSessionCwd: string | null = null;

  constructor(conn: AcpConnection, config?: PiAcpAgentConfig) {
    this.conn = conn;
    this.sessions = new SessionManager();
    this.piCommand = config?.piCommand ?? process.env.PI_ACP_PI_COMMAND;
  }

  private assertCurrent(generation: number): void {
    if (!this.active || this.generation !== generation) {
      throw new Error("Pi ACP agent is shutting down");
    }
  }

  private async publishCommandCatalog(session: PiAcpSession, data?: BoundaryValue): Promise<void> {
    const generation = this.generation;
    const sessionId = session.sessionId;
    const proc = session.proc;
    const conn = this.conn;
    const cwd = session.cwd ?? process.cwd();
    const enableSkillCommands = getEnableSkillCommands(cwd);
    this.assertCurrent(generation);

    const getCommands = proc.getCommands;
    const emptyCommands: PiCommands = { commands: [] };
    const commandData: BoundaryValue =
      data ?? (getCommands ? await getCommands.call(proc) : emptyCommands);
    this.assertCurrent(generation);
    if (this.sessions.maybeGet(sessionId)?.proc !== proc) {
      throw new Error(`Pi ACP session was replaced while refreshing commands: ${sessionId}`);
    }

    const catalog = this.commandCatalogs.replace(sessionId, proc, commandData, enableSkillCommands);
    const { availableCommands } = catalog.snapshot();
    await conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [...availableCommands],
      },
    });
    this.assertCurrent(generation);
  }

  /** Refresh and publish one session's command catalog after extension reload/replacement. */
  async refreshAvailableCommands(sessionId: string): Promise<void> {
    const generation = this.generation;
    this.assertCurrent(generation);
    const session = await this.restoreSession(sessionId);
    this.assertCurrent(generation);
    await this.publishCommandCatalog(session);
    this.assertCurrent(generation);
  }

  /** Integration callback for lifecycle owners that observe a Pi extension reload. */
  createCommandRefreshHook(sessionId: string): () => Promise<void> {
    return () => this.refreshAvailableCommands(sessionId);
  }

  private cleanupFailedNewSession(sessionId: string, state?: PiState | null): void {
    this.sessions.close(sessionId);

    const stateFile = state?.sessionFile;
    const sessionFile =
      stateFile && stateFile.trim() ? stateFile : this.store.get(sessionId)?.sessionFile;

    if (sessionFile && sessionFile.trim()) {
      try {
        if (existsSync(sessionFile)) unlinkSync(sessionFile);
      } catch {
        // ignore cleanup failures; the auth/internal error is the primary result
      }
    }

    this.store.delete(sessionId);
  }

  private findStoredSession(sessionId: string): StoredSessionLocation | null {
    const stored = this.store.get(sessionId);
    if (stored?.cwd && stored?.sessionFile) {
      return { cwd: stored.cwd, sessionFile: stored.sessionFile };
    }

    const piSession = findPiSession(sessionId);
    if (!piSession) return null;

    this.store.upsert({
      sessionId,
      cwd: piSession.cwd,
      sessionFile: piSession.sessionFile,
    });

    return {
      cwd: piSession.cwd,
      sessionFile: piSession.sessionFile,
    };
  }

  private async restoreSession(
    sessionId: string,
    opts?: RestoreSessionOptions,
  ): Promise<PiAcpSession> {
    const generation = this.generation;
    const sessions = this.sessions;
    const conn = this.conn;
    const piCommand = this.piCommand;
    const restoringSessions = this.restoringSessions;
    this.assertCurrent(generation);
    const existing = this.sessions.maybeGet(sessionId);
    if (existing) return existing;

    const inFlight = this.restoringSessions.get(sessionId);
    if (inFlight) return inFlight;

    const restorePromise = (async () => {
      const stored = this.findStoredSession(sessionId);
      if (!stored) {
        throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`);
      }

      const cwd = opts?.cwd ?? stored.cwd;

      let proc: PiRpcProcess;
      try {
        proc = await PiRpcProcess.spawn({
          cwd,
          sessionPath: stored.sessionFile,
          piCommand,
        });
      } catch (error) {
        if (error instanceof PiRpcSpawnError) {
          throw RequestError.internalError({ code: error.code }, error.message);
        }
        throw error;
      }

      try {
        this.assertCurrent(generation);
      } catch (error) {
        await proc.shutdown();
        throw error;
      }

      let session: PiAcpSession;
      try {
        session = sessions.getOrCreate(sessionId, {
          cwd,
          mcpServers: opts?.mcpServers ?? [],
          conn,
          proc,
          fileCommands: [],
        });
      } catch (error) {
        await proc.shutdown();
        throw error;
      }

      this.lastSessionCwd = cwd;
      this.store.upsert({ sessionId, cwd, sessionFile: stored.sessionFile });

      return session;
    })();

    restoringSessions.set(sessionId, restorePromise);

    try {
      return await restorePromise;
    } finally {
      if (restoringSessions.get(sessionId) === restorePromise) restoringSessions.delete(sessionId);
    }
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    // We currently only support ACP protocol version 1.
    const supportedVersion = 1;
    const requested = params.protocolVersion;

    return {
      protocolVersion: requested === supportedVersion ? requested : supportedVersion,
      agentInfo: {
        name: pkg.name ?? "pi-acp",
        title: "pi ACP adapter",
        version: pkg.version ?? "0.0.0",
      },
      // Zed currently uses ClientCapabilities._meta["terminal-auth"] to decide whether to show
      // the "Authenticate" banner/button. If not supported, we still return the method for the registry.
      authMethods: getAuthMethods({
        supportsTerminalAuthMeta: clientSupportsTerminalAuthMeta(params),
      }),
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: false, sse: false },
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT === "true",
        },
        sessionCapabilities: {
          // **UNSTABLE** ACP capability used by Zed's codex-acp adapter.
          // Enables a native session picker in clients that support it.
          list: {},
          delete: {},
        },
      },
    };
  }

  async newSession(params: NewSessionRequest) {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
    }

    const generation = this.generation;
    const cwd = params.cwd;
    const conn = this.conn;
    this.assertCurrent(generation);
    this.lastSessionCwd = cwd;

    const fileCommands = loadSlashCommands(cwd);
    const enableSkillCommands = getEnableSkillCommands(cwd);
    // Started now so the version and update probes overlap the Pi child's startup; it never rejects.
    const startupProbe = probePiStartup(this.piCommand);

    // Pi doesn't support mcpServers, but we accept and store.
    const session = await this.sessions.create({
      cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
      fileCommands: [],
      piCommand: this.piCommand,
    });
    this.assertCurrent(generation);
    const proc = session.proc;
    const sessionId = session.sessionId;

    // Fetch state + models once (parallel) to reduce startup latency.
    const getState = proc.getState;
    const getAvailableModels = proc.getAvailableModels;
    const getCommands = proc.getCommands;
    if (!getState) throw missingPiCapability("get_state");
    if (!getAvailableModels) throw missingPiCapability("get_available_models");

    const [stateAttempt, availableModelsAttempt, commandsAttempt] = await Promise.all([
      attemptRpc(getState.call(proc)),
      attemptRpc(getAvailableModels.call(proc)),
      getCommands ? attemptRpc(getCommands.call(proc)) : Promise.resolve(null),
    ]);
    this.assertCurrent(generation);

    const state: PiState | null = stateAttempt.value;
    const stateErr = stateAttempt.error;
    const availableModels: PiAvailableModels | null = availableModelsAttempt.value;
    const availableModelsErr = availableModelsAttempt.error;
    const commands: PiCommands | null = commandsAttempt?.value ?? null;

    const availableModelsAuthErr = maybeAuthRequiredError(availableModelsErr);

    if (availableModelsAuthErr) {
      this.cleanupFailedNewSession(sessionId, state);
      throw availableModelsAuthErr;
    }

    if (availableModelsErr) {
      this.cleanupFailedNewSession(sessionId, state);
      throw RequestError.internalError({}, failureText(availableModelsErr));
    }

    // If pi has no models available after spawning, it's effectively unauthenticated.
    const rawModelsCount = Array.isArray(availableModels?.models)
      ? availableModels.models.length
      : 0;

    if (rawModelsCount === 0) {
      this.cleanupFailedNewSession(sessionId, state);
      throw RequestError.authRequired(
        { authMethods: getAuthMethods() },
        "Configure an API key or log in with an OAuth provider.",
      );
    }

    if (stateErr && maybeAuthRequiredError(stateErr)) {
      this.cleanupFailedNewSession(sessionId, state);
      throw RequestError.authRequired(
        { authMethods: getAuthMethods() },
        "Configure an API key or log in with an OAuth provider.",
      );
    }

    const { configOptions, models, modes } = await getSessionConfiguration(proc, {
      state,
      availableModels,
    });
    this.assertCurrent(generation);

    const quietStartup = getQuietStartup(cwd);
    const { piVersion, updateNotice } = await startupProbe;
    this.assertCurrent(generation);

    // If quietStartup is enabled, suppress the full "startup info" prelude, but still surface
    // the "New version available" notice (if any) since it's high-signal and actionable.
    const preludeText = quietStartup
      ? updateNotice
        ? updateNotice + "\n"
        : ""
      : buildStartupInfo({
          cwd,
          fileCommands,
          updateNotice,
          piVersion,
        });

    if (preludeText) session.setStartupInfo(preludeText);

    // Keep recently active threads live in this ACP connection, bounded so clients that never
    // explicitly close old threads cannot leak an unlimited number of Pi subprocesses.
    //
    // (Tests sometimes stub out `this.sessions`, so guard the call.)
    this.sessions.retainRecent?.(sessionId, PI_ACP_MAX_LIVE_SESSIONS);

    const fallbackCommandData: BoundaryValue = {
      commands: fileCommands.map((command) => ({
        name: command.name,
        description: command.description,
        source: "prompt",
        location: command.source,
      })),
    };
    const initialCommandData: BoundaryValue = commands ?? fallbackCommandData;
    this.commandCatalogs.replace(sessionId, proc, initialCommandData, enableSkillCommands);

    const response = {
      sessionId,
      configOptions,
      models,
      modes,
      _meta: {
        piAcp: {
          startupInfo: preludeText || null,
        },
      },
    };

    // Try to send it immediately after session/new returns; if the client ignores it,
    // it will still be emitted as the first chunk of the first prompt.
    if (preludeText)
      setTimeout(() => {
        if (this.active && this.generation === generation) session.sendStartupInfoIfPending();
      }, 0);

    // Advertise slash commands (ACP: available_commands_update)
    // Important: some clients (e.g. Zed) will ignore notifications for an unknown sessionId.
    // So we must send this *after* the session/new response has been delivered.
    setTimeout(() => {
      if (!this.active || this.generation !== generation) return;
      const owned = this.commandCatalogs.get(sessionId);
      if (owned?.proc !== proc) return;
      const { availableCommands } = owned.catalog.snapshot();
      void conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [...availableCommands],
        },
      });
    }, 0);

    return response;
  }

  async authenticate(_params: AuthenticateRequest) {
    // Terminal Auth is handled out-of-band by re-launching the binary with `--terminal-login`.
    // If the client calls `authenticate` anyway, we can no-op successfully.
    return;
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const generation = this.generation;
    this.assertCurrent(generation);
    const existing = this.sessions.maybeGet(params.sessionId);
    existing?.activate?.();
    const session = await this.restoreSession(params.sessionId);
    this.assertCurrent(generation);

    session.activate?.();
    const sessionId = session.sessionId;
    const sessions = this.sessions;
    try {
      return await this.promptActive(params, session, generation);
    } finally {
      if (
        this.active &&
        this.generation === generation &&
        sessions.maybeGet(sessionId) === session
      ) {
        session.markIdle?.();
      }
    }
  }

  private async promptActive(
    params: PromptRequest,
    session: PiAcpSession,
    generation: number,
  ): Promise<PromptResponse> {
    // The client has rendered this prompt as a new user entry; commands answered here
    // and Pi's output both start a new block, so the first output needs no separator.
    // (Tests sometimes stub out the session, so guard the call.)
    session.beginClientPrompt?.();
    const { message, images } = promptToPiMessage(
      params.prompt,
      process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT === "true",
    );
    const startsWithSlash = message.startsWith("/");
    const invocation = parseSlashInvocation(message);

    if (startsWithSlash && (!invocation || images.length > 0)) {
      throw RequestError.invalidParams(
        {},
        "Slash commands must be a single text line without image attachments.",
      );
    }

    const ownedCatalog = this.commandCatalogs.get(session.sessionId);
    if (invocation && ownedCatalog?.proc !== session.proc) {
      await this.publishCommandCatalog(session);
      this.assertCurrent(generation);
    }

    const command = invocation
      ? this.commandCatalogs.entry(session.sessionId, session.proc, invocation.name)
      : undefined;
    if (invocation && !command) {
      throw RequestError.invalidParams(
        {},
        `Unknown or unavailable slash command: /${invocation.name}`,
      );
    }

    if (invocation && command?.source === "extension") {
      const sessionId = session.sessionId;
      const proc = session.proc;
      await proc.prompt(invocation.text, []);
      this.assertCurrent(generation);

      // Extension commands complete directly through Pi RPC. They may also mutate the
      // extension registry (for example, /reload), so refresh the ACP command catalog
      // without allowing refresh failures or stale process ownership to change the
      // successful command result.
      if (this.sessions.maybeGet(sessionId)?.proc === proc) {
        try {
          await this.publishCommandCatalog(session);
        } catch {
          // Command discovery is best-effort after a successful extension command.
        }
        this.assertCurrent(generation);
      }

      return { stopReason: "end_turn" };
    }

    // Adapter-owned builtins remain local, unless Pi discovered the same canonical name.
    if (invocation && command?.source === "builtin") {
      const handled = await runBuiltinCommand(session, invocation, {
        piCommand: this.piCommand,
        assertCurrent: () => this.assertCurrent(generation),
      });
      if (handled) return handled;
    }

    const result = await session.prompt(message, images);

    // ACP StopReason does not include "error"; if pi fails we map to end_turn for now,
    // unless we know this was a cancellation.
    const stopReason: StopReason =
      result === "error" ? (session.wasCancelRequested() ? "cancelled" : "end_turn") : result;

    return { stopReason };
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.maybeGet(params.sessionId);
    if (!session) return;
    await session.cancel();
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    // Scope in client-to-adapter order: explicit cwd, the last active session cwd, then the
    // adapter process cwd (clients normally spawn it inside the project). Only list unscoped
    // when none can be determined at all.
    let effectiveCwd: string | undefined =
      listSessionsCwd(params) ?? this.lastSessionCwd ?? undefined;
    if (!effectiveCwd) {
      try {
        effectiveCwd = process.cwd();
      } catch {
        effectiveCwd = undefined;
      }
    }
    const filtered = listPiSessions(effectiveCwd);

    // Cursor-based pagination (opaque cursor). For MVP, we use a simple numeric offset.
    // If cursor is invalid, treat as 0.
    const offset = params.cursor ? Number.parseInt(params.cursor, 10) : 0;
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0;

    const PAGE_SIZE = 50;
    const page = filtered.slice(start, start + PAGE_SIZE);

    const sessions: SessionInfo[] = page.map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      updatedAt: s.updatedAt,
    }));

    const nextCursor = start + PAGE_SIZE < filtered.length ? String(start + PAGE_SIZE) : null;

    return { sessions, nextCursor, _meta: {} };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
    }

    // If the client is re-loading a session that is already active, tear down the existing
    // pi subprocess so we can start fresh and re-advertise commands reliably.
    // (Some clients may call session/load when restoring from history.)
    this.sessions.close(params.sessionId);

    this.lastSessionCwd = params.cwd;

    const stored = this.findStoredSession(params.sessionId);
    if (!stored) {
      throw RequestError.invalidParams(`Unknown sessionId: ${params.sessionId}`);
    }

    const enableSkillCommands = getEnableSkillCommands(params.cwd);
    const session = await this.restoreSession(params.sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers,
    });
    const proc = session.proc;
    const fileCommands = loadSlashCommands(params.cwd);

    // A restored thread becomes most-recently used; evict only beyond the bounded live-thread cap.
    // (Tests sometimes stub out `this.sessions`, so guard the call.)
    this.sessions.retainRecent?.(session.sessionId, PI_ACP_MAX_LIVE_SESSIONS);

    // (Optional) ensure mapping stays fresh.
    this.store.upsert({
      sessionId: params.sessionId,
      cwd: params.cwd,
      sessionFile: stored.sessionFile,
    });

    // Replay full conversation history.
    const getMessages = proc.getMessages;
    if (!getMessages) throw missingPiCapability("get_messages");
    const data: PiMessages = await getMessages.call(proc);
    await replayPiMessages(session, data.messages, params.cwd);

    const { configOptions, models, modes } = await getSessionConfiguration(proc);
    let loadCommandData: BoundaryValue;
    try {
      const getCommands = proc.getCommands;
      if (!getCommands) throw missingPiCapability("get_commands");
      loadCommandData = await getCommands.call(proc);
    } catch {
      loadCommandData = {
        commands: fileCommands.map((command) => ({
          name: command.name,
          description: command.description,
          source: "prompt",
          location: command.source,
        })),
      };
    }
    const loadCatalog = this.commandCatalogs.replace(
      session.sessionId,
      proc,
      loadCommandData,
      enableSkillCommands,
    );

    const response = {
      configOptions,
      models,
      modes,
      _meta: {
        piAcp: {
          startupInfo: null,
        },
      },
    };

    // Advertise slash commands after the response so the client knows the session exists.
    setTimeout(() => {
      const { availableCommands } = loadCatalog.snapshot();
      void this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [...availableCommands],
        },
      });
    }, 0);

    return response;
  }

  async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    const stored = this.store.get(params.sessionId);
    const piSession = findPiSession(params.sessionId);

    // Per ACP session/delete semantics, deleting a session that does not
    // exist (or is already gone) should succeed idempotently.
    // https://agentclientprotocol.com/protocol/v2/session-delete#semantics
    if (!stored && !piSession) {
      return {};
    }

    const sessionFile = stored?.sessionFile ?? piSession?.sessionFile;

    if (sessionFile) {
      try {
        if (existsSync(sessionFile)) unlinkSync(sessionFile);
      } catch {
        // best-effort cleanup
      }
    }

    this.store.delete(params.sessionId);

    return {};
  }

  async unstable_setSessionModel(params: SetSessionModelRequest): Promise<void> {
    const session = await this.restoreSession(params.sessionId);
    await setSessionModel(session.proc, params.modelId);
    await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc);
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = await this.restoreSession(params.sessionId);

    const mode = String(params.modeId);
    if (!isThinkingLevel(mode)) {
      throw RequestError.invalidParams(`Unknown modeId: ${mode}`);
    }

    const setThinkingLevel = session.proc.setThinkingLevel;
    if (!setThinkingLevel) throw missingPiCapability("set_thinking_level");
    await setThinkingLevel.call(session.proc, mode);

    // Let the client know the current mode changed (keeps the dropdown in sync).
    void this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: mode,
      },
    });

    await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc);

    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = await this.restoreSession(params.sessionId);
    const configId = String(params.configId);

    if (!isString(params.value)) {
      throw RequestError.invalidParams(`Expected string value for config option: ${configId}`);
    }

    if (configId === MODEL_CONFIG_ID) {
      await setSessionModel(session.proc, params.value);
    } else if (configId === THOUGHT_LEVEL_CONFIG_ID) {
      if (!isThinkingLevel(params.value)) {
        throw RequestError.invalidParams(`Unknown thinking level: ${params.value}`);
      }

      const setThinkingLevel = session.proc.setThinkingLevel;
      if (!setThinkingLevel) throw missingPiCapability("set_thinking_level");
      await setThinkingLevel.call(session.proc, params.value);

      void this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: params.value,
        },
      });
    } else {
      throw RequestError.invalidParams(`Unknown config option: ${configId}`);
    }

    const configOptions = await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc);
    return { configOptions };
  }
}

function buildStartupInfo(opts: {
  cwd: string;
  fileCommands: ReturnType<typeof loadSlashCommands>;
  updateNotice: string | null;
  piVersion: string | null;
}): string {
  void opts.fileCommands;

  const md: string[] = [];

  // pi version header
  if (opts.piVersion) {
    md.push(`pi v${opts.piVersion}`);
    md.push("---");
    md.push("");
  }

  const addSection = (title: string, items: string[]) => {
    const cleaned = items.map((s) => s.trim()).filter(Boolean);
    if (!cleaned.length) return;

    md.push(`## ${title}`);
    for (const item of cleaned) md.push(`- ${item}`);
    md.push("");
  };

  // Context
  const contextItems: string[] = [];
  const contextPath = join(opts.cwd, "AGENTS.md");
  if (existsSync(contextPath)) contextItems.push(contextPath);
  addSection("Context", contextItems);

  // Skills
  const skillsItems: string[] = [];

  const pushSkillFromRoot = (root: string) => {
    try {
      // Direct .md files in root
      for (const e of readdirSync(root)) {
        const p = join(root, e);
        try {
          const st = statSync(p);
          if (st.isFile() && e.toLowerCase().endsWith(".md")) {
            skillsItems.push(p);
          }
        } catch {
          // ignore
        }
      }

      // Recursive SKILL.md under subdirectories
      const stack: string[] = [root];
      while (stack.length) {
        const dir = stack.pop()!;
        let entries: string[] = [];
        try {
          entries = readdirSync(dir);
        } catch {
          continue;
        }

        for (const name of entries) {
          // Skip obvious noise
          if (name === "node_modules" || name === ".git") continue;
          const p = join(dir, name);
          let st;
          try {
            st = statSync(p);
          } catch {
            continue;
          }
          if (st.isDirectory()) {
            stack.push(p);
          } else if (st.isFile() && name === "SKILL.md") {
            skillsItems.push(p);
          }
        }
      }
    } catch {
      // ignore
    }
  };

  // Global skills
  // Use getAgentDir() so this respects PI_CODING_AGENT_DIR overrides.
  const globalSkillsDir = join(getAgentDir(), "skills");
  pushSkillFromRoot(globalSkillsDir);

  // Also support ~/.agents/skills (pi skill discovery)
  const legacyAgentsSkillsDir = join(process.env.HOME ?? "", ".agents", "skills");
  pushSkillFromRoot(legacyAgentsSkillsDir);

  // Project skills (.pi/skills)
  const projectSkillsDir = join(opts.cwd, ".pi", "skills");
  pushSkillFromRoot(projectSkillsDir);

  addSection("Skills", skillsItems);

  // Prompts
  const promptsItems: string[] = [];
  const agentDirs = startupInfoAgentDirs();
  const promptsDir = agentDirs.prompts;
  try {
    const prompts = readdirSync(promptsDir).filter((f) => f.endsWith(".md"));
    for (const f of prompts) promptsItems.push(`/${basename(f, ".md")}`);
  } catch {
    // ignore
  }
  addSection("Prompts", promptsItems);

  // Extensions
  const extItems: string[] = [];
  const extDir = agentDirs.extensions;
  try {
    const exts = readdirSync(extDir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
    for (const f of exts) extItems.push(join(extDir, f));
  } catch {
    // ignore
  }

  // Also show npm packages from pi settings (global + project)
  const settingsPaths = [
    join(getAgentDir(), "settings.json"),
    join(opts.cwd, ".pi", "settings.json"),
  ];
  for (const settingsPath of settingsPaths) {
    try {
      const settings: BoundaryValue = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const pkgs = arrayField(settings, "packages") ?? [];
      for (const pkg of pkgs) {
        const s = String(pkg);
        if (s.startsWith("npm:")) {
          extItems.push(`${s}\n  - index.ts`);
        } else {
          extItems.push(s);
        }
      }
    } catch {
      // ignore
    }
  }

  addSection("Extensions", extItems);

  if (opts.updateNotice) {
    md.push("---");
    md.push(opts.updateNotice);
    md.push("");
  }

  // Do NOT include themes (per request).
  return md.join("\n").trim() + "\n";
}

function readNearestPackageJson(metaUrl: string): PackageIdentity {
  try {
    let dir = dirname(fileURLToPath(metaUrl));

    // Walk upwards a few levels to find the nearest package.json
    for (let i = 0; i < 6; i++) {
      const p = join(dir, "package.json");
      if (existsSync(p)) {
        const json: BoundaryValue = JSON.parse(readFileSync(p, "utf-8"));
        return { name: stringField(json, "name"), version: stringField(json, "version") };
      }
      dir = dirname(dir);
    }
  } catch {
    // ignore
  }
  return { name: "pi-acp", version: "0.0.0" };
}
