import {
  type AvailabilityCause,
  type ProbeEvidence,
  createAvailabilityLatch,
  logAvailabilityDecision,
} from "./availability-policy.ts";
import { probeAvailabilityCandidates } from "./candidate-probe.ts";

export interface ToolchainAvailabilityConfig {
  tool: string;
  label: string;
  windowsPaths: readonly string[];
  unixPaths: readonly string[];
  probeArgs: readonly string[];
  budgetMs: number;
  log: (msg: string) => void;
}

export interface ToolchainAvailability {
  findPath: () => Promise<string | null>;
  isAvailable: () => Promise<boolean>;
}

export function createToolchainAvailability(
  config: ToolchainAvailabilityConfig,
): ToolchainAvailability {
  const availabilityLatch = createAvailabilityLatch();
  let toolPath: string | null = null;
  let sweepSawTransient = false;
  let sweepTransientCause: AvailabilityCause = "probe-timeout";
  let sweepHostStallMs = 0;
  let sweepEvidence: ProbeEvidence | undefined;
  let ensureInFlight: Promise<boolean> | null = null;

  async function findPath(): Promise<string | null> {
    if (toolPath) return toolPath;

    const paths = process.platform === "win32" ? config.windowsPaths : config.unixPaths;
    const sweep = await probeAvailabilityCandidates(paths, config.probeArgs, config.budgetMs);
    sweepSawTransient = sweep.sawTransient;
    sweepTransientCause = sweep.transientCause;
    sweepHostStallMs = sweep.hostStallMs;
    sweepEvidence = sweep.evidence;
    if (sweep.foundPath) toolPath = sweep.foundPath;
    return sweep.foundPath;
  }

  async function resolveAvailability(): Promise<boolean> {
    const startedAt = Date.now();
    const found = (await findPath()) !== null;
    if (found) {
      availabilityLatch.noteAvailable();
      config.log(`${config.label} found: ${toolPath}`);
      logAvailabilityDecision({
        tool: config.tool,
        verdict: "available",
        outcome: "success",
        cause: "ok",
        elapsedMs: Date.now() - startedAt,
        latched: true,
        hostStallMs: sweepHostStallMs,
        budgetMs: config.budgetMs,
        classifiedBy: "probe",
        ...(sweepEvidence !== undefined && { evidence: sweepEvidence }),
      });
      return true;
    }
    const outcome = sweepSawTransient ? "transient" : "missing";
    const cause = sweepSawTransient ? sweepTransientCause : "not-found";
    const retryAfterMs = availabilityLatch.noteUnavailable(outcome, cause);
    logAvailabilityDecision({
      tool: config.tool,
      verdict: "unavailable",
      outcome,
      cause,
      elapsedMs: Date.now() - startedAt,
      latched: outcome !== "transient",
      hostStallMs: sweepHostStallMs,
      ...(retryAfterMs > 0 && { retryAfterMs }),
      budgetMs: config.budgetMs,
      classifiedBy: "probe",
      ...(sweepEvidence !== undefined && { evidence: sweepEvidence }),
    });
    return false;
  }

  async function isAvailable(): Promise<boolean> {
    const memo = availabilityLatch.read();
    if (memo !== null) return memo;
    if (ensureInFlight) return ensureInFlight;
    ensureInFlight = resolveAvailability();
    try {
      return await ensureInFlight;
    } finally {
      ensureInFlight = null;
    }
  }

  return { findPath, isAvailable };
}
