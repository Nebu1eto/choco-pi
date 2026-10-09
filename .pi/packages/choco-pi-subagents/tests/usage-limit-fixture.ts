/**
 * Typed fixtures for usage-limit tests: real SDK sessions, real registry
 * models, a delegating ExtensionContext builder, an injectable model switch,
 * and a policy installer that owns the process-global policy slot.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  type ScopedModel,
} from "@earendil-works/pi-coding-agent";

import { AgentManager, type AgentManagerRunner } from "../src/agent-manager.ts";
import { resetProviderHealth } from "../src/provider-health.ts";
import type { AgentRecord } from "../src/types.ts";
import {
  USAGE_LIMIT_POLICY_SYMBOL,
  type FallbackCandidateContext,
  type OnUsageLimit,
  type UsageLimitClassification,
  type UsageLimitPolicy,
} from "../src/usage-limit-seam.ts";
import { createSdkFixture } from "./sdk-fixture.ts";

export type RunResult = Awaited<ReturnType<AgentManagerRunner["runAgent"]>>;
export type ResumeResult = Awaited<ReturnType<AgentManagerRunner["resumeAgent"]>>;
export type RunAgentOptions = Parameters<AgentManagerRunner["runAgent"]>[3];
export type SetSessionModel = (session: AgentSession, model: Model<Api>) => Promise<void>;

export interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(reason: Error): void;
}

export function deferred<Value>(): Deferred<Value> {
  let resolvePromise: (value: Value) => void = () => undefined;
  let rejectPromise: (reason: Error) => void = () => undefined;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

export async function flush(): Promise<void> {
  for (let index = 0; index < 10; index++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Real built-in models from three distinct providers. */
export interface UsageLimitModels {
  /** anthropic/claude-opus-4-5 — the parent's and children's default model. */
  opus: Model<Api>;
  /**
   * openai/gpt-5.6-sol. Not openai-codex: that provider is OAuth-only, so an
   * in-memory api_key credential leaves its models out of getAvailable().
   */
  sol: Model<Api>;
  /** moonshotai/kimi-k3 */
  kimi: Model<Api>;
}

export const USAGE_LIMIT_PROVIDERS = ["anthropic", "openai", "moonshotai"] as const;

export interface ContextOverrides {
  cwd?: string;
  sessionManager?: ExtensionContext["sessionManager"];
  model?: Model<Api> | undefined;
  scopedModels?: readonly ScopedModel[];
}

export interface UsageLimitEnv {
  pi: ExtensionAPI;
  /** Real context captured from the base SDK session. */
  base: ExtensionContext;
  /** Session id of the base context; the default policy owner. */
  owner: string;
  models: UsageLimitModels;
  /**
   * Complete ExtensionContext delegating to `base`, with model defaulting to
   * opus and scopedModels defaulting to [sol, opus].
   */
  context(overrides?: ContextOverrides): ExtensionContext;
  /** A fresh real SessionManager, i.e. a distinct owner session id. */
  freshSessionManager(cwd?: string): SessionManager;
  /** A new real child AgentSession on `model` (default opus). */
  childSession(model?: Model<Api>): Promise<AgentSession>;
  /** Disposes the base session and every child session this env created. */
  dispose(): void;
}

function requireModel(context: ExtensionContext, provider: string, id: string): Model<Api> {
  const found = context.modelRegistry.find(provider, id);
  if (found === undefined) throw new Error(`Built-in model ${provider}/${id} is missing.`);
  return found;
}

/**
 * Build the environment. Must run before mock timers are enabled: SDK
 * initialization awaits real timers. `credentialed` controls which providers
 * `modelRegistry.getAvailable()` reports (default: all three).
 */
