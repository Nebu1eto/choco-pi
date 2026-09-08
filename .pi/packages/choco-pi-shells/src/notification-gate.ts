import type { ShellManager, ShellResult } from "./shell-manager.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { isStaleContextError } from "./lifecycle.ts";
import type { RuntimeValue } from "./validation.ts";

const NATIVE_STEERING_SYMBOL: unique symbol = Symbol.for("choco-pi-codex:native-steering");

export const SHELL_COMPLETION_PENDING_ENTRY = "shell-completion-pending";

const IDLE_DEBOUNCE_MS = 250;
const STREAMING_MAX_HOLD_MS = 5_000;
const NATIVE_STEER_RECHECK_MS = 250;
const NATIVE_STEER_MAX_HOLD_MS = 30_000;

interface NativeSteeringCandidate {
  isNativeSteerPending?: unknown;
}

interface NativeSteeringRegistry {
  [NATIVE_STEERING_SYMBOL]?: NativeSteeringCandidate | null;
}

interface PendingCompletionData {
  keys: string[];
  shells: ShellResult[];
}

const PersistedShellSchema = Type.Object(
  {
    shellId: Type.String(),
    ownerId: Type.String(),
    name: Type.Optional(Type.String()),
    command: Type.String(),
    cwd: Type.String(),
    state: Type.Union([Type.Literal("exited"), Type.Literal("stopped"), Type.Literal("failed")]),
    pid: Type.Optional(Type.Number()),
    exitCode: Type.Optional(Type.Number()),
    signal: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
    startedAt: Type.Number(),
    endedAt: Type.Number(),
  },
  { additionalProperties: false },
);

