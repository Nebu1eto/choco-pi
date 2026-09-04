import {
  RequestError,
  type Agent as ACPAgent,
  type AuthenticateRequest,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SessionInfo,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type StopReason,
  type DeleteSessionRequest,
  type DeleteSessionResponse,
} from "@agentclientprotocol/sdk";
import { getAuthMethods } from "./auth.ts";
import {
  PI_ACP_MAX_LIVE_SESSIONS,
  SessionManager,
  type AcpConnection,
  type PiAcpSession,
} from "./session.ts";
import { SessionStore } from "./session-store.ts";
import { PiRpcProcess, type PiRpcProcessLike, PiRpcSpawnError } from "../pi-rpc/process.ts";
import { type BoundaryValue, errorMessage, isString } from "../boundary.ts";
import {
  arrayField,
  booleanField,
  recordField,
  stringField,
  type PiAvailableModels,
  type PiCommands,
  type PiMessages,
  type PiState,
} from "../pi-rpc/protocol.ts";
import { listPiSessions, findPiSession } from "./pi-sessions.ts";
import { normalizePiAssistantText, normalizePiMessageText } from "./translate/pi-messages.ts";
import { toolResultToText } from "./translate/pi-tools.ts";
import {
  bashCommand,
  bashExitCode,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool,
} from "./translate/bash.ts";
import { promptToPiMessage } from "./translate/prompt.ts";
import { loadSlashCommands, parseCommandArgs } from "./slash-commands.ts";
import { getAgentDir, getEnableSkillCommands, getQuietStartup } from "./pi-settings.ts";
import {
  buildCommandCatalog,
  parseSlashInvocation,
  SessionCommandCatalog,
  type CommandCatalogEntry,
} from "./pi-commands.ts";
import { maybeAuthRequiredError } from "./auth-required.ts";
import { isAbsolute } from "node:path";
import { existsSync, readFileSync, realpathSync, readdirSync, statSync, unlinkSync } from "node:fs";
import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { join, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type AdvertisedModel = {
  modelId: string;
  name: string;
  description?: string | null;
};

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

/** One selectable reasoning-effort entry advertised to the client. */
type SessionModeDescriptor = {
  id: string;
  name: string;
  description?: string | null;
};

/** Reasoning-effort options plus the level Pi currently applies. */
type ThinkingState = {
  availableModes: SessionModeDescriptor[];
  currentModeId: string;
};

/** Advertised models plus the model Pi currently applies. */
type ModelState = {
  availableModels: AdvertisedModel[];
  currentModelId: string;
};

/** The model and reasoning selections a config-option list is rendered from. */
type SessionConfigState = {
  models: ModelState | null;
  modes: ThinkingState;
};

/** A full session configuration snapshot returned to the client. */
type SessionConfiguration = SessionConfigState & {
  configOptions: SessionConfigOption[];
};

/** Pi RPC answers already fetched by the caller, so configuration does not re-probe. */
type PiPreloadedState = {
  state?: PiState | null;
  availableModels?: PiAvailableModels | null;
};

/** A command catalog together with the Pi process that produced it. */
type CommandCatalogOwner = {
  proc: PiRpcProcessLike;
  catalog: SessionCommandCatalog;
};

/** One RPC probe settled without rejecting the surrounding parallel startup batch. */
type RpcAttempt<Value> = {
  value: Value | null;
  error: BoundaryValue;
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

/** Report a Pi RPC capability the current session process does not expose. */
function missingPiCapability(name: string): Error {
  return new Error(`pi ${name} is unavailable for this session`);
}

/** Read the message of a rejected promise or thrown value the way `String(e?.message ?? e)` did. */
function failureText(failure: BoundaryValue): string {
  return errorMessage(failure);
}

/** Settle an RPC probe while retaining its typed success payload. */
async function attemptRpc<Value>(request: Promise<Value>): Promise<RpcAttempt<Value>> {
  try {
    return { value: await request, error: null };
  } catch (error) {
    // SAFETY: promise rejections may contain any JavaScript value; BoundaryValue is the
    // repository's recursive undecoded boundary contract and is inspected only by decoders.
    const failure = error as BoundaryValue;
    return { value: null, error: failure };
  }
}

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

const MODEL_CONFIG_ID = "model";
const THOUGHT_LEVEL_CONFIG_ID = "thought_level";

function builtinAvailableCommands(): AvailableCommand[] {
  return [
    {
      name: "compact",
      description: "Manually compact the session context",
      input: { hint: "optional custom instructions" },
    },
    {
      name: "autocompact",
      description: "Toggle automatic context compaction",
      input: { hint: "on|off|toggle" },
    },
    {
      name: "export",
      description: "Export session to an HTML file in the session cwd",
    },
    {
      name: "session",
      description: "Show session stats (messages, tokens, cost, session file)",
    },
    {
      name: "name",
      description: "Set session display name",
      input: { hint: "<name>" },
    },
    {
      name: "steering",
      description:
        "Get/set pi steering message delivery mode (how queued steering messages are delivered)",
      input: { hint: "(no args to show) all | one-at-a-time" },
    },
    {
      name: "follow-up",
      description:
        "Get/set pi follow-up message delivery mode (how queued follow-up messages are delivered)",
      input: { hint: "(no args to show) all | one-at-a-time" },
    },
    {
      name: "changelog",
      description: "Show pi changelog",
    },
  ];
}

import { fileURLToPath } from "node:url";

const pkg = readNearestPackageJson(import.meta.url);

export class PiAcpAgent implements ACPAgent {
  private readonly conn: AcpConnection;
  private readonly sessions: SessionManagerLike;
  private readonly store: SessionStoreLike = new SessionStore();
  private readonly restoringSessions = new Map<string, Promise<PiAcpSession>>();
  private readonly commandCatalogs = new Map<string, CommandCatalogOwner>();
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

  private replaceCommandCatalog(
    sessionId: string,
    proc: PiRpcProcessLike,
    data: BoundaryValue,
    enableSkillCommands: boolean,
  ): SessionCommandCatalog {
    const owned = this.commandCatalogs.get(sessionId);
    const catalog = owned?.proc === proc ? owned.catalog : new SessionCommandCatalog();
    catalog.replace(
      buildCommandCatalog(data, builtinAvailableCommands(), {
        enableSkillCommands,
      }),
    );
    this.commandCatalogs.set(sessionId, { proc, catalog });
    return catalog;
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

    const catalog = this.replaceCommandCatalog(sessionId, proc, commandData, enableSkillCommands);
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

  private commandEntry(
    sessionId: string,
    proc: PiRpcProcessLike,
    name: string,
  ): CommandCatalogEntry | undefined {
    const owned = this.commandCatalogs.get(sessionId);
    return owned?.proc === proc ? owned.catalog.resolve(name) : undefined;
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
    const updateNotice = buildUpdateNotice();

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
    this.replaceCommandCatalog(sessionId, proc, initialCommandData, enableSkillCommands);

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
      ? this.commandEntry(session.sessionId, session.proc, invocation.name)
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
      const trimmed = invocation.text;
      const space = trimmed.indexOf(" ");
      const cmd = invocation.name;
      const argsString = space === -1 ? "" : trimmed.slice(space + 1);
      const args = parseCommandArgs(argsString);

      if (cmd === "compact") {
        const customInstructions = args.join(" ").trim() || undefined;
        const compact = session.proc.compact;
        if (!compact) throw missingPiCapability("compact");
        const result = await compact.call(session.proc, customInstructions);

        const tokensBefore = result.tokensBefore ?? null;
        const summary = result.summary ?? null;

        const headerLines = [
          `Compaction completed.${customInstructions ? " (custom instructions applied)" : ""}`,
          tokensBefore !== null ? `Tokens before: ${tokensBefore}` : null,
        ].filter(Boolean);

        const text = headerLines.join("\n") + (summary ? `\n\n${summary}` : "");

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (cmd === "session") {
        const getSessionStats = session.proc.getSessionStats;
        if (!getSessionStats) throw missingPiCapability("get_session_stats");
        const stats = await getSessionStats.call(session.proc);

        const lines: string[] = [];
        if (stats.sessionId) lines.push(`Session: ${stats.sessionId}`);
        if (stats.sessionFile) lines.push(`Session file: ${stats.sessionFile}`);
        if (stats.totalMessages !== undefined) lines.push(`Messages: ${stats.totalMessages}`);

        if (stats.cost !== undefined) lines.push(`Cost: ${stats.cost}`);

        const t = stats.tokens;
        if (t) {
          const parts: string[] = [];
          if (t.input !== undefined) parts.push(`in ${t.input}`);
          if (t.output !== undefined) parts.push(`out ${t.output}`);
          if (t.cacheRead !== undefined) parts.push(`cache read ${t.cacheRead}`);
          if (t.cacheWrite !== undefined) parts.push(`cache write ${t.cacheWrite}`);
          if (t.total !== undefined) parts.push(`total ${t.total}`);
          if (parts.length) lines.push(`Tokens: ${parts.join(", ")}`);
        }

        // Fallback if stats shape changes.
        const text = lines.length
          ? lines.join("\n")
          : `Session stats:\n${JSON.stringify(stats, null, 2)}`;

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (cmd === "name") {
        const name = args.join(" ").trim();
        if (!name) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Usage: /name <name>" },
            },
          });
          return { stopReason: "end_turn" };
        }

        try {
          const setSessionName = session.proc.setSessionName;
          if (!setSessionName) throw missingPiCapability("set_session_name");
          await setSessionName.call(session.proc, name);
        } catch (error) {
          // SAFETY: catch bindings may contain any thrown JavaScript value; `errorMessage`
          // handles Error instances and stringifies every other boundary value.
          const msg = errorMessage(error as BoundaryValue);
          const hint = /set_session_name/i.test(msg)
            ? " This requires a newer pi version that supports `set_session_name` in RPC mode."
            : "";

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `Failed to set session name: ${msg}${hint}` },
            },
          });
          return { stopReason: "end_turn" };
        }

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "session_info_update",
            title: name,
            updatedAt: new Date().toISOString(),
          },
        });

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Session name set: ${name}` },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (cmd === "steering") {
        const modeRaw = String(args[0] ?? "").toLowerCase();
        const getState = session.proc.getState;
        if (!getState) throw missingPiCapability("get_state");
        const state = await getState.call(session.proc);
        const current = String(state.steeringMode ?? "");

        // If no arg, just report current.
        if (!modeRaw) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `Steering mode: ${current || "unknown"}`,
              },
            },
          });
          return { stopReason: "end_turn" };
        }

        if (modeRaw !== "all" && modeRaw !== "one-at-a-time") {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Usage: /steering all | /steering one-at-a-time",
              },
            },
          });
          return { stopReason: "end_turn" };
        }

        const setSteeringMode = session.proc.setSteeringMode;
        if (!setSteeringMode) throw missingPiCapability("set_steering_mode");
        await setSteeringMode.call(session.proc, modeRaw);

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Steering mode set to: ${modeRaw}` },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (cmd === "follow-up") {
        const modeRaw = String(args[0] ?? "").toLowerCase();
        const getState = session.proc.getState;
        if (!getState) throw missingPiCapability("get_state");
        const state = await getState.call(session.proc);
        const current = String(state.followUpMode ?? "");

        // If no arg, just report current.
        if (!modeRaw) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `Follow-up mode: ${current || "unknown"}`,
              },
            },
          });
          return { stopReason: "end_turn" };
        }

        if (modeRaw !== "all" && modeRaw !== "one-at-a-time") {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Usage: /follow-up all | /follow-up one-at-a-time",
              },
            },
          });
          return { stopReason: "end_turn" };
        }

        const setFollowUpMode = session.proc.setFollowUpMode;
        if (!setFollowUpMode) throw missingPiCapability("set_follow_up_mode");
        await setFollowUpMode.call(session.proc, modeRaw);

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Follow-up mode set to: ${modeRaw}` },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (cmd === "changelog") {
        // Read pi's installed CHANGELOG.md. Adapter-side, no model call.
        const findChangelog = (): string | null => {
          // 1) Locate the installed pi package by resolving the `pi` executable.
          // On Node installs, `pi` typically resolves to .../@earendil-works/pi-coding-agent/dist/cli.js
          try {
            const whichCmd = process.platform === "win32" ? "where" : "which";
            const which = spawnSync(whichCmd, ["pi"], { encoding: "utf-8" });
            const piPath = String(which.stdout ?? "")
              .split(/\r?\n/)[0]
              ?.trim();

            if (piPath) {
              const resolved = realpathSync(piPath);
              const pkgRoot = dirname(dirname(resolved));
              const p = join(pkgRoot, "CHANGELOG.md");
              if (existsSync(p)) return p;
            }
          } catch {
            // ignore
          }

          // 2) Fallback: ask npm where global modules live.
          try {
            const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf-8" });
            const root = String(npmRoot.stdout ?? "").trim();
            if (root) {
              const p = join(root, "@earendil-works", "pi-coding-agent", "CHANGELOG.md");
              if (existsSync(p)) return p;
            }
          } catch {
            // ignore
          }

          return null;
        };

        const changelogPath = findChangelog();
        if (!changelogPath) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Changelog not found (couldn't locate pi installation).",
              },
            },
          });
          return { stopReason: "end_turn" };
        }

        let text = "";
        try {
          text = readFileSync(changelogPath, "utf-8");
        } catch (error) {
          // SAFETY: catch bindings may contain any thrown JavaScript value; `errorMessage`
          // handles Error instances and stringifies every other boundary value.
          const message = errorMessage(error as BoundaryValue);
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `Failed to read changelog: ${message}`,
              },
            },
          });
          return { stopReason: "end_turn" };
        }

        // Keep it reasonably sized in chat.
        const maxChars = 20_000;
        if (text.length > maxChars) text = text.slice(0, maxChars) + "\n\n...(truncated)...";

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (cmd === "export") {
        // For now we always export into the session cwd and do not accept a user-provided path.
        // IMPORTANT: pi's export_html reads the session JSONL file. If it doesn't exist yet
        // (no messages) or is empty, pi throws and RPC mode emits an uncorrelated parse error
        // (no id), which would otherwise hang our request. So we guard here.
        const getState = session.proc.getState;
        if (!getState) throw missingPiCapability("get_state");
        const state = await getState.call(session.proc);
        const sessionFile = state.sessionFile ?? null;
        const messageCount = state.messageCount ?? 0;

        if (!sessionFile || messageCount === 0 || !existsSync(sessionFile)) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Nothing to export yet (no session messages). Send a prompt first.",
              },
            },
          });
          return { stopReason: "end_turn" };
        }

        try {
          const raw = readFileSync(sessionFile, "utf-8");
          if (raw.trim().length === 0) {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: "Nothing to export yet (empty session file). Send a prompt first.",
                },
              },
            });
            return { stopReason: "end_turn" };
          }
        } catch {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Couldn't read session file for export. Try sending a prompt first.",
              },
            },
          });
          return { stopReason: "end_turn" };
        }

        const safeSessionId = session.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
        const outputPath = join(session.cwd, `pi-session-${safeSessionId}.html`);

        let resultPath = "";
        try {
          const exportHtml = session.proc.exportHtml;
          if (!exportHtml) throw missingPiCapability("export_html");
          const result = await exportHtml.call(session.proc, outputPath);
          resultPath = result.path;
        } catch (error) {
          // SAFETY: catch bindings may contain any thrown JavaScript value; `errorMessage`
          // handles Error instances and stringifies every other boundary value.
          const message = errorMessage(error as BoundaryValue);
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `Export failed: ${message}`,
              },
            },
          });
          return { stopReason: "end_turn" };
        }

        if (!resultPath) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Export failed: no output path returned by pi.",
              },
            },
          });
          return { stopReason: "end_turn" };
        }

        const uri = `file://${resultPath}`;

        // Emit a short prefix + a resource link. Many clients concatenate chunks into a single
        // assistant message, so this avoids the "link + duplicate plain text" look.
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "Session exported: ",
            },
          },
        });

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "resource_link",
              name: `pi-session-${safeSessionId}.html`,
              uri,
              mimeType: "text/html",
              title: "Session exported",
            },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (cmd === "autocompact") {
        const mode = (args[0] ?? "toggle").toLowerCase();
        let enabled: boolean | null = null;
        if (mode === "on" || mode === "true" || mode === "enable" || mode === "enabled")
          enabled = true;
        else if (mode === "off" || mode === "false" || mode === "disable" || mode === "disabled")
          enabled = false;

        if (enabled === null) {
          // toggle: read current state and invert.
          const getState = session.proc.getState;
          if (!getState) throw missingPiCapability("get_state");
          const state = await getState.call(session.proc);
          const current = Boolean(state.autoCompactionEnabled);
          enabled = !current;
        }

        const setAutoCompaction = session.proc.setAutoCompaction;
        if (!setAutoCompaction) throw missingPiCapability("set_auto_compaction");
        await setAutoCompaction.call(session.proc, enabled);

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `Auto-compaction ${enabled ? "enabled" : "disabled"}.`,
            },
          },
        });

        return { stopReason: "end_turn" };
      }
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
    const messages = data.messages;

    for (const m of messages) {
      if (m.role === "user") {
        const text = normalizePiMessageText(m.content);
        if (text) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text },
            },
          });
        }
      }

      if (m.role === "assistant") {
        const text = normalizePiAssistantText(m.content);
        if (text) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            },
          });
        }
      }

      if (m.role === "toolResult") {
        const toolName = String(m.toolName ?? "tool");
        const toolCallId = String(m.toolCallId ?? crypto.randomUUID());
        const isError = Boolean(m.isError);
        const isBash = isBashTool(toolName);

        if (isBash) {
          const text = bashResultText(m);
          const terminalExitMetadata = bashTerminalExitMeta(toolCallId, bashExitCode(m, isError));
          const updateMetadata = text
            ? Object.assign(bashTerminalOutputMeta(toolCallId, text), terminalExitMetadata)
            : terminalExitMetadata;
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId,
              title: bashCommand(m) ?? toolName,
              kind: "execute",
              status: "in_progress",
              content: bashTerminalContent(toolCallId),
              _meta: bashTerminalInfoMeta(toolCallId, params.cwd),
            },
          });

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: isError ? "failed" : "completed",
              _meta: updateMetadata,
            },
          });
          continue;
        }

        // Create a synthetic ACP tool call to render historic tool usage.
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: toolName,
            kind:
              toolName === "read"
                ? "read"
                : toolName === "write" || toolName === "edit"
                  ? "edit"
                  : "other",
            status: "in_progress",
            rawInput: null,
            rawOutput: m,
          },
        });

        const text = toolResultToText(m);
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: isError ? "failed" : "completed",
            content: text ? [{ type: "content", content: { type: "text", text } }] : null,
            rawOutput: m,
          },
        });
      }
    }

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
    const loadCatalog = this.replaceCommandCatalog(
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

function isThinkingLevel(x: string): x is ThinkingLevel {
  return (
    x === "off" || x === "minimal" || x === "low" || x === "medium" || x === "high" || x === "xhigh"
  );
}

async function getThinkingState(
  proc: PiRpcProcessLike,
  pre?: Pick<PiPreloadedState, "state">,
): Promise<ThinkingState> {
  // Ask pi for current thinking level.
  let current: ThinkingLevel = "medium";

  const state =
    pre?.state ??
    (await (async () => {
      try {
        const getState = proc.getState;
        if (!getState) throw missingPiCapability("get_state");
        return await getState.call(proc);
      } catch {
        return null;
      }
    })());

  const tl = state?.thinkingLevel ?? null;
  if (tl && isThinkingLevel(tl)) current = tl;

  const available: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

  return {
    currentModeId: current,
    availableModes: available.map((id) => ({
      id,
      name: `Thinking: ${id}`,
      description: null,
    })),
  };
}

async function getSessionConfiguration(
  proc: PiRpcProcessLike,
  pre?: PiPreloadedState,
): Promise<SessionConfiguration> {
  const [models, modes] = await Promise.all([
    getModelState(proc, pre),
    getThinkingState(proc, { state: pre?.state }),
  ]);

  return {
    configOptions: buildConfigOptions({ models, modes }),
    models,
    modes,
  };
}

function buildConfigOptions(state: SessionConfigState): SessionConfigOption[] {
  const configOptions: SessionConfigOption[] = [
    {
      type: "select",
      id: THOUGHT_LEVEL_CONFIG_ID,
      category: "thought_level",
      name: "Thinking",
      description: "Set the reasoning effort for this session",
      currentValue: state.modes.currentModeId,
      options: state.modes.availableModes.map((mode) => ({
        value: mode.id,
        name: mode.name,
        description: mode.description ?? null,
      })),
    },
  ];

  if (state.models?.availableModels.length) {
    configOptions.unshift({
      type: "select",
      id: MODEL_CONFIG_ID,
      category: "model",
      name: "Model",
      description: "Select the model for this session",
      currentValue: state.models.currentModelId,
      options: state.models.availableModels.map((model) => ({
        value: model.modelId,
        name: model.name,
        description: model.description ?? null,
      })),
    });
  }

  return configOptions;
}

async function getModelState(
  proc: PiRpcProcessLike,
  pre?: PiPreloadedState,
): Promise<ModelState | null> {
  // Ask pi for available models.
  let availableModels: AdvertisedModel[] = [];

  const data =
    pre?.availableModels ??
    (await (async () => {
      try {
        const getAvailableModels = proc.getAvailableModels;
        if (!getAvailableModels) throw missingPiCapability("get_available_models");
        return await getAvailableModels.call(proc);
      } catch {
        return null;
      }
    })());

  const models = data?.models ?? [];
  for (const model of models) {
    const provider = model.provider.trim();
    const id = model.id.trim();
    if (!provider || !id) continue;

    const name = String(model.name ?? id);
    availableModels.push({
      modelId: `${provider}/${id}`,
      name: `${provider}/${name}`,
      description: null,
    });
  }

  // Ask pi what model is currently active.
  let currentModelId: string | null = null;

  const state =
    pre?.state ??
    (await (async () => {
      try {
        const getState = proc.getState;
        if (!getState) throw missingPiCapability("get_state");
        return await getState.call(proc);
      } catch {
        return null;
      }
    })());

  const model = state?.model;
  if (model) {
    const provider = String(model.provider ?? "").trim();
    const id = String(model.id ?? "").trim();
    if (provider && id) currentModelId = `${provider}/${id}`;
  }

  if (!availableModels.length && !currentModelId) return null;

  // Fallback if current model is unknown: use first in list.
  if (!currentModelId) currentModelId = availableModels[0]?.modelId ?? "default";

  return {
    availableModels,
    currentModelId: currentModelId ?? availableModels[0]?.modelId ?? "default",
  };
}

async function emitConfigOptionsUpdate(
  conn: AcpConnection,
  sessionId: string,
  proc: PiRpcProcessLike,
): Promise<SessionConfigOption[]> {
  const { configOptions } = await getSessionConfiguration(proc);

  await conn.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: "config_option_update",
      configOptions,
    },
  });

  return configOptions;
}

