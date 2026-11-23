/**
 * In-flight ensure tracking, install failure reasons, install-attempt records, and the last ensure resolution source.
 */

export const ensureInFlight = new Map<string, Promise<string | undefined>>();
export const installFailureReasons = new Map<string, string>();

/** Last honest install refusal/failure reason for callers that need diagnostics. */
export function getInstallFailureReason(toolId: string): string | undefined {
  return installFailureReasons.get(toolId);
}

/**
 * What the last install attempt for a tool actually DID (#1500 review).
 *
 * `installFailureReasons` cannot answer this and never could: it is a REFUSAL
 * map, written by the `CHOCO_PI_LSP_DISABLE_TOOL_INSTALL` branches and the install-lock
 * skip, and by nothing on the genuine-failure or success paths. Inferring
 * attempt-ness from it inverts the answer in both directions — a kill-switch
 * decline reads as a failed download, and a failed download reads as a policy
 * decision. So the outcome is recorded explicitly, at each branch that knows it.
 *
 *   * `succeeded`  — an install ran and reported success.
 *   * `failed`     — an install ran and did not succeed. The retry candidate.
 *   * `declined`   — policy said no: kill switch, `allowInstall: false`, project
 *                    trust, an unknown tool id. Nothing ran.
 *   * `skipped`    — another process holds the install lock. Nothing ran.
 */
export type InstallAttemptOutcome = "succeeded" | "failed" | "declined" | "skipped";

export interface InstallAttempt {
  outcome: InstallAttemptOutcome;
  /** Why, when there is something to say. */
  reason?: string;
  /** Epoch ms, so a caller can tell a fresh record from a stale one. */
  at: number;
}

export const installAttempts = new Map<string, InstallAttempt>();

export function noteInstallAttempt(
  toolId: string,
  outcome: InstallAttemptOutcome,
  reason?: string,
): void {
  installAttempts.set(toolId, { outcome, reason, at: Date.now() });
}

/** Record an outcome only if this attempt has not already recorded its own. */
export function noteInstallAttemptIfUnrecorded(
  toolId: string,
  outcome: InstallAttemptOutcome,
  reason?: string,
): void {
  if (installAttempts.has(toolId)) return;
  noteInstallAttempt(toolId, outcome, reason);
}

/**
 * What the last install attempt for `toolId` did, or `undefined` when no attempt
 * has been recorded in this session. Consumers map this onto the
 * `availability_decision` record's install evidence (#1500).
 */
export function getInstallAttempt(toolId: string): InstallAttempt | undefined {
  return installAttempts.get(toolId);
}

/**
 * How the last `ensureTool` call for `toolId` resolved a path WITHOUT
 * recording an install attempt (#1636 review). `getInstallAttempt` answers
 * "undefined" for three different situations that a compensating-row consumer
 * must not collapse into one label:
 *
 *   * `"session-cache"` — the in-memory `resolvedPathCache` already held a
 *     verified path (fast path 1).
 *   * `"probe-cache"`   — the persistent on-disk probe cache answered without
 *     a fresh spawn (fast path 2).
 *   * `"path"`          — `getToolPath` found the binary this call, on PATH,
 *     a package manager's global bin dir, or the managed tools dir — a plain
 *     discovery, not a cache hit.
 *
 * Reset alongside `installAttempts` at the top of every `ensureToolResolved`
 * call so a stale source never survives past the attempt it described.
 */
export type EnsureResolutionSource = "session-cache" | "probe-cache" | "path";

export const lastEnsureResolutionSource = new Map<string, EnsureResolutionSource>();

export function getLastEnsureResolutionSource(toolId: string): EnsureResolutionSource | undefined {
  return lastEnsureResolutionSource.get(toolId);
}
