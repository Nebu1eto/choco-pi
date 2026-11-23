import * as path from "node:path";
import { type SpawnResult, safeSpawnAsync } from "./safe-spawn.ts";
import { findLocalToolConfig } from "./path-utils.ts";
import { incrementDegradationCount } from "./degradation-ledger.ts";
import {
  type AvailabilityCause,
  type AvailabilityOutcome,
  classifyProbeFailure,
  createAvailabilityLatch,
  logAvailabilityDecision,
  startHostStallSampler,
} from "./dispatch/runners/utils/availability-policy.ts";

type ClassifyGhTokenFailureResultContract = {
  outcome: AvailabilityOutcome;
  cause: AvailabilityCause;
};

export const LOCAL_ZIZMOR_CONFIG_NAMES = [
  path.join(".github", "zizmor.yml"),
  path.join(".github", "zizmor.yaml"),
  "zizmor.yml",
  "zizmor.yaml",
] as const;

export function findLocalZizmorConfig(startDir: string): string | undefined {
  return findLocalToolConfig(startDir, LOCAL_ZIZMOR_CONFIG_NAMES);
}

export function isZizmorAuditTarget(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const base = path.basename(normalized).toLowerCase();
  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(normalized)) return true;
  if (base === "action.yml" || base === "action.yaml") return true;
  if (/(^|\/)\.github\/dependabot\.ya?ml$/i.test(normalized)) return true;
  return false;
}

const ZIZMOR_TOKEN_MAX_COOLDOWN_MS = 120_000;
const ghTokenLatch = createAvailabilityLatch({
  maxCooldownMs: ZIZMOR_TOKEN_MAX_COOLDOWN_MS,
});
let cachedToken: string | undefined;

const GH_TOKEN_PROBE_TIMEOUT_MS = 5000;

export function resetZizmorTokenAvailability(): void {
  ghTokenLatch.reset();
  cachedToken = undefined;
}

export function _resetZizmorTokenCacheForTests(): void {
  resetZizmorTokenAvailability();
}

function classifyGhTokenFailure(
  res: SpawnResult,
  hostStallMs: number,
): ClassifyGhTokenFailureResultContract {
  const neverAnswered = res.status === null || (res.status ?? 0) < 0;
  if (!res.error && !neverAnswered) {
    return { outcome: "non-installable", cause: "probe-rejected" };
  }
  if (res.spawnFailure?.kind === "tool-not-found") {
    return { outcome: "missing", cause: "not-found" };
  }
  const classified = classifyProbeFailure(res, { hostStallMs });
  if (classified.outcome === "transient" || classified.outcome === "missing") {
    return classified;
  }

  return { outcome: "transient", cause: classified.cause };
}

async function deriveGhCliToken(): Promise<string | undefined> {
  const sampler = startHostStallSampler();
  const startedAt = Date.now();
  const res = await safeSpawnAsync("gh", ["auth", "token"], {
    timeout: GH_TOKEN_PROBE_TIMEOUT_MS,
    ignoreAmbientSignal: true,
  });
  const hostStallMs = sampler.stop();
  const elapsedMs = Date.now() - startedAt;

  if (!res.error && res.status === 0) {
    const token = res.stdout.trim();
    if (token.length > 0) {
      ghTokenLatch.noteAvailable();
      logAvailabilityDecision({
        tool: "zizmor-gh-token",
        verdict: "available",
        outcome: "success",
        cause: "ok",
        elapsedMs,
        latched: true,
        hostStallMs,
        budgetMs: GH_TOKEN_PROBE_TIMEOUT_MS,
      });
      return token;
    }
    return recordGhTokenUnavailable(
      { outcome: "non-installable", cause: "empty-result" },
      elapsedMs,
      hostStallMs,
    );
  }

  return recordGhTokenUnavailable(classifyGhTokenFailure(res, hostStallMs), elapsedMs, hostStallMs);
}

function recordGhTokenUnavailable(
  { outcome, cause }: { outcome: AvailabilityOutcome; cause: AvailabilityCause },
  elapsedMs: number,
  hostStallMs: number,
): undefined {
  const retryAfterMs = ghTokenLatch.noteUnavailable(outcome, cause);
  if (outcome === "transient") {
    recordZizmorOfflineDegradation(
      `gh auth token probe ${cause}; running offline until the next zizmor start (retry allowed in ${Math.round(retryAfterMs / 1000)}s)`,
    );
  }
  logAvailabilityDecision({
    tool: "zizmor-gh-token",
    verdict: "unavailable",
    outcome,
    cause,
    elapsedMs,
    latched: outcome !== "transient",
    hostStallMs,
    ...(retryAfterMs > 0 && { retryAfterMs }),
    budgetMs: GH_TOKEN_PROBE_TIMEOUT_MS,
  });
  return undefined;
}

function recordZizmorOfflineDegradation(reason: string): void {
  incrementDegradationCount({
    kind: "mode-suppression",
    subject: "zizmor",
    reason,
  });
}

export async function resolveZizmorGitHubToken(): Promise<string | undefined> {
  if (process.env.ZIZMOR_OFFLINE) return undefined;
  const fromEnv =
    process.env.ZIZMOR_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  const memo = ghTokenLatch.read();
  if (memo !== null) {
    if (memo === false && ghTokenLatch.getOutcome() === "transient") {
      const cause = ghTokenLatch.getCause();
      if (cause === null) {
        throw new Error(
          "zizmor gh-token latch: transient outcome with no cause (invariant violated)",
        );
      }
      const retryAfterMs = Math.max(0, ghTokenLatch.getRetryAtMs() - Date.now());
      recordZizmorOfflineDegradation(
        `gh auth token still cooling down (${cause}); serving cached offline verdict, retry allowed in ${Math.round(retryAfterMs / 1000)}s`,
      );
      logAvailabilityDecision({
        tool: "zizmor-gh-token",
        verdict: "unavailable",
        outcome: "transient",
        cause,
        elapsedMs: 0,
        latched: false,
        hostStallMs: 0,
        ...(retryAfterMs > 0 && { retryAfterMs }),
        budgetMs: GH_TOKEN_PROBE_TIMEOUT_MS,
      });
    }
    return memo ? cachedToken : undefined;
  }
  cachedToken = await deriveGhCliToken();
  return cachedToken;
}