async function setSessionModel(proc: PiRpcProcessLike, requestedModelId: string): Promise<void> {
  // Accept either:
  //  - "provider/model" (preferred, matches how we advertise)
  //  - "model" (fallback, resolve via available models)
  let provider: string | null = null;
  let modelId: string | null = null;

  if (requestedModelId.includes("/")) {
    const [candidateProvider, ...rest] = requestedModelId.split("/");
    provider = candidateProvider;
    modelId = rest.join("/");
  } else {
    modelId = requestedModelId;
  }

  if (!provider) {
    const getAvailableModels = proc.getAvailableModels;
    if (!getAvailableModels) throw missingPiCapability("get_available_models");
    const data = await getAvailableModels.call(proc);
    const found = data.models.find((model) => String(model.id) === modelId);
    if (found) {
      provider = String(found.provider);
      modelId = String(found.id);
    }
  }

  if (!provider || !modelId) {
    throw RequestError.invalidParams(`Unknown modelId: ${requestedModelId}`);
  }

  const setModel = proc.setModel;
  if (!setModel) throw missingPiCapability("set_model");
  await setModel.call(proc, provider, modelId);
}

function isSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(v);
}

function compareSemver(a: string, b: string): number {
  // Very small comparator for x.y.z (ignores pre-release/build beyond making them "not greater" unless base differs)
  const pa = a
    .split(/[.-]/)
    .slice(0, 3)
    .map((n) => Number(n));
  const pb = b
    .split(/[.-]/)
    .slice(0, 3)
    .map((n) => Number(n));
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function buildUpdateNotice(): string | null {
  // Best-effort update check against npm registry.
  // Important: keep it fast to not slow down session/new.
  try {
    const piVersion = spawnSync("pi", ["--version"], { encoding: "utf-8" });
    const installed = (
      String(piVersion.stdout ?? "").trim() || String(piVersion.stderr ?? "").trim()
    ).replace(/^v/i, "");

    if (!installed || !isSemver(installed)) return null;

    const latestRes = spawnSync("npm", ["view", "@earendil-works/pi-coding-agent", "version"], {
      encoding: "utf-8",
      timeout: 800,
    });
    const latest = String(latestRes.stdout ?? "")
      .trim()
      .replace(/^v/i, "");

    if (!latest || !isSemver(latest)) return null;
    if (compareSemver(latest, installed) <= 0) return null;

    return `New version available: v${latest} (installed v${installed}). Run: \`npm i -g @earendil-works/pi-coding-agent\``;
  } catch {
    return null;
  }
}

function buildStartupInfo(opts: {
  cwd: string;
  fileCommands: ReturnType<typeof loadSlashCommands>;
  updateNotice: string | null;
}): string {
  void opts.fileCommands;

  const md: string[] = [];

  // pi version header
  try {
    const piVersion = spawnSync("pi", ["--version"], { encoding: "utf-8" });
    const installed = (
      String(piVersion.stdout ?? "").trim() || String(piVersion.stderr ?? "").trim()
    ).replace(/^v/i, "");
    if (installed) {
      md.push(`pi v${installed}`);
      md.push("---");
      md.push("");
    }
  } catch {
    // ignore
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
  const promptsDir = join(process.env.HOME ?? "", ".pi", "agent", "prompts");
  try {
    const prompts = readdirSync(promptsDir).filter((f) => f.endsWith(".md"));
    for (const f of prompts) promptsItems.push(`/${basename(f, ".md")}`);
  } catch {
    // ignore
  }
  addSection("Prompts", promptsItems);

  // Extensions
  const extItems: string[] = [];
  const extDir = join(process.env.HOME ?? "", ".pi", "agent", "extensions");
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
