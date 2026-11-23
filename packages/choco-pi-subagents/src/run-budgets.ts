export interface RunBudgetLimits {
  timeoutMs?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  idleTimeoutMs?: number;
}

export type ForcedTerminalStatus = "budget_exceeded" | "watchdog_stopped";

export const BOOTSTRAP_FLOOR_MULTIPLIER = 1.5;

interface BootstrapTool {
  name?: string;
  description?: string;
  parameters?: unknown;
}

export function estimateBootstrapTokens(input: {
  systemPrompt?: string;
  tools?: readonly BootstrapTool[];
}): number {
  let chars = input.systemPrompt?.length ?? 0;
  for (const tool of input.tools ?? []) {
    chars += (tool.name?.length ?? 0) + (tool.description?.length ?? 0);
    if (tool.parameters !== undefined) chars += JSON.stringify(tool.parameters)?.length ?? 0;
  }
  return Math.ceil(chars / 4);
}

export function bootstrapFloorRefusal(
  maxTokens: number | undefined,
  estimatedTokens: number,
): string | undefined {
  if (maxTokens === undefined || estimatedTokens <= 0) return undefined;
  const floor = Math.ceil(estimatedTokens * BOOTSTRAP_FLOOR_MULTIPLIER);
  if (maxTokens >= floor) return undefined;
  return `max_tokens ${maxTokens} is below the estimated first request (~${estimatedTokens} tokens); omit the field or set >= ${floor}`;
}

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

export class RunBudgetController {
  private readonly limits: RunBudgetLimits;
  private readonly hooks: RunBudgetHooks;
  private wallTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private toolCalls = 0;
  private tokens = 0;
  private largestRequestCharge = 0;
  private lastUsage?: { input: number; output: number; cacheWrite: number };
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
    this.lastUsage = { input: usage.input, output: usage.output, cacheWrite: usage.cacheWrite };
    const maxTokens = this.limits.maxTokens;
    if (maxTokens === undefined) return;
    if (this.tokens >= maxTokens) {
      const last = this.lastUsage;
      this.stop(
        "budget_exceeded",
        `Token budget exceeded at ${this.tokens} tokens (limit ${maxTokens}).` +
          ` (last request: input ${last.input}, cacheWrite ${last.cacheWrite}, output ${last.output})`,
      );
      return;
    }
    this.requestTokenConclusion(maxTokens);
  }

  checkBootstrap(estimatedTokens: number): boolean {
    if (!this.isActive()) return true;
    const refusal = bootstrapFloorRefusal(this.limits.maxTokens, estimatedTokens);
    if (refusal === undefined) return true;
    this.stop("budget_exceeded", refusal);
    return false;
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
