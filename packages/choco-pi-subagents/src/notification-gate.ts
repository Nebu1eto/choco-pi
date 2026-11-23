import { STALE_CONTEXT_ERROR_PREFIX } from "@choco-pi/shared/lifecycle";

export const NUDGE_HOLD_MS = 200;
const STREAMING_HOLD_MS = 5_000;
const STEER_HOLD_MS = 30_000;
const STEER_POLL_MS = 250;
const NATIVE_STEERING_SYMBOL: unique symbol = Symbol.for("choco-pi-codex:native-steering");

interface NativeSteeringRegistry {
  [NATIVE_STEERING_SYMBOL]?: { isNativeSteerPending?: unknown } | null;
}

export function isNativeSteerPending(sessionId: string): boolean {
  try {
    // SAFETY: The registry value is only invoked after checking its callable seam.
    const registry = globalThis as typeof globalThis & NativeSteeringRegistry;
    const candidate = registry[NATIVE_STEERING_SYMBOL];
    return candidate?.isNativeSteerPending instanceof Function
      ? candidate.isNativeSteerPending(sessionId) === true
      : false;
  } catch {
    return false;
  }
}

interface NotificationRecord {
  resultConsumed?: boolean;
}

type DeliveryFailure = {} | null | undefined;

interface NotificationGateOptions<Record extends NotificationRecord> {
  resolve(key: string): Record | undefined;
  send(records: Record[]): void;
  onError(error: DeliveryFailure): void;
  isSteerPending?(sessionId: string): boolean;
}

export class NotificationGate<Record extends NotificationRecord> {
  private readonly options: NotificationGateOptions<Record>;
  private readonly keys = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerDueAt = 0;
  private sessionId: string | undefined;
  private streaming = false;
  private turnBoundary = false;
  private heldAt = 0;
  private idleReadyAt = 0;

  constructor(options: NotificationGateOptions<Record>) {
    this.options = options;
  }

  start(sessionId: string, keys: readonly string[] = []): void {
    if (this.sessionId !== sessionId) this.shutdown();
    this.sessionId = sessionId;
    for (const key of keys) this.enqueue(key);
  }

  enqueue(key: string): void {
    if (this.sessionId === undefined || this.keys.has(key)) return;
    if (this.keys.size === 0) {
      this.heldAt = Date.now();
      this.turnBoundary = false;
    }
    this.keys.set(key, Date.now());
    this.idleReadyAt = Date.now() + NUDGE_HOLD_MS;
    this.schedule(NUDGE_HOLD_MS);
  }

  cancel(key: string): void {
    this.keys.delete(key);
    if (this.keys.size === 0) this.clearTimer();
  }

  hasPending(): boolean {
    return this.keys.size > 0;
  }

  agentStart(): void {
    this.streaming = true;
    this.turnBoundary = false;
  }

  agentEnd(): void {
    this.streaming = false;
    this.check();
  }

  turnEnd(): void {
    this.turnBoundary = true;
    this.check();
  }

  shutdown(): string[] {
    this.sessionId = undefined;
    this.clearTimer();
    const keys = [...this.keys.keys()];
    this.keys.clear();
    this.streaming = false;
    return keys;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delay: number): void {
    if (this.timer !== undefined && this.timerDueAt <= Date.now() + delay) return;
    this.clearTimer();
    if (this.sessionId === undefined || this.keys.size === 0) return;
    this.timerDueAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.check();
    }, delay);
  }

  private check(): void {
    if (this.sessionId === undefined || this.keys.size === 0) return;
    const age = Date.now() - this.heldAt;
    const pending = (this.options.isSteerPending ?? isNativeSteerPending)(this.sessionId);
    let cap = this.streaming ? STREAMING_HOLD_MS : Infinity;
    if (pending) cap = STEER_HOLD_MS;
    if (Date.now() < this.idleReadyAt && age < cap) {
      return this.schedule(Math.min(this.idleReadyAt - Date.now(), cap - age));
    }
    if (pending) {
      const remaining = STEER_HOLD_MS - age;
      if (remaining > 0) return this.schedule(Math.min(STEER_POLL_MS, remaining));
    } else {
      if (this.streaming && !this.turnBoundary && age < STREAMING_HOLD_MS) {
        return this.schedule(Math.min(STEER_POLL_MS, STREAMING_HOLD_MS - age));
      }
    }
    this.flush();
  }

  private flush(): void {
    this.clearTimer();
    const readyKeys = [...this.keys].filter(([, at]) => Date.now() - at >= NUDGE_HOLD_MS);
    try {
      const records = readyKeys.flatMap(([key]) => {
        const record = this.options.resolve(key);
        return record && !record.resultConsumed ? [record] : [];
      });
      if (records.length > 0) this.options.send(records);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(STALE_CONTEXT_ERROR_PREFIX)) {
        this.sessionId = undefined;
        return;
      }
      this.options.onError(error);
    }
    for (const [key] of readyKeys) this.keys.delete(key);
    if (this.keys.size > 0) {
      this.heldAt = Math.min(...this.keys.values());
      this.schedule(Math.max(0, this.idleReadyAt - Date.now()));
    }
  }
}
