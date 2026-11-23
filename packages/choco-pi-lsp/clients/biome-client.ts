import { createSubsystemLogger } from "./extension-log.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { isFileKind } from "./file-kinds.ts";
import { getGlobalPiLensDir } from "./file-utils.ts";
import { findGlobalBinary } from "./package-manager.ts";
import { safeSpawnAsync } from "./safe-spawn.ts";
import { createSingleFlight } from "./single-flight.ts";
import { biomeConfigArgs } from "./tool-policy.ts";
import {
  type ClientAvailabilityResult,
  resolveManagedToolClient,
} from "./dispatch/runners/utils/runner-helpers.ts";
import {
  type AvailabilityCause,
  type AvailabilityOutcome,
  type ProbeEvidence,
  classifyProbeFailure,
  describeInstallAttempt,
  createAvailabilityLatch,
  logAvailabilityDecision,
  startHostStallSampler,
} from "./dispatch/runners/utils/availability-policy.ts";

export interface BiomeDiagnostic {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  rule?: string;
  category: "lint" | "format";
  fixable: boolean;
}

const PROBE_TIMEOUT_MS = 10_000;

export class BiomeClient {
  private readonly availabilityLatch = createAvailabilityLatch();
  private lastProbeCause: AvailabilityCause | null = null;
  private lastProbeElapsedMs = 0;
  private lastProbeHostStallMs = 0;
  private lastProbeEvidence: ProbeEvidence | undefined;
  private localBinaryByCwd = new Map<string, string>();
  private autoInstalledBinaryPath: string | null = null;
  private readonly ensureFlight = createSingleFlight<boolean>();
  private log: (msg: string) => void;

  constructor(verbose = false) {
    this.log = verbose ? createSubsystemLogger("biome") : () => {};
  }

