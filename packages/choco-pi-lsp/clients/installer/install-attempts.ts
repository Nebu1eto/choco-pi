export const ensureInFlight = new Map<string, Promise<string | undefined>>();
export const installFailureReasons = new Map<string, string>();

export function getInstallFailureReason(toolId: string): string | undefined {
  return installFailureReasons.get(toolId);
}

export type InstallAttemptOutcome = "succeeded" | "failed" | "declined" | "skipped";

export interface InstallAttempt {
  outcome: InstallAttemptOutcome;
  reason?: string;
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

export function noteInstallAttemptIfUnrecorded(
  toolId: string,
  outcome: InstallAttemptOutcome,
  reason?: string,
): void {
  if (installAttempts.has(toolId)) return;
  noteInstallAttempt(toolId, outcome, reason);
}

export function getInstallAttempt(toolId: string): InstallAttempt | undefined {
  return installAttempts.get(toolId);
}

export type EnsureResolutionSource = "session-cache" | "probe-cache" | "path";

export const lastEnsureResolutionSource = new Map<string, EnsureResolutionSource>();

export function getLastEnsureResolutionSource(toolId: string): EnsureResolutionSource | undefined {
  return lastEnsureResolutionSource.get(toolId);
}
