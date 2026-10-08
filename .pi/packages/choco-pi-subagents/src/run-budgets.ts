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
  steerConclusion(message?: string): void;
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
  private largestRequestCharge = 0;
  private tokenConclusionRequested = false;
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
    const requestCharge = usage.input + usage.output + usage.cacheWrite;
    this.tokens += requestCharge;
    this.largestRequestCharge = Math.max(this.largestRequestCharge, requestCharge);
    const maxTokens = this.limits.maxTokens;
    if (maxTokens === undefined) return;
    if (this.tokens >= maxTokens) {
      this.stop(
        "budget_exceeded",
        `Token budget exceeded at ${this.tokens} tokens (limit ${maxTokens}).`,
      );
      return;
    }
    this.requestTokenConclusion(maxTokens);
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

  private requestTokenConclusion(maxTokens: number): void {
    const reserve = Math.max(0.2 * maxTokens, 1.5 * this.largestRequestCharge);
    const threshold = Math.max(0.5 * maxTokens, maxTokens - reserve);
    if (this.tokenConclusionRequested || this.tokens < threshold) return;
    this.tokenConclusionRequested = true;
    const remaining = Math.floor(maxTokens - this.tokens);
    this.hooks.steerConclusion(
      `About ${remaining} tokens remain of your ${maxTokens}-token budget; conclude now with your current findings in the required output format.`,
    );
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
