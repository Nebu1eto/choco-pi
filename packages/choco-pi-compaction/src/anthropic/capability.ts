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

export interface AnthropicFamilyFloor {
  readonly family: string;
  readonly minMajor: number;
  readonly minMinor: number;
}

export const ANTHROPIC_PROVIDER = "anthropic";
export const ANTHROPIC_FIRST_PARTY_BASE_URL = "https://api.anthropic.com";
const ADMITTED_AUTH_MODE: AnthropicAuthMode = "oauth";

export const SERVER_SIDE_COMPACTION_FAMILIES: readonly AnthropicFamilyFloor[] = [
  { family: "fable", minMajor: 5, minMinor: 0 },
  { family: "mythos", minMajor: 5, minMinor: 0 },
  { family: "opus", minMajor: 4, minMinor: 6 },
  { family: "sonnet", minMajor: 4, minMinor: 6 },
  { family: "haiku", minMajor: 5, minMinor: 5 },
];

export const SERVER_SIDE_COMPACTION_LITERAL_MODELS: readonly string[] = ["claude-mythos-preview"];

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

const IGNORED: ReadonlySet<FailureReason> = new Set(["canceled", "no-legal-cut"]);
const TRANSIENT: ReadonlySet<FailureReason> = new Set(["429", "529", "timeout", "quota"]);
const TRANSIENT_STREAK = 3;
export const FIXED_COOLDOWN_REASONS: ReadonlySet<FailureReason> = new Set<FailureReason>(["auth"]);
export const FIXED_COOLDOWN_CAP_MS = 300_000;

export type CooldownObserver = (
  entry: AnthropicSupportEntry,
  reason: FailureReason,
  until: number,
) => void;

interface CapabilityGateOptions {
  readonly enabled: boolean;
  readonly cooldownMs: number;
  readonly allowList?: readonly AnthropicSupportEntry[];
  readonly policy?: (scope: ProviderScope) => AnthropicSupportEntry | undefined;
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

  setCooldownMs(cooldownMs: number): void {
    this.cooldownMs = Math.max(0, cooldownMs);
    this.maxCooldownMs = Math.max(this.cooldownMs, this.maxCooldownMs);
  }

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

  cooldownRemaining(scope: ProviderScope): number {
    const entry = this.match(scope);
    if (entry === undefined) return 0;
    const cooldown = this.cooldowns.get(scopeKey(entry));
    return cooldown === undefined ? 0 : Math.max(0, cooldown.until - this.now());
  }
}

export function capturedProviders(allowList?: readonly AnthropicSupportEntry[]): string[] {
  if (allowList === undefined) return [ANTHROPIC_PROVIDER];
  return [...new Set(allowList.map((entry) => entry.provider))];
}

function scopeKey(entry: AnthropicSupportEntry): string {
  return [entry.provider, normalizeBaseUrl(entry.baseUrl), entry.model, entry.authMode]
    .map((field) => `${field.length}:${field}`)
    .join("|");
}
