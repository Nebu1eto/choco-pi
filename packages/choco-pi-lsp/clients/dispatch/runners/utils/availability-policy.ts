import { obj, opt, str, compile } from "@earendil-works/pi-schema";
import { logLatency } from "../../../latency-logger.ts";

export type AvailabilityOutcome = "success" | "missing" | "transient" | "non-installable";

export type AvailabilityCause =
  | "ok"
  | "fast-path"
  | "not-found"
  | "probe-timeout"
  | "host-stall"
  | "probe-rejected"
  | "bad-cwd"
  | "policy-denied"
  | "empty-result"
  | "install-retry-exhausted";

export interface ProbeEvidence {
  command?: string;
  status?: number | null;
  failure?: string;
  spawnFailureKind?: string;
  errno?: string;
  install?: "succeeded" | "failed" | "not-attempted";
  installReason?: string;
  binary?: string;
  source?:
    | "managed-dir"
    | "go-install"
    | "pip-user"
    | "github-release"
    | "archive-dist"
    | "maven-jar";
  resolved?: "cache" | "path" | "declined";
  correctsLatchedRow?: boolean;
}

export function describeProbeEvidence(result: ProbeFailureResult, command?: string): ProbeEvidence {
  const errno = isErrno(result.error) ? result.error.code : undefined;
  return {
    ...(command !== undefined && { command }),
    ...(result.status !== undefined && { status: result.status }),
    ...(result.failure !== undefined && { failure: result.failure }),
    ...(result.spawnFailure?.kind !== undefined && {
      spawnFailureKind: result.spawnFailure.kind,
    }),
    ...(errno !== undefined && { errno }),
  };
}

export interface InstallAttemptFact {
  outcome: "succeeded" | "failed" | "declined" | "skipped";
  reason?: string;
}

export function describeInstallAttempt(
  attempt: InstallAttemptFact | undefined,
  options: { installedButRejected?: boolean } = {},
): ProbeEvidence {
  const reason = attempt?.reason?.slice(0, 200);
  if (options.installedButRejected) {
    return {
      install: "succeeded",
      installReason: reason ?? "installed binary failed validation",
    };
  }
  if (attempt === undefined) return { install: "not-attempted" };
  switch (attempt.outcome) {
    case "succeeded":
      return { install: "succeeded", ...(reason && { installReason: reason }) };
    case "failed":
      return { install: "failed", ...(reason && { installReason: reason }) };
    default:
      return {
        install: "not-attempted",
        ...(reason && { installReason: reason }),
      };
  }
}

export interface AvailabilityDecision {
  tool: string;
  verdict: "available" | "unavailable";
  outcome: AvailabilityOutcome;
  cause: AvailabilityCause;
  classifiedBy?: "probe" | "caller";
  evidence?: ProbeEvidence;
  elapsedMs: number;
  latched: boolean;
  hostStallMs?: number;
  retryAfterMs?: number;
  budgetMs?: number;
  provisional?: boolean;
  unreachablePreferred?: readonly string[];
  retained?: boolean;
  servedFromCooldown?: boolean;
}

export const TRANSIENT_BASE_COOLDOWN_MS = 30_000;
export const TRANSIENT_MAX_COOLDOWN_MS = 300_000;

export const HOST_STALL_COOLDOWN_MS = 5_000;

export const HOST_STALL_EVIDENCE_MS = 500;

export function isLatchingOutcome(outcome: AvailabilityOutcome): boolean {
  return outcome !== "transient";
}

export function transientRetryDelayMs(
  attempts: number,
  cause: AvailabilityCause,
  maxCooldownMs: number = TRANSIENT_MAX_COOLDOWN_MS,
): number {
  if (cause === "host-stall") return HOST_STALL_COOLDOWN_MS;
  const exponent = Math.max(0, attempts - 1);
  return Math.min(maxCooldownMs, TRANSIENT_BASE_COOLDOWN_MS * 2 ** Math.min(exponent, 10));
}

export const INSTALL_TRANSIENT_BASE_COOLDOWN_MS = 300_000;

export const INSTALL_TRANSIENT_COOLDOWNS_MS: readonly number[] = [
  INSTALL_TRANSIENT_BASE_COOLDOWN_MS,
  INSTALL_TRANSIENT_BASE_COOLDOWN_MS * 2,
];

export const INSTALL_TRANSIENT_MAX_ATTEMPTS = INSTALL_TRANSIENT_COOLDOWNS_MS.length + 1;

export function installRetryDelayMs(attempts: number): number {
  return INSTALL_TRANSIENT_COOLDOWNS_MS[Math.max(0, attempts - 1)] ?? 0;
}

let installRetryGeneration = 0;

export function resetInstallRetryLatches(): void {
  installRetryGeneration += 1;
}

const ErrnoSchema = obj({ code: opt(str()) }, { open: true });
const isErrno = compile(ErrnoSchema).check;

