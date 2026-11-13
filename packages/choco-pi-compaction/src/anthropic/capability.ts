/**
 * Explicit support policy for Anthropic native on-demand compaction.
 *
 * Eligibility is a static, local decision: the first-party Anthropic provider
 * at `https://api.anthropic.com`, OAuth credentials, and a model whose family
 * and version reach the documented floor. Nothing is probed over the network,
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

/** One exact provider/model/endpoint/auth combination (test and harness override). */
export interface AnthropicSupportEntry {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly authMode: AnthropicAuthMode;
}

/** Minimum version of one model family that supports on-demand compaction. */
export interface AnthropicFamilyFloor {
  readonly family: string;
  readonly minMajor: number;
  readonly minMinor: number;
}

/** The only provider, endpoint and auth mode the default policy admits. */
export const ANTHROPIC_PROVIDER = "anthropic";
export const ANTHROPIC_FIRST_PARTY_BASE_URL = "https://api.anthropic.com";
const ADMITTED_AUTH_MODE: AnthropicAuthMode = "oauth";

/**
 * Documented supported models (compaction-on-demand "Compatibility"): Fable 5+,
 * Mythos 5+ and Preview, Opus 4.6+, Sonnet 4.6+, Haiku 5.5+.
 */
export const SERVER_SIDE_COMPACTION_FAMILIES: readonly AnthropicFamilyFloor[] = [
  { family: "fable", minMajor: 5, minMinor: 0 },
  { family: "mythos", minMajor: 5, minMinor: 0 },
  { family: "opus", minMajor: 4, minMinor: 6 },
  { family: "sonnet", minMajor: 4, minMinor: 6 },
  { family: "haiku", minMajor: 5, minMinor: 5 },
];

/** Supported model IDs outside the numeric grammar. */
export const SERVER_SIDE_COMPACTION_LITERAL_MODELS: readonly string[] = ["claude-mythos-preview"];

/** `claude-<family>-<major>(-<minor>)?(-<yyyymmdd>)?` */
const MODEL_ID_PATTERN = /^claude-([a-z]+)-(\d{1,3})(?:-(\d{1,2}))?(?:-(\d{8}))?$/u;

interface ParsedModelId {
  readonly family: string;
  readonly major: number;
  readonly minor: number;
}

export function parseAnthropicModelId(model: string): ParsedModelId | undefined {
  const match = MODEL_ID_PATTERN.exec(model);
  if (match === null) return undefined;
  const [, family, major, minor] = match;
  if (family === undefined || major === undefined) return undefined;
  return { family, major: Number(major), minor: minor === undefined ? 0 : Number(minor) };
}

/** Whether a model ID meets the family floor table (numeric version compare). */
export function modelSupportsServerSideCompaction(
  model: string,
  families: readonly AnthropicFamilyFloor[] = SERVER_SIDE_COMPACTION_FAMILIES,
  literals: readonly string[] = SERVER_SIDE_COMPACTION_LITERAL_MODELS,
): boolean {
  if (literals.includes(model)) return true;
  const parsed = parseAnthropicModelId(model);
  if (parsed === undefined) return false;
  const floor = families.find((entry) => entry.family === parsed.family);
  if (floor === undefined) return false;
  if (parsed.major !== floor.minMajor) return parsed.major > floor.minMajor;
  return parsed.minor >= floor.minMinor;
}

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
/**
 * Reasons cooled for a fixed, capped wait instead of the doubling rule: a
 * credential failure is not healed by waiting longer, and a long cooldown
 * only hides a fixed login (D10). The wait is `min(cooldownMs, 300_000)`.
 */
export const FIXED_COOLDOWN_REASONS: ReadonlySet<FailureReason> = new Set<FailureReason>(["auth"]);
export const FIXED_COOLDOWN_CAP_MS = 300_000;

/** Called when a cooldown actually starts (wait > 0), after it is recorded. */
export type CooldownObserver = (
  entry: AnthropicSupportEntry,
  reason: FailureReason,
  until: number,
) => void;