export async function createUsageLimitEnv(
  credentialed: readonly string[] = USAGE_LIMIT_PROVIDERS,
): Promise<UsageLimitEnv> {
  const fixture = await createSdkFixture(undefined, [], credentialed);
  const base = fixture.ctx;
  // refreshOnCreate is off in the SDK fixture; populate availability offline.
  await base.modelRegistry.refresh({ allowNetwork: false });
  const models: UsageLimitModels = {
    opus: requireModel(base, "anthropic", "claude-opus-4-5"),
    sol: requireModel(base, "openai", "gpt-5.6-sol"),
    kimi: requireModel(base, "moonshotai", "kimi-k3"),
  };
  const sessions: AgentSession[] = [fixture.session];

  function context(overrides: ContextOverrides = {}): ExtensionContext {
    const cwd = overrides.cwd ?? base.cwd;
    const sessionManager = overrides.sessionManager ?? base.sessionManager;
    const model = "model" in overrides ? overrides.model : models.opus;
    const scopedModels = overrides.scopedModels ?? [{ model: models.sol }, { model: models.opus }];
    return {
      get ui() {
        return base.ui;
      },
      get mode() {
        return base.mode;
      },
      get hasUI() {
        return base.hasUI;
      },
      cwd,
      sessionManager,
      get modelRegistry() {
        return base.modelRegistry;
      },
      model,
      scopedModels,
      get thinkingLevel() {
        return base.thinkingLevel;
      },
      isIdle: () => base.isIdle(),
      isProjectTrusted: () => base.isProjectTrusted(),
      get signal() {
        return base.signal;
      },
      abort: () => base.abort(),
      hasPendingMessages: () => base.hasPendingMessages(),
      shutdown: () => base.shutdown(),
      getContextUsage: () => base.getContextUsage(),
      compact: (options) => base.compact(options),
      getSystemPrompt: () => base.getSystemPrompt(),
    };
  }

  return {
    pi: fixture.pi,
    base,
    owner: base.sessionManager.getSessionId(),
    models,
    context,
    freshSessionManager: (cwd = base.cwd) => SessionManager.inMemory(cwd),
    async childSession(model = models.opus) {
      const child = await createSdkFixture(model, [], credentialed);
      sessions.push(child.session);
      return child.session;
    },
    dispose() {
      for (const session of sessions.splice(0)) session.dispose();
    },
  };
}

export type CorroborationEvidence = "confirmed" | "capacity" | "unavailable";

export interface FakeCorroboration {
  ready: boolean;
  resetAt?: number;
  evidence?: CorroborationEvidence;
}

export interface FakePolicyState {
  preference: OnUsageLimit;
  classification?: Omit<UsageLimitClassification, "provider" | "modelId">;
  corroborate: (count: number) => FakeCorroboration;
  pick?: { provider: string; id: string };
  isClosed?: (providerKey: string, accountId: string, now?: number) => boolean;
  /** Published as the policy's optional `accountId(provider)` when set. */
  accountId?: (provider: string) => string;
  closed: [string, string, number][];
  corroborations: number;
  /** Every classification handed to `corroborate`, in call order. */
  corroborated: UsageLimitClassification[];
  fallbackContexts: FallbackCandidateContext[];
}

export function policyState(overrides: Partial<FakePolicyState>): FakePolicyState {
  return {
    preference: "none",
    corroborate: () => ({ ready: false }),
    closed: [],
    corroborations: 0,
    corroborated: [],
    fallbackContexts: [],
    ...overrides,
  };
}

/** Corroboration answer as returned across the seam; `evidence` is read structurally. */
interface FixtureCorroborationResult {
  ready: boolean;
  classification: UsageLimitClassification;
  evidence?: CorroborationEvidence;
}

export interface InstalledPolicy {
  /** The installed policy object; tests may replace its members in place. */
  policy: UsageLimitPolicy;
  remove(): void;
}

/** The map this module installs in the process-global slot. */
const policySlot = new Map<string, UsageLimitPolicy>();

function ensurePolicySlot(): void {
  Object.defineProperty(globalThis, USAGE_LIMIT_POLICY_SYMBOL, {
    value: policySlot,
    configurable: true,
    writable: true,
  });
}