  private async getBiomeBinary(cwd?: string): Promise<{ cmd: string; args: string[] }> {
    const resolveCwd = cwd ?? process.cwd();
    const cached = this.localBinaryByCwd.get(resolveCwd);
    if (cached) return { cmd: cached, args: [] };

    const isWin = process.platform === "win32";
    const piLensBin = path.join(getGlobalPiLensDir(), "tools", "node_modules", ".bin");
    const candidates = isWin
      ? [
          path.join(resolveCwd, "node_modules", ".bin", "biome.cmd"),
          path.join(resolveCwd, "node_modules", ".bin", "biome"),
        ]
      : [path.join(resolveCwd, "node_modules", ".bin", "biome")];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        this.localBinaryByCwd.set(resolveCwd, p);
        return { cmd: p, args: [] };
      }
    }
    if (this.autoInstalledBinaryPath) {
      return { cmd: this.autoInstalledBinaryPath, args: [] };
    }
    const managedCandidates = isWin
      ? [path.join(piLensBin, "biome.cmd"), path.join(piLensBin, "biome")]
      : [path.join(piLensBin, "biome")];
    for (const p of managedCandidates) {
      if (fs.existsSync(p)) {
        this.localBinaryByCwd.set(resolveCwd, p);
        return { cmd: p, args: [] };
      }
    }
    const global = await findGlobalBinary("biome");
    if (global) {
      this.localBinaryByCwd.set(resolveCwd, global);
      return { cmd: global, args: [] };
    }
    return { cmd: "npx", args: ["@biomejs/biome"] };
  }

  private async spawnBiomeAsync(args: string[], timeout = 15000, cwd?: string) {
    const { cmd, args: prefix } = await this.getBiomeBinary(cwd);
    return safeSpawnAsync(cmd, [...prefix, ...args], { timeout, cwd });
  }

  async ensureAvailable(): Promise<boolean> {
    const memo = this.availabilityLatch.read();
    if (memo !== null) return memo;
    return this.ensureFlight.run("biome", () => this.doEnsureAvailable());
  }

  private async probeBiome(): Promise<ClientAvailabilityResult<true>> {
    const sampler = startHostStallSampler();
    const startedAt = Date.now();
    let result: Awaited<ReturnType<typeof this.spawnBiomeAsync>>;
    let hostStallMs: number;
    try {
      result = await this.spawnBiomeAsync(["--version"], PROBE_TIMEOUT_MS);
    } finally {
      hostStallMs = sampler.stop();
    }
    const elapsedMs = Date.now() - startedAt;

    if (!result.error && result.status === 0) {
      this.lastProbeCause = "ok";
      logAvailabilityDecision({
        tool: "biome",
        verdict: "available",
        outcome: "success",
        cause: "ok",
        elapsedMs,
        latched: true,
        hostStallMs,
        budgetMs: PROBE_TIMEOUT_MS,
      });
      return { outcome: "success", value: true };
    }

    const { outcome, cause, evidence } = classifyProbeFailure(result, {
      hostStallMs,
      unclassifiedFailureOutcome: "missing",
    });
    const failureOutcome: Exclude<AvailabilityOutcome, "success"> =
      outcome === "success" ? "non-installable" : outcome;
    this.lastProbeCause = cause;
    this.lastProbeElapsedMs = elapsedMs;
    this.lastProbeHostStallMs = hostStallMs;
    this.lastProbeEvidence = evidence;
    return { outcome: failureOutcome };
  }

  private async doEnsureAvailable(): Promise<boolean> {
    const resolved = await resolveManagedToolClient({
      toolId: "biome",
      cwd: process.cwd(),
      probe: () => this.probeBiome(),
      acceptInstalled: (installedPath) => {
        this.autoInstalledBinaryPath = installedPath;
        return true;
      },
    });
    if (resolved.outcome === "success") {
      this.availabilityLatch.noteAvailable();
      if (this.lastProbeCause !== null && this.lastProbeCause !== "ok") {
        logAvailabilityDecision({
          tool: "biome",
          verdict: "available",
          outcome: "success",
          cause: "ok",
          elapsedMs: this.lastProbeElapsedMs,
          latched: true,
          hostStallMs: this.lastProbeHostStallMs,
          budgetMs: PROBE_TIMEOUT_MS,
        });
      }
      return true;
    }
    const cause = this.lastProbeCause ?? "not-found";
    const retryAfterMs = this.availabilityLatch.noteUnavailable(resolved.outcome, cause);
    let installEvidence: ProbeEvidence | undefined;
    if (resolved.outcome === "missing") {
      const { getInstallAttempt } = await import("./installer/index.ts");
      installEvidence = describeInstallAttempt(getInstallAttempt("biome"));
    }
    const evidence = { ...this.lastProbeEvidence, ...installEvidence };
    logAvailabilityDecision({
      tool: "biome",
      verdict: "unavailable",
      outcome: resolved.outcome,
      cause,
      elapsedMs: this.lastProbeElapsedMs,
      latched: resolved.outcome !== "transient",
      hostStallMs: this.lastProbeHostStallMs,
      ...(retryAfterMs > 0 && { retryAfterMs }),
      budgetMs: PROBE_TIMEOUT_MS,
      classifiedBy:
        this.lastProbeCause === null || resolved.outcome === "non-installable" ? "caller" : "probe",
      ...(Object.keys(evidence).length > 0 && { evidence }),
    });
    if (resolved.outcome === "transient") {
      this.log("biome availability probe timed out; will retry (not installing)");
    }
    return false;
  }

  isSupportedFile(filePath: string): boolean {
    return isFileKind(filePath, ["jsts", "json", "css"]);
  }

  async fixFileAsync(
    filePath: string,
    cwd?: string,
  ): Promise<{
    success: boolean;
    changed: boolean;
    fixed: number;
    error?: string;
  }> {
    if (!(await this.ensureAvailable())) {
      return {
        success: false,
        changed: false,
        fixed: 0,
        error: "Biome not available",
      };
    }

    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) {
      return {
        success: false,
        changed: false,
        fixed: 0,
        error: "File not found",
      };
    }

    try {
      const before = await fs.promises.readFile(absolutePath, "utf-8");
      const configCwd = cwd ?? path.dirname(absolutePath);
      const result = await this.spawnBiomeAsync(
        ["lint", "--write", ...biomeConfigArgs(configCwd), absolutePath],
        15000,
        configCwd,
      );

      if (result.error) {
        return {
          success: false,
          changed: false,
          fixed: 0,
          error: result.error.message,
        };
      }

      const after = await fs.promises.readFile(absolutePath, "utf-8");
      const changed = before !== after;

      if (changed) {
        this.log(`Fixed issue(s) in ${path.basename(filePath)}`);
      }

      return { success: true, changed, fixed: changed ? 1 : 0 };
    } catch (err) {
      return {
        success: false,
        changed: false,
        fixed: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