interface CapabilityGateOptions {
  readonly enabled: boolean;
  readonly cooldownMs: number;
  /**
   * Exact combinations admitted instead of the default policy (tests and
   * harnesses that use a synthetic provider or endpoint). When set, only these
   * entries match.
   */
  readonly allowList?: readonly AnthropicSupportEntry[];
  /**
   * Default policy replacing the Anthropic first-party policy when no
   * allow-list is set (another vendor's static support policy).
   */
  readonly policy?: (scope: ProviderScope) => AnthropicSupportEntry | undefined;
  /** Family floors of the default policy; defaults to {@link SERVER_SIDE_COMPACTION_FAMILIES}. */
  readonly families?: readonly AnthropicFamilyFloor[];
  readonly maxCooldownMs?: number;
  readonly maxTrackedScopes?: number;
  readonly now?: () => number;
  readonly onCooldown?: CooldownObserver;
}

interface CooldownState {
  consecutive: number;
  until: number;
  reason: FailureReason;
}

export class AnthropicCapabilityGate {
  private readonly enabled: boolean;
  private readonly allowList: readonly AnthropicSupportEntry[] | undefined;
  private readonly policy:
    | ((scope: ProviderScope) => AnthropicSupportEntry | undefined)
    | undefined;
  private readonly families: readonly AnthropicFamilyFloor[];
  private cooldownMs: number;
  private maxCooldownMs: number;
  private readonly maxTrackedScopes: number;
  private readonly now: () => number;
  private readonly cooldowns = new Map<string, CooldownState>();
  private readonly onCooldown: CooldownObserver | undefined;

  constructor(options: CapabilityGateOptions) {
    this.enabled = options.enabled;
    this.allowList = options.allowList;
    this.policy = options.policy;
    this.families = options.families ?? SERVER_SIDE_COMPACTION_FAMILIES;
    this.cooldownMs = Math.max(0, options.cooldownMs);
    this.maxCooldownMs = Math.max(this.cooldownMs, options.maxCooldownMs ?? 3_600_000);
    this.maxTrackedScopes = Math.max(1, options.maxTrackedScopes ?? 64);
    this.now = options.now ?? Date.now;
    this.onCooldown = options.onCooldown;
  }

  /** Base cooldown for the next failure (the loaded sidecar's `cooldownMs`); running cooldowns are unchanged. */
  setCooldownMs(cooldownMs: number): void {
    this.cooldownMs = Math.max(0, cooldownMs);
    this.maxCooldownMs = Math.max(this.cooldownMs, this.maxCooldownMs);
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

  /** The admitted combination for a scope, or undefined when the policy refuses it. */
  match(scope: ProviderScope): AnthropicSupportEntry | undefined {
    if (scope.authMode === undefined || scope.baseUrl === undefined) return undefined;
    const baseUrl = normalizeBaseUrl(scope.baseUrl);
    if (this.allowList !== undefined) {
      return this.allowList.find(
        (entry) =>
          entry.provider === scope.provider &&
          entry.model === scope.model &&
          entry.authMode === scope.authMode &&
          normalizeBaseUrl(entry.baseUrl) === baseUrl,
      );
    }
    if (this.policy !== undefined) return this.policy(scope);
    if (
      scope.provider !== ANTHROPIC_PROVIDER ||
      scope.authMode !== ADMITTED_AUTH_MODE ||
      baseUrl !== ANTHROPIC_FIRST_PARTY_BASE_URL ||
      !modelSupportsServerSideCompaction(scope.model, this.families)
    ) {
      return undefined;
    }
    return {
      provider: ANTHROPIC_PROVIDER,
      model: scope.model,
      baseUrl: ANTHROPIC_FIRST_PARTY_BASE_URL,
      authMode: ADMITTED_AUTH_MODE,
    };
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
    } else if (FIXED_COOLDOWN_REASONS.has(reason)) {
      wait = Math.min(this.cooldownMs, FIXED_COOLDOWN_CAP_MS);
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
    if (wait > 0) this.onCooldown?.(entry, reason, until);
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

/** Providers whose Anthropic stream must be captured for replay under a policy. */
export function capturedProviders(allowList?: readonly AnthropicSupportEntry[]): string[] {
  if (allowList === undefined) return [ANTHROPIC_PROVIDER];
  return [...new Set(allowList.map((entry) => entry.provider))];
}

/** Length-prefixed fields: each part is self-delimiting, so distinct tuples never collide. */
function scopeKey(entry: AnthropicSupportEntry): string {
  return [entry.provider, normalizeBaseUrl(entry.baseUrl), entry.model, entry.authMode]
    .map((field) => `${field.length}:${field}`)
    .join("|");
}