export function installPolicy(state: FakePolicyState, owner: string): InstalledPolicy {
  const policy: UsageLimitPolicy = {
    owner,
    generation: 1,
    preference: async () => state.preference,
    classify: (input) =>
      state.classification === undefined
        ? undefined
        : { ...state.classification, provider: input.provider, modelId: input.modelId },
    corroborate: async (classification) => {
      state.corroborations++;
      state.corroborated.push(classification);
      const answer = state.corroborate(state.corroborations);
      const result: FixtureCorroborationResult = {
        ready: answer.ready,
        classification: { ...classification, resetAt: answer.resetAt ?? classification.resetAt },
      };
      if (answer.evidence !== undefined) result.evidence = answer.evidence;
      return result;
    },
    pickFallback: (_current, fallbackContext) => {
      state.fallbackContexts.push(fallbackContext);
      return state.pick;
    },
    closeProvider: (providerKey, accountId, untilMs) => {
      state.closed.push([providerKey, accountId, untilMs]);
    },
    isClosed: (providerKey, accountId, now) =>
      state.isClosed?.(providerKey, accountId, now) ?? false,
  };
  const resolveAccount = state.accountId;
  if (resolveAccount !== undefined) policy.accountId = (provider) => resolveAccount(provider);
  return installPolicyObject(policy, owner);
}

/** Install an already-built policy (e.g. the root's real one) for `owner`. */
export function installPolicyObject(policy: UsageLimitPolicy, owner: string): InstalledPolicy {
  ensurePolicySlot();
  policySlot.set(owner, policy);
  return {
    policy,
    remove: () => {
      if (policySlot.get(owner) === policy) policySlot.delete(owner);
    },
  };
}

export interface Harness {
  manager: AgentManager;
  runs: Deferred<RunResult>[];
  resumes: Deferred<ResumeResult>[];
  resumePrompts: string[];
  /** Options of every `runAgent` call, in call order (drive runner callbacks). */
  runOptions: RunAgentOptions[];
  /** Prompt of every `runAgent` call, in call order. */
  runPrompts: string[];
  /** Agent type of every `runAgent` call, in call order. */
  runTypes: string[];
  completions: AgentRecord["status"][];
  usageEvents: string[];
  /** Every model passed to the injected `setSessionModel`, in call order. */
  modelSwitches: Model<Api>[];
}

export interface HarnessOptions {
  maxConcurrent?: number;
  /** Runs after the switch is recorded; throw to simulate a failed switch. */
  setSessionModel?: SetSessionModel;
  /** Called synchronously inside each `runAgent`, e.g. to fire onSessionCreated. */
  onRunAgent?: (options: RunAgentOptions) => void;
}

export function harness(options: HarnessOptions = {}): Harness {
  const runs: Deferred<RunResult>[] = [];
  const resumes: Deferred<ResumeResult>[] = [];
  const resumePrompts: string[] = [];
  const runOptions: RunAgentOptions[] = [];
  const runPrompts: string[] = [];
  const runTypes: string[] = [];
  const completions: AgentRecord["status"][] = [];
  const usageEvents: string[] = [];
  const modelSwitches: Model<Api>[] = [];
  const switchModel = options.setSessionModel;
  const runner: AgentManagerRunner = {
    runAgent(_ctx, type, prompt, runAgentOptions) {
      runOptions.push(runAgentOptions);
      runPrompts.push(prompt);
      runTypes.push(type);
      const run = deferred<RunResult>();
      runs.push(run);
      options.onRunAgent?.(runAgentOptions);
      return run.promise;
    },
    resumeAgent(_session, prompt) {
      resumePrompts.push(prompt);
      const run = deferred<ResumeResult>();
      resumes.push(run);
      return run.promise;
    },
    async setSessionModel(session, model) {
      modelSwitches.push(model);
      if (switchModel !== undefined) await switchModel(session, model);
    },
  };
  const manager = new AgentManager(
    (record) => completions.push(record.status),
    options.maxConcurrent ?? 4,
    undefined,
    undefined,
    runner,
  );
  manager.setUsageLimitListener((record) =>
    usageEvents.push(`${record.status}:${record.usageLimit?.status}`),
  );
  return {
    manager,
    runs,
    resumes,
    resumePrompts,
    runOptions,
    runPrompts,
    runTypes,
    completions,
    usageEvents,
    modelSwitches,
  };
}

export function cleanupProviders(): void {
  for (const provider of USAGE_LIMIT_PROVIDERS) resetProviderHealth(provider);
}
