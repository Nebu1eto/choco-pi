export interface RunBudgetLimits {
  /** Maximum elapsed time for this run, measured from actual start. */
  timeoutMs?: number;
  /** Maximum completed tool calls for this run. */
  maxToolCalls?: number;
  /** Maximum input + output + cache-write tokens reported for this run. */
  maxTokens?: number;
  /** Inactivity interval before conclusion steering, then watchdog stop. */
  idleTimeoutMs?: number;
}

export type ForcedTerminalStatus = "budget_exceeded" | "watchdog_stopped";

interface RunBudgetHooks {
  isActive(): boolean;
  steerConclusion(): void;
  stop(status: ForcedTerminalStatus, reason: string): void;
  onDispose(controller: RunBudgetController): void;
}

function armTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return timer;
}

/** Per-generation budget/watchdog state. It never publishes terminal results itself. */
export class RunBudgetController {
  private readonly limits: RunBudgetLimits;
  private readonly hooks: RunBudgetHooks;
  private wallTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private toolCalls = 0;
  private tokens = 0;
  private conclusionRequested = false;
  private disposed = false;

  constructor(limits: RunBudgetLimits, hooks: RunBudgetHooks) {
    this.limits = limits;
    this.hooks = hooks;

    if (limits.timeoutMs !== undefined) {
      this.wallTimer = armTimer(() => {
        if (!this.hooks.isActive()) return;
        this.stop("budget_exceeded", `Wall-clock budget exceeded after ${limits.timeoutMs}ms.`);
      }, limits.timeoutMs);
    }
    this.armIdleTimer();
  }

  noteToolActivity(type: "start" | "end"): void {
    if (!this.isActive()) return;
    this.armIdleTimer();
    if (type !== "end") return;
    this.toolCalls++;
    if (this.limits.maxToolCalls !== undefined && this.toolCalls >= this.limits.maxToolCalls) {
      this.stop(
        "budget_exceeded",
        `Tool-call budget exceeded after ${this.toolCalls} completed call${this.toolCalls === 1 ? "" : "s"} (limit ${this.limits.maxToolCalls}).`,
      );
    }
  }

  noteUsage(usage: { input: number; output: number; cacheWrite: number }): void {
    if (!this.isActive()) return;
    this.tokens += usage.input + usage.output + usage.cacheWrite;
    if (this.limits.maxTokens !== undefined && this.tokens >= this.limits.maxTokens) {
      this.stop(
        "budget_exceeded",
        `Token budget exceeded at ${this.tokens} tokens (limit ${this.limits.maxTokens}).`,
      );
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.wallTimer !== undefined) clearTimeout(this.wallTimer);
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.wallTimer = undefined;
    this.idleTimer = undefined;
    this.hooks.onDispose(this);
  }

  private isActive(): boolean {
    return !this.disposed && this.hooks.isActive();
  }

  private armIdleTimer(): void {
    if (this.limits.idleTimeoutMs === undefined || this.disposed) return;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = armTimer(() => {
      if (!this.isActive()) return;
      if (!this.conclusionRequested) {
        this.conclusionRequested = true;
        this.hooks.steerConclusion();
        this.armIdleTimer();
        return;
      }
      this.stop(
        "watchdog_stopped",
        `Idle watchdog stopped the run after a conclusion request and another ${this.limits.idleTimeoutMs}ms without tool activity.`,
      );
    }, this.limits.idleTimeoutMs);
  }

  private stop(status: ForcedTerminalStatus, reason: string): void {
    if (!this.isActive()) return;
    this.dispose();
    this.hooks.stop(status, reason);
  }
}
