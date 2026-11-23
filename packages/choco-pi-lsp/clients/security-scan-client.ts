import * as path from "node:path";
import { createSubsystemLogger } from "./extension-log.ts";
import { safeSpawnAsync } from "./safe-spawn.ts";
import {
  type AvailabilityCause,
  type AvailabilityOutcome,
  type ProbeEvidence,
  classifyProbeFailure,
  createAvailabilityLatch,
  describeInstallAttempt,
  describeProbeEvidence,
  logAvailabilityDecision,
  startHostStallSampler,
} from "./dispatch/runners/utils/availability-policy.ts";
import { dedupeInFlight } from "./in-flight-dedup.ts";

type GetAvailabilityVerdictResultContract = {
  outcome: AvailabilityOutcome | null;
  cause: AvailabilityCause | null;
  retryAtMs: number;
};

export abstract class SecurityScanClient<TResult> {
  private readonly availabilityLatch = createAvailabilityLatch();

  protected get available(): boolean | null {
    return this.availabilityLatch.read();
  }
  protected set available(value: boolean | null) {
    if (value === true) {
      this.availabilityLatch.noteAvailable();
      return;
    }
    if (value !== false) {
      this.availabilityLatch.reset();
      return;
    }
    this.availabilityLatch.noteUnavailable("missing", "not-found");
    this.logDurableAbsence();
  }

  protected noteDurableAbsence(
    evidence: ProbeEvidence,
    options: { elapsedMs?: number } = {},
  ): void {
    this.availabilityLatch.noteUnavailable("missing", "not-found");
    this.logDurableAbsence(evidence, options.elapsedMs);
  }

  private logDurableAbsence(evidence?: ProbeEvidence, elapsedMs = 0): void {
    logAvailabilityDecision({
      tool: this.toolName,
      verdict: "unavailable",
      outcome: "missing",
      cause: "not-found",
      elapsedMs,
      latched: true,
      classifiedBy: "caller",
      ...(evidence !== undefined && { evidence }),
    });
  }

  protected lastProbeOutcome: AvailabilityOutcome | null = null;

  private ensureInFlight: Promise<boolean> | null = null;
  protected readonly inFlight = new Map<string, Promise<TResult>>();
  protected binaryPath: string | null = null;
  protected readonly log: (msg: string) => void;
  protected readonly toolName: string;

  protected constructor(toolName: string, verbose = false) {
    this.toolName = toolName;
    this.log = verbose ? createSubsystemLogger(toolName) : () => {};
  }

  async ensureAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    if (this.ensureInFlight) return this.ensureInFlight;
    this.ensureInFlight = this.doEnsureAvailable();
    try {
      return await this.ensureInFlight;
    } finally {
      this.ensureInFlight = null;
    }
  }

  protected abstract doEnsureAvailable(): Promise<boolean>;

  protected async probeVersion(versionArgs: string[]): Promise<boolean> {
    const sampler = startHostStallSampler();
    const startedAt = Date.now();
    let probe: Awaited<ReturnType<typeof safeSpawnAsync>>;
    let hostStallMs: number;
    try {
      probe = await safeSpawnAsync(this.toolName, versionArgs, {
        timeout: 5000,
      });
    } finally {
      hostStallMs = sampler.stop();
    }
    const elapsedMs = Date.now() - startedAt;
    if (!probe.error && probe.status === 0) {
      this.lastProbeOutcome = "success";
      this.log(`${this.toolName} found: ${probe.stdout.trim().split("\n")[0]}`);
      logAvailabilityDecision({
        tool: this.toolName,
        verdict: "available",
        outcome: "success",
        cause: "ok",
        elapsedMs,
        latched: true,
        hostStallMs,
        budgetMs: 5000,
        classifiedBy: "probe",
        evidence: describeProbeEvidence(probe),
      });
      return true;
    }
    const { outcome, cause, evidence } = classifyProbeFailure(probe, {
      hostStallMs,
    });
    this.lastProbeOutcome = outcome;
    const retryAfterMs =
      outcome === "transient" ? this.availabilityLatch.noteUnavailable("transient", cause) : 0;
    logAvailabilityDecision({
      tool: this.toolName,
      verdict: "unavailable",
      outcome,
      cause,
      elapsedMs,
      latched: outcome !== "transient",
      hostStallMs,
      ...(retryAfterMs > 0 && { retryAfterMs }),
      budgetMs: 5000,
      classifiedBy: "probe",
      evidence,
    });
    return false;
  }

  protected probeWasTransient(): boolean {
    return this.lastProbeOutcome === "transient";
  }

  protected markTransientlyUnavailable(
    cause: AvailabilityCause = "probe-timeout",
    opts?: { operationClass?: "probe" | "install" },
  ): number {
    return this.availabilityLatch.noteUnavailable("transient", cause, opts);
  }

  protected latchedCause(): AvailabilityCause | null {
    return this.availabilityLatch.getCause();
  }

  getAvailabilityVerdict(): GetAvailabilityVerdictResultContract {
    return {
      outcome: this.availabilityLatch.getOutcome(),
      cause: this.availabilityLatch.getCause(),
      retryAtMs: this.availabilityLatch.getRetryAtMs(),
    };
  }

  protected async ensureViaInstaller(versionArgs: string[]): Promise<boolean> {
    if (await this.probeVersion(versionArgs)) {
      this.available = true;
      return true;
    }
    if (this.probeWasTransient()) {
      this.log(`${this.toolName} availability probe timed out; not installing, will retry`);
      return false;
    }
    this.log(`${this.toolName} not found, attempting auto-install`);
    const { ensureTool, getInstallAttempt } = await import("./installer/index.ts");
    const installStartedAt = Date.now();
    const installed = await ensureTool(this.toolName);
    if (!installed) {
      const attempt = getInstallAttempt(this.toolName);
      this.log(
        attempt?.outcome === "failed"
          ? `${this.toolName} auto-install failed: ${attempt.reason ?? "unknown reason"}`
          : `${this.toolName} auto-install did not run: ${attempt?.reason ?? "no attempt recorded"}`,
      );
      this.noteDurableAbsence(describeInstallAttempt(attempt), {
        elapsedMs: Date.now() - installStartedAt,
      });
      return false;
    }
    this.binaryPath = installed;
    this.available = true;
    this.log(`${this.toolName} auto-installed at ${installed}`);
    logAvailabilityDecision({
      tool: this.toolName,
      verdict: "available",
      outcome: "success",
      cause: "ok",
      elapsedMs: Date.now() - installStartedAt,
      latched: true,
      classifiedBy: "caller",
      evidence: {
        install: "succeeded",
        binary: path.basename(installed),
        source: "managed-dir",
      },
    });
    return true;
  }

  protected dedupeScan(key: string, run: () => Promise<TResult>): Promise<TResult> {
    return dedupeInFlight(this.inFlight, key, run, () =>
      this.log(`Scan already in flight for ${key}; sharing result`),
    );
  }
}
