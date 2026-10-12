/**
 * Explicit support policy for Anthropic native on-demand compaction.
 *
 * Eligibility is a static allow-list of tested provider/baseUrl/model/auth-mode
 * combinations behind the settings flag. Nothing is probed over the network,
 * on session start or otherwise. Failures put the combination on a bounded
 * cooldown so a broken combination cannot cause a paid retry loop.
 */
import type {
  BackgroundCompactionSettings,
  CapabilityVerdict,
  FailureReason,
  ProviderScope,
} from "../background/contract.ts";
import type { AnthropicAuthMode } from "./details.ts";

export interface AnthropicSupportEntry {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly authMode: AnthropicAuthMode;
}

/** The only combination with live evidence (E11/E12): OAuth + Haiku 5.5 on the first-party API. */
export const TESTED_ANTHROPIC_COMBINATIONS: readonly AnthropicSupportEntry[] = [
  {
    provider: "anthropic",
    model: "claude-haiku-5-5",
    baseUrl: "https://api.anthropic.com",
    authMode: "oauth",
  },
];

/** The installed adapter sends OAuth (Bearer) auth exactly when the key carries this marker. */
const OAUTH_TOKEN_MARKER = "sk-ant-oat";

export function authModeOf(apiKey: string | undefined): AnthropicAuthMode | undefined {
  if (apiKey === undefined || apiKey.length === 0) return undefined;
  return apiKey.includes(OAUTH_TOKEN_MARKER) ? "oauth" : "api-key";
}

export function anthropicNativeEnabled(settings: BackgroundCompactionSettings): boolean {
  return settings.enabled && settings.anthropicNative;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, "");
}

/** Reasons decided before any request; they say nothing about the combination's health. */
const IGNORED: ReadonlySet<FailureReason> = new Set(["canceled", "no-legal-cut"]);
const TRANSIENT: ReadonlySet<FailureReason> = new Set(["429", "529", "timeout", "quota"]);
/** Consecutive transient failures tolerated before a cooldown starts. */
const TRANSIENT_STREAK = 3;

interface CapabilityGateOptions {
  readonly enabled: boolean;
  readonly cooldownMs: number;
  readonly allowList?: readonly AnthropicSupportEntry[];
  readonly maxCooldownMs?: number;
  readonly maxTrackedScopes?: number;
  readonly now?: () => number;
}

interface CooldownState {
  consecutive: number;
  until: number;
  reason: FailureReason;
}

export class AnthropicCapabilityGate {
  private readonly enabled: boolean;
  private readonly allowList: readonly AnthropicSupportEntry[];
  private readonly cooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly maxTrackedScopes: number;
  private readonly now: () => number;
  private readonly cooldowns = new Map<string, CooldownState>();

  constructor(options: CapabilityGateOptions) {
    this.enabled = options.enabled;
    this.allowList = options.allowList ?? TESTED_ANTHROPIC_COMBINATIONS;
    this.cooldownMs = Math.max(0, options.cooldownMs);
    this.maxCooldownMs = Math.max(this.cooldownMs, options.maxCooldownMs ?? 3_600_000);
    this.maxTrackedScopes = Math.max(1, options.maxTrackedScopes ?? 64);
    this.now = options.now ?? Date.now;
  }

  /** Synchronous, local decision. Never performs I/O. */
  check(scope: ProviderScope): CapabilityVerdict {
    if (!this.enabled) return { supported: false, reason: "unsupported" };
    const entry = this.match(scope);
    if (entry === undefined) return { supported: false, reason: "unsupported" };
    const cooldown = this.cooldowns.get(scopeKey(entry));
    if (cooldown !== undefined && this.now() < cooldown.until) {
      return { supported: false, reason: cooldown.reason };
    }
    return { supported: true };
  }

  /** The allow-listed entry for a scope, or undefined when the combination is not listed. */
  match(scope: ProviderScope): AnthropicSupportEntry | undefined {
    if (scope.authMode === undefined || scope.baseUrl === undefined) return undefined;
    const baseUrl = normalizeBaseUrl(scope.baseUrl);
    return this.allowList.find(
      (entry) =>
        entry.provider === scope.provider &&
        entry.model === scope.model &&
        entry.authMode === scope.authMode &&
        normalizeBaseUrl(entry.baseUrl) === baseUrl,
    );
  }

  recordFailure(scope: ProviderScope, reason: FailureReason, retryAfterMs?: number): void {
    if (IGNORED.has(reason)) return;
    const entry = this.match(scope);
    if (entry === undefined) return;
    const key = scopeKey(entry);
    const previous = this.cooldowns.get(key);
    const consecutive = (previous?.consecutive ?? 0) + 1;
    let wait: number;
    if (TRANSIENT.has(reason)) {
      wait = Math.max(retryAfterMs ?? 0, consecutive >= TRANSIENT_STREAK ? this.cooldownMs : 0);
    } else {
      wait = this.cooldownMs * 2 ** Math.min(consecutive - 1, 16);
    }
    const until = this.now() + Math.min(wait, this.maxCooldownMs);
    this.cooldowns.delete(key);
    this.cooldowns.set(key, { consecutive, until, reason });
    while (this.cooldowns.size > this.maxTrackedScopes) {
      const oldest = this.cooldowns.keys().next();
      if (oldest.done === true) break;
      this.cooldowns.delete(oldest.value);
    }
  }

  recordSuccess(scope: ProviderScope): void {
    const entry = this.match(scope);
    if (entry !== undefined) this.cooldowns.delete(scopeKey(entry));
  }

  /** Remaining cooldown in milliseconds (0 when none). */
  cooldownRemaining(scope: ProviderScope): number {
    const entry = this.match(scope);
    if (entry === undefined) return 0;
    const cooldown = this.cooldowns.get(scopeKey(entry));
    return cooldown === undefined ? 0 : Math.max(0, cooldown.until - this.now());
  }
}

/** Length-prefixed fields: each part is self-delimiting, so distinct tuples never collide. */
function scopeKey(entry: AnthropicSupportEntry): string {
  return [entry.provider, normalizeBaseUrl(entry.baseUrl), entry.model, entry.authMode]
    .map((field) => `${field.length}:${field}`)
    .join("|");
}