const PendingEntrySchema = Type.Object(
  {
    type: Type.Literal("custom"),
    customType: Type.Literal(SHELL_COMPLETION_PENDING_ENTRY),
    data: Type.Object(
      {
        keys: Type.Array(Type.String()),
        shells: Type.Array(PersistedShellSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: true },
);

export interface ShellNotificationGateOptions {
  manager: ShellManager;
  flush(shells: ShellResult[]): void;
  appendEntry(type: string, data: PendingCompletionData): void;
}

function completionKey(shell: ShellResult): string | undefined {
  return shell.endedAt === undefined ? undefined : `${shell.shellId}:${shell.endedAt}`;
}

function isTerminal(shell: ShellResult): boolean {
  return shell.state === "exited" || shell.state === "stopped" || shell.state === "failed";
}

/** Resolve the optional Codex bridge without coupling this package to its publisher. */
export function isNativeSteerPending(sessionId: string): boolean {
  try {
    // SAFETY: The symbol-keyed slot is a candidate until its method is proven callable.
    const registry = globalThis as typeof globalThis & NativeSteeringRegistry;
    const candidate = registry[NATIVE_STEERING_SYMBOL];
    if (!candidate || !(candidate.isNativeSteerPending instanceof Function)) return false;
    // SAFETY: The function check establishes the only bridge call shape used here.
    return Boolean(
      (candidate.isNativeSteerPending as (id: string) => boolean).call(candidate, sessionId),
    );
  } catch {
    return false;
  }
}

export class ShellNotificationGate {
  private readonly manager: ShellManager;
  private readonly flushCallback: (shells: ShellResult[]) => void;
  private readonly appendEntry: (type: string, data: PendingCompletionData) => void;
  private readonly held = new Map<string, ShellResult>();
  private readonly deliveredBySession = new Map<string, Set<string>>();
  private sessionId: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private heldSince: number | undefined;
  private nativePendingSince: number | undefined;
  private streaming = false;
  private stopped = false;

  constructor(options: ShellNotificationGateOptions) {
    this.manager = options.manager;
    this.flushCallback = options.flush;
    this.appendEntry = options.appendEntry;
  }

  sessionStart(sessionId: string, entries: readonly RuntimeValue[]): void {
    if (this.stopped) return;
    this.sessionId = sessionId;
    this.deliveredBySession.set(sessionId, this.deliveredBySession.get(sessionId) ?? new Set());
    const entry = entries.findLast((candidate) => Value.Check(PendingEntrySchema, candidate));
    if (!entry || !Value.Check(PendingEntrySchema, entry)) return;
    for (let index = 0; index < entry.data.shells.length; index += 1) {
      const persisted = entry.data.shells[index];
      const persistedKey = entry.data.keys[index];
      if (!persisted) continue;
      // SAFETY: PendingEntrySchema validates every persisted ShellResult field and terminal state.
      const shell = persisted as ShellResult;
      if (persistedKey !== completionKey(shell)) continue;
      let resolved: ShellResult;
      try {
        resolved = this.manager.read({
          requesterId: shell.ownerId,
          isAdmin: false,
          shellId: shell.shellId,
          maxBytes: 1,
        }).shell;
      } catch {
        continue;
      }
      if (!isTerminal(resolved) || completionKey(resolved) !== persistedKey) continue;
      this.enqueue(resolved);
    }
    if (entry.data.keys.length > 0) {
      try {
        this.appendEntry(SHELL_COMPLETION_PENDING_ENTRY, { keys: [], shells: [] });
      } catch (error) {
        // SAFETY: catch produces unknown; the helper narrows before reading the message.
        if (!isStaleContextError(error as RuntimeValue)) {
          console.error("[choco-pi-shells] Shell completion persistence failed", error);
        }
      }
    }
  }

  agentStart(): void {
    if (this.stopped) return;
    this.streaming = true;
    if (this.held.size === 0 || this.heldSince === undefined) return;
    this.clearTimer();
    this.schedule(Math.max(0, STREAMING_MAX_HOLD_MS - (Date.now() - this.heldSince)));
  }

  agentEnd(): void {
    this.streaming = false;
  }

  turnEnd(): void {
    if (this.stopped) return;
    this.tryFlush();
  }

  enqueue(shell: ShellResult): void {
    if (this.stopped || this.sessionId === undefined) return;
    const key = completionKey(shell);
    if (!key || this.held.has(key) || this.delivered().has(key)) return;
    this.held.set(key, shell);
    this.heldSince ??= Date.now();
    if (this.timer !== undefined) return;
    this.schedule(this.streaming ? STREAMING_MAX_HOLD_MS : IDLE_DEBOUNCE_MS);
  }

  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimer();
    if (this.held.size === 0) return;
    const shells = [...this.held.values()];
    const keys = [...this.held.keys()];
    try {
      this.appendEntry(SHELL_COMPLETION_PENDING_ENTRY, { keys, shells });
    } catch (error) {
      // Keep the held batch intact when it was not successfully persisted.
      // SAFETY: catch produces unknown; the helper narrows before reading the message.
      if (!isStaleContextError(error as RuntimeValue)) {
        console.error("[choco-pi-shells] Shell completion persistence failed", error);
      }
      return;
    }
    this.held.clear();
    this.heldSince = undefined;
    this.nativePendingSince = undefined;
  }

  private delivered(): Set<string> {
    if (this.sessionId === undefined) return new Set();
    const delivered = this.deliveredBySession.get(this.sessionId) ?? new Set<string>();
    this.deliveredBySession.set(this.sessionId, delivered);
    return delivered;
  }

  private schedule(delay: number): void {
    if (this.stopped || this.timer !== undefined) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        if (this.stopped) return;
        this.tryFlush();
      },
      Math.max(0, delay),
    );
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private tryFlush(): void {
    if (this.stopped || this.held.size === 0 || this.sessionId === undefined) return;
    const now = Date.now();
    if (isNativeSteerPending(this.sessionId)) {
      this.nativePendingSince ??= now;
      const pendingElapsed = now - this.nativePendingSince;
      if (pendingElapsed < NATIVE_STEER_MAX_HOLD_MS) {
        this.clearTimer();
        this.schedule(Math.min(NATIVE_STEER_RECHECK_MS, NATIVE_STEER_MAX_HOLD_MS - pendingElapsed));
        return;
      }
    }

    this.clearTimer();
    const pending = [...this.held.entries()];
    this.held.clear();
    this.heldSince = undefined;
    this.nativePendingSince = undefined;
    const delivered = this.delivered();
    for (const [key] of pending) delivered.add(key);
    try {
      this.flushCallback(pending.map(([, shell]) => shell));
    } catch (error) {
      // Every flush path must contain extension failures. A stale host deactivates
      // the gate; other failed batches stay delivered and future batches may flush.
      // SAFETY: catch produces unknown; the helper narrows before reading the message.
      if (isStaleContextError(error as RuntimeValue)) {
        this.stopped = true;
        this.clearTimer();
        return;
      }
      console.error("[choco-pi-shells] Shell completion delivery failed", error);
    }
  }
}
