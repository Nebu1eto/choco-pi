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

type PackageIdentity = {
  name?: string;
  version?: string;
};

type StoredSessionLocation = {
  cwd: string;
  sessionFile: string;
};

type PiAcpAgentConfig = {
  piCommand?: string;
};

type RestoreSessionOptions = {
  cwd?: string;
  mcpServers?: LoadSessionRequest["mcpServers"];
};

type SetSessionModelRequest = {
  sessionId: string;
  modelId: string;
};

export type SessionManagerLike = Pick<
  SessionManager,
  "create" | "maybeGet" | "getOrCreate" | "close" | "disposeAll" | "shutdownAll"
> & {
  get?: SessionManager["get"];
  retainRecent?: SessionManager["retainRecent"];
};

export type SessionStoreLike = Pick<SessionStore, "get" | "upsert" | "delete">;

function clientSupportsTerminalAuthMeta(params: InitializeRequest): boolean {
  const capabilities = recordField(params, "clientCapabilities");
  const metadata = recordField(capabilities, "_meta");
  return booleanField(metadata, "terminal-auth") === true;
}

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

  async refreshAvailableCommands(sessionId: string): Promise<void> {
    const generation = this.generation;
    this.assertCurrent(generation);
    const session = await this.restoreSession(sessionId);
    this.assertCurrent(generation);
    await this.publishCommandCatalog(session);
    this.assertCurrent(generation);
  }

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
      } catch {}
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
    const supportedVersion = 1;
    const requested = params.protocolVersion;

    return {
      protocolVersion: requested === supportedVersion ? requested : supportedVersion,
      agentInfo: {
        name: pkg.name ?? "pi-acp",
        title: "pi ACP adapter",
        version: pkg.version ?? "0.0.0",
      },
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
    const startupProbe = probePiStartup(this.piCommand);

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

    if (preludeText)
      setTimeout(() => {
        if (this.active && this.generation === generation) session.sendStartupInfoIfPending();
      }, 0);

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

      if (this.sessions.maybeGet(sessionId)?.proc === proc) {
        try {
          await this.publishCommandCatalog(session);
        } catch {}
        this.assertCurrent(generation);
      }

      return { stopReason: "end_turn" };
    }

    if (invocation && command?.source === "builtin") {
      const handled = await runBuiltinCommand(session, invocation, {
        piCommand: this.piCommand,
        assertCurrent: () => this.assertCurrent(generation),
      });
      if (handled) return handled;
    }

    const result = await session.prompt(message, images);

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

    this.sessions.retainRecent?.(session.sessionId, PI_ACP_MAX_LIVE_SESSIONS);

    this.store.upsert({
      sessionId: params.sessionId,
      cwd: params.cwd,
      sessionFile: stored.sessionFile,
    });

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

    if (!stored && !piSession) {
      return {};
    }

    const sessionFile = stored?.sessionFile ?? piSession?.sessionFile;

    if (sessionFile) {
      try {
        if (existsSync(sessionFile)) unlinkSync(sessionFile);
      } catch {}
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

  const contextItems: string[] = [];
  const contextPath = join(opts.cwd, "AGENTS.md");
  if (existsSync(contextPath)) contextItems.push(contextPath);
  addSection("Context", contextItems);

  const skillsItems: string[] = [];

  const pushSkillFromRoot = (root: string) => {
    try {
      for (const e of readdirSync(root)) {
        const p = join(root, e);
        try {
          const st = statSync(p);
          if (st.isFile() && e.toLowerCase().endsWith(".md")) {
            skillsItems.push(p);
          }
        } catch {}
      }

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
    } catch {}
  };

  const globalSkillsDir = join(getAgentDir(), "skills");
  pushSkillFromRoot(globalSkillsDir);

  const legacyAgentsSkillsDir = join(process.env.HOME ?? "", ".agents", "skills");
  pushSkillFromRoot(legacyAgentsSkillsDir);

  const projectSkillsDir = join(opts.cwd, ".pi", "skills");
  pushSkillFromRoot(projectSkillsDir);

  addSection("Skills", skillsItems);

  const promptsItems: string[] = [];
  const agentDirs = startupInfoAgentDirs();
  const promptsDir = agentDirs.prompts;
  try {
    const prompts = readdirSync(promptsDir).filter((f) => f.endsWith(".md"));
    for (const f of prompts) promptsItems.push(`/${basename(f, ".md")}`);
  } catch {}
  addSection("Prompts", promptsItems);

  const extItems: string[] = [];
  const extDir = agentDirs.extensions;
  try {
    const exts = readdirSync(extDir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
    for (const f of exts) extItems.push(join(extDir, f));
  } catch {}

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
    } catch {}
  }

  addSection("Extensions", extItems);

  if (opts.updateNotice) {
    md.push("---");
    md.push(opts.updateNotice);
    md.push("");
  }

  return md.join("\n").trim() + "\n";
}

function readNearestPackageJson(metaUrl: string): PackageIdentity {
  try {
    let dir = dirname(fileURLToPath(metaUrl));

    for (let i = 0; i < 6; i++) {
      const p = join(dir, "package.json");
      if (existsSync(p)) {
        const json: BoundaryValue = JSON.parse(readFileSync(p, "utf-8"));
        return { name: stringField(json, "name"), version: stringField(json, "version") };
      }
      dir = dirname(dir);
    }
  } catch {}
  return { name: "pi-acp", version: "0.0.0" };
}