export interface ProbeFailureResult {
  error?: Error | null;
  status?: number | null;
  failure?: string;
  spawnFailure?: { kind?: string };
}

export interface ProbeFailureClassification {
  outcome: AvailabilityOutcome;
  cause: AvailabilityCause;
  evidence: ProbeEvidence;
}

export interface ClassifyOptions {
  hostStallMs?: number;
  command?: string;
  unclassifiedFailureOutcome?: AvailabilityOutcome;
}

export function classifyProbeFailure(
  result: ProbeFailureResult,
  options: ClassifyOptions = {},
): ProbeFailureClassification {
  const evidence = describeProbeEvidence(result, options.command);
  const errorCode = isErrno(result.error) ? result.error.code : undefined;
  if (result.spawnFailure?.kind === "tool-not-found") {
    return { outcome: "missing", cause: "not-found", evidence };
  }
  if (
    result.failure === "timeout" ||
    result.failure === "aborted" ||
    result.failure === "signal" ||
    result.spawnFailure?.kind === "killed" ||
    result.spawnFailure?.kind === "timeout" ||
    errorCode === "EAGAIN" ||
    errorCode === "EBUSY"
  ) {
    const stalled = (options.hostStallMs ?? 0) >= HOST_STALL_EVIDENCE_MS;
    return {
      outcome: "transient",
      cause: stalled ? "host-stall" : "probe-timeout",
      evidence,
    };
  }
  const outcome = options.unclassifiedFailureOutcome ?? "non-installable";
  return {
    outcome,
    cause: outcome === "missing" ? "not-found" : "probe-rejected",
    evidence,
  };
}

export interface HostStallSampler {
  stop: () => number;
}

export function startHostStallSampler(intervalMs = 100): HostStallSampler {
  let stallMs = 0;
  let last = Date.now();
  let stopped = false;
  const timer: NodeJS.Timeout | undefined = setInterval(() => {
    const now = Date.now();
    const lateness = now - last - intervalMs;
    if (lateness > 0) stallMs += lateness;
    last = now;
  }, intervalMs);
  timer?.unref?.();
  return {
    stop: (): number => {
      if (stopped) return Math.round(stallMs);
      stopped = true;
      clearInterval(timer);
      const tail = Date.now() - last - intervalMs;
      if (tail > 0) stallMs += tail;
      return Math.round(stallMs);
    },
  };
}

export interface AvailabilityLatch {
  read(): boolean | null;
  noteAvailable(cause?: AvailabilityCause): void;
  noteProvisionallyAvailable(transientCause: AvailabilityCause): number;
  isProvisional(): boolean;
  noteUnavailable(
    outcome: AvailabilityOutcome,
    cause: AvailabilityCause,
    opts?: { operationClass?: "probe" | "install" },
  ): number;
  reset(): void;
  getOutcome(): AvailabilityOutcome | null;
  getCause(): AvailabilityCause | null;
  getRetryAtMs(): number;
  isInstallExhausted(): boolean;
}

export interface AvailabilityLatchOptions {
  maxCooldownMs?: number;
}

