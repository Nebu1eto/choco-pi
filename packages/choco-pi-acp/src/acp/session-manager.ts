import { type McpServer, RequestError } from "@agentclientprotocol/sdk";
import { type BoundaryValue, isNumber, isString } from "../boundary.ts";
import { SessionStore } from "./session-store.ts";
import {
  PiRpcStaleContextError,
  PiRpcProcess,
  PiRpcSpawnError,
  type PiRpcProcessLike,
} from "../pi-rpc/process.ts";
import type { PiState } from "../pi-rpc/protocol.ts";
import { type AcpConnection, PiAcpSession } from "./session.ts";

export type SessionCreateParams = {
  cwd: string;
  mcpServers: McpServer[];
  conn: AcpConnection;
  fileCommands?: import("./slash-commands.ts").FileSlashCommand[];
  piCommand?: string;
};

export const DEFAULT_PI_ACP_MAX_LIVE_SESSIONS = 8;

export const DEFAULT_PI_ACP_SESSION_IDLE_MS = 10 * 60_000;

export function integerSetting(value: BoundaryValue): number | undefined {
  let parsed = Number.NaN;
  if (isNumber(value)) parsed = value;
  else if (isString(value) && /^[+-]?\d+$/.test(value.trim())) parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return undefined;
  return parsed;
}

export function boundedMaxLiveSessions(value: BoundaryValue): number {
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

export async function shutdownSession(session: PiAcpSession, graceMs?: number): Promise<void> {
  await session.closeExtensionUi();
  await session.proc.shutdown?.(graceMs);
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

  maybeGet(sessionId: string): PiAcpSession | undefined {
    return this.sessions.get(sessionId);
  }

  close(sessionId: string): void {
    this.recency.delete(sessionId);
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    void s.closeExtensionUi().finally(() => {
      try {
        s.proc.dispose?.();
      } catch {}
    });
  }

  private reapIdle(sessionId: string, session: PiAcpSession): void {
    if (!this.active || this.sessions.get(sessionId) !== session) return;
    this.sessions.delete(sessionId);
    this.recency.delete(sessionId);
    session.reap();
  }

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