export function createAvailabilityLatch(options: AvailabilityLatchOptions = {}): AvailabilityLatch {
  let available: boolean | null = null;
  let outcome: AvailabilityOutcome | null = null;
  let cause: AvailabilityCause | null = null;
  let retryAtMs = 0;
  let transientAttempts = 0;
  let installAttempts = 0;
  let installExhausted = false;
  let installRetryAtMs = 0;
  let provisional = false;
  const maxCooldownMs = options.maxCooldownMs ?? TRANSIENT_MAX_COOLDOWN_MS;
  let installGeneration = installRetryGeneration;

  function clearVerdict(): void {
    available = null;
    outcome = null;
    cause = null;
    retryAtMs = 0;
    transientAttempts = 0;
    installAttempts = 0;
    installExhausted = false;
    installRetryAtMs = 0;
    provisional = false;
  }

  function syncInstallGeneration(): void {
    if (installGeneration === installRetryGeneration) return;
    installGeneration = installRetryGeneration;
    if (installExhausted) {
      clearVerdict();
      return;
    }
    installAttempts = 0;
    installRetryAtMs = 0;
  }

  function effectiveRetryAtMs(): number {
    return Math.max(retryAtMs, installRetryAtMs);
  }

  return {
    read(): boolean | null {
      syncInstallGeneration();
      if (available === true) {
        if (provisional && Date.now() >= effectiveRetryAtMs()) return null;
        return true;
      }
      if (available !== false) return available;
      if (installExhausted) return false;
      if (outcome !== "transient") return false;
      return Date.now() >= effectiveRetryAtMs() ? null : false;
    },
    noteAvailable(nextCause: AvailabilityCause = "ok"): void {
      installGeneration = installRetryGeneration;
      available = true;
      outcome = "success";
      cause = nextCause;
      retryAtMs = 0;
      transientAttempts = 0;
      installAttempts = 0;
      installExhausted = false;
      installRetryAtMs = 0;
      provisional = false;
    },
    noteProvisionallyAvailable(transientCause: AvailabilityCause): number {
      syncInstallGeneration();
      available = true;
      outcome = "success";
      cause = transientCause;
      provisional = true;
      installAttempts = 0;
      installExhausted = false;
      installRetryAtMs = 0;
      transientAttempts += 1;
      const delay = transientRetryDelayMs(transientAttempts, transientCause, maxCooldownMs);
      retryAtMs = Date.now() + delay;
      return delay;
    },
    noteUnavailable(
      nextOutcome: AvailabilityOutcome,
      nextCause: AvailabilityCause,
      opts?: { operationClass?: "probe" | "install" },
    ): number {
      syncInstallGeneration();
      available = false;
      outcome = nextOutcome;
      cause = nextCause;
      provisional = false;
      if (isLatchingOutcome(nextOutcome)) {
        retryAtMs = 0;
        installRetryAtMs = 0;
        return 0;
      }
      if (opts?.operationClass === "install") {
        installAttempts += 1;
        const installDelay = installRetryDelayMs(installAttempts);
        if (installDelay === 0) {
          installExhausted = true;
          cause = "install-retry-exhausted";
          retryAtMs = 0;
          installRetryAtMs = 0;
          return 0;
        }
        installRetryAtMs = Date.now() + installDelay;
        return installDelay;
      }
      transientAttempts += 1;
      const delay = transientRetryDelayMs(transientAttempts, nextCause, maxCooldownMs);
      retryAtMs = Date.now() + delay;
      return delay;
    },
    reset(): void {
      installGeneration = installRetryGeneration;
      clearVerdict();
    },
    getOutcome: () => outcome,
    getCause: () => cause,
    getRetryAtMs: () => effectiveRetryAtMs(),
    isProvisional: () => provisional,
    isInstallExhausted: () => {
      syncInstallGeneration();
      return installExhausted;
    },
  };
}

export function isTransientDecision(
  decision: { outcome?: AvailabilityOutcome | null } | null | undefined,
): boolean {
  return decision?.outcome === "transient";
}

export function describeUnavailability(options: {
  tool: string;
  installHint: string;
  outcome?: AvailabilityOutcome | null;
  cause?: AvailabilityCause | null;
  elapsedMs?: number;
  retryAfterMs?: number;
}): string {
  const { tool, installHint } = options;
  if (options.outcome !== "transient") {
    return `${tool} not available. Install with: ${installHint}`;
  }
  if (options.cause === "install-retry-exhausted") {
    return `${tool} install kept timing out and reached its retry ceiling (${INSTALL_TRANSIENT_MAX_ATTEMPTS} attempts). ${tool} is not reported missing — the install is not being retried again this session, and recovers at the next session. To install it now: ${installHint}`;
  }
  const elapsed = options.elapsedMs ? ` after ${options.elapsedMs}ms` : "";
  const stalled =
    options.cause === "host-stall"
      ? " (the pi host event loop stalled during the probe window, so the budget expired on the host side)"
      : "";
  const retry = options.retryAfterMs
    ? ` Retrying in ${Math.round(options.retryAfterMs / 1000)}s.`
    : " It will be retried.";
  return `${tool} availability probe timed out${elapsed}${stalled}. ${tool} is not reported missing — this is a probe timeout, not a missing install.${retry}`;
}

export function logAvailabilityDecision(
  decision: AvailabilityDecision,
  filePath = "<choco-pi-lsp>",
): void {
  logLatency({
    type: "phase",
    phase: "availability_decision",
    filePath,
    durationMs: Math.round(decision.elapsedMs),
    metadata: {
      tool: decision.tool,
      verdict: decision.verdict,
      outcome: decision.outcome,
      cause: decision.cause,
      latched: decision.latched,
      ...(decision.classifiedBy !== undefined && {
        classifiedBy: decision.classifiedBy,
      }),
      ...(decision.evidence !== undefined && { evidence: decision.evidence }),
      ...(decision.hostStallMs !== undefined && {
        hostStallMs: decision.hostStallMs,
      }),
      ...(decision.retryAfterMs !== undefined && {
        retryAfterMs: decision.retryAfterMs,
      }),
      ...(decision.budgetMs !== undefined && { budgetMs: decision.budgetMs }),
      ...(decision.provisional === true && { provisional: true }),
      ...(decision.unreachablePreferred !== undefined && {
        unreachablePreferred: decision.unreachablePreferred,
      }),
      ...(decision.retained === true && { retained: true }),
      ...(decision.servedFromCooldown === true && { servedFromCooldown: true }),
    },
  });
}
