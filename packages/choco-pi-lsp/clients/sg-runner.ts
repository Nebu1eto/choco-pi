import { assignOptionalProperties } from "./optional-properties.ts";
import { finite } from "./runtime-guards.ts";
import { arr, compile, obj, str } from "@earendil-works/pi-schema";
import { createSubsystemLogger } from "./extension-log.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectIgnoreGlobs } from "./file-utils.ts";
import { findGlobalBinary } from "./package-manager.ts";
import { safeSpawnAsync, type SpawnResult } from "./safe-spawn.ts";
import { createSingleFlight } from "./single-flight.ts";
import {
  type AvailabilityCause,
  type ProbeEvidence,
  classifyProbeFailure,
  describeInstallAttempt,
  createAvailabilityLatch,
  logAvailabilityDecision,
  startHostStallSampler,
} from "./dispatch/runners/utils/availability-policy.ts";

type GetSgCommandResultContract = { cmd: string; argsPrefix: string[] };
type PrepareTempScanResultContract = {
  sessionDir: string;
  configFile: string;
};

export function buildBashRunArgs(cmd: string, allArgs: string[]): string[] {
  return ["-c", '"$0" "$@"', cmd, ...allArgs];
}

function sgExcludeArgsForProject(rootDir: string): string[] {
  return getProjectIgnoreGlobs(rootDir).flatMap((glob) => ["--globs", `!${glob}`]);
}

interface SgMetaVarNode {
  text: string;
  range: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
}

export interface SgMatch {
  file: string;
  range: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  text: string;
  lines?: string;
  language?: string;
  replacement?: string;
  ruleId?: string;
  severity?: string;
  metaVariables?: {
    single: Record<string, SgMetaVarNode>;
    multi: Record<string, SgMetaVarNode[]>;
    transformed: Record<string, string>;
  };
}

const SgPositionSchema = obj({ line: finite(), column: finite() }, { open: true });
const SgMatchSchema = obj(
  {
    file: str(),
    range: obj({ start: SgPositionSchema, end: SgPositionSchema }, { open: true }),
    text: str(),
  },
  { open: true },
);
const isSgMatches = compile(arr(SgMatchSchema)).check;
const isSgMatch = compile(SgMatchSchema).check;

export interface SgResult {
  matches: SgMatch[];
  totalMatches: number;
  truncated: boolean;
  error?: string;
}

export type SgFailureKind = "cli-failure" | "unavailable" | "timeout" | "aborted" | "parse-failure";

export interface SgExecutionOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
}

export interface SgRawResult {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: string;
  failure?: SgFailureKind;
  outputTruncated?: boolean;
}

export interface SgScanResult {
  matches: SgMatch[];
  status: number | null;
  error?: string;
  failure?: SgFailureKind;
}

const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;
const MAX_SG_OUTPUT_BYTES = 8 * 1024 * 1024;

function formatMetaVarCaptures(mv: SgMatch["metaVariables"]): string | undefined {
  if (!mv) return undefined;
  const parts: string[] = [];

  for (const [name, node] of Object.entries(mv.single)) {
    if (node.text) parts.push(`$${name}=${node.text}`);
  }
  for (const [name, nodes] of Object.entries(mv.multi)) {
    if (nodes.length > 0) {
      const joined = nodes.map((n) => n.text).join("");
      if (joined) parts.push(`$$$${name}=${joined}`);
    }
  }
  for (const [name, value] of Object.entries(mv.transformed)) {
    if (value) parts.push(`@${name}=${value}`);
  }

  if (parts.length === 0) return undefined;
  return `  ${parts.join("  ")}`;
}

function tryParseSgMatches(stdout: string): SgMatch[] | null {
  try {
    const parsed = JSON.parse(stdout);
    if (isSgMatches(parsed)) return parsed;

    if (isSgMatch(parsed)) return [parsed];
    return null;
  } catch {
    return null;
  }
}

function tryParseNonZeroSgMatches(
  result: Pick<SpawnResult, "stdout" | "outputTruncated">,
): SgMatch[] | null {
  if (result.outputTruncated || !result.stdout.trim()) return null;
  return tryParseSgMatches(result.stdout.trim());
}

export class SgRunner {
  private log: (msg: string) => void;
  private sgPath: string | null = null;
  private sgArgsPrefix: string[] = [];
  private readonly availabilityLatch = createAvailabilityLatch();
  private readonly ensureFlight = createSingleFlight<boolean>();
  private sweepSawTransient = false;
  private sweepTransientCause: AvailabilityCause = "probe-timeout";
  private sweepUnreachable: string[] = [];
  private sweepFallbackTransient = false;
  private sweepFallbackCause: AvailabilityCause = "probe-timeout";
  private sweepHostStallMs = 0;
  private sweepDurablyMissing: string[] = [];

  constructor(verbose = false) {
    this.log = verbose ? createSubsystemLogger("sg-runner") : () => {};
  }

  async ensureAvailable(): Promise<boolean> {
    const memo = this.availabilityLatch.read();
    if (memo !== null) return memo;
    return this.ensureFlight.run("ast-grep", () => this.doEnsureAvailable());
  }

  private async doEnsureAvailable(): Promise<boolean> {
    const startedAt = Date.now();
    this.sweepSawTransient = false;
    this.sweepTransientCause = "probe-timeout";
    this.sweepUnreachable = [];
    this.sweepFallbackTransient = false;
    this.sweepFallbackCause = "probe-timeout";
    this.sweepHostStallMs = 0;
    this.sweepDurablyMissing = [];

    const pathCommand = await this.probeCommandCandidates([
      { cmd: "ast-grep", argsPrefix: [] },
      { cmd: "sg", argsPrefix: [] },
      { cmd: "npx", argsPrefix: ["--no", "--", "ast-grep"], fallback: true },
    ]);
    if (pathCommand) {
      this.sgPath = pathCommand.cmd;
      this.sgArgsPrefix = pathCommand.argsPrefix;
      this.noteAvailable(startedAt, `ast-grep found on PATH: ${pathCommand.cmd}`);
      return true;
    }

    for (const name of ["ast-grep", "sg"]) {
      const globalBin = await findGlobalBinary(name);
      if (globalBin && (await this.probeCommand(globalBin, []))) {
        this.sgPath = globalBin;
        this.sgArgsPrefix = [];
        this.noteAvailable(startedAt, `ast-grep found in global bin: ${globalBin}`);
        return true;
      }
    }

    const platformBinary = await this.probePlatformPackageBinary();
    if (platformBinary) {
      this.sgPath = platformBinary;
      this.sgArgsPrefix = [];
      this.noteAvailable(startedAt, `ast-grep found via platform package: ${platformBinary}`);
      return true;
    }

    if (process.platform === "darwin") {
      const brewBinary = await this.probeHomebrew();
      if (brewBinary) {
        this.sgPath = brewBinary;
        this.sgArgsPrefix = [];
        this.noteAvailable(startedAt, `ast-grep found via Homebrew: ${brewBinary}`);
        return true;
      }
    }

    if (this.sweepSawTransient) {
      if (
        this.availabilityLatch.isProvisional() &&
        this.sgPath &&
        !this.sweepDurablyMissing.includes(this.sgPath)
      ) {
        this.noteAvailable(startedAt, `ast-grep re-probe stalled; keeping ${this.sgPath}`, {
          retained: true,
        });
        return true;
      }
      this.log("ast-grep availability probe timed out; will retry (not installing)");
      return this.noteUnavailable(startedAt, "transient", this.sweepTransientCause);
    }

    const { resolveManagedToolClient } = await import("./dispatch/runners/utils/runner-helpers.ts");
    const installed = await resolveManagedToolClient({
      toolId: "ast-grep",
      cwd: process.cwd(),
      probe: async () => ({ outcome: "missing" as const }),
      acceptInstalled: async (installedPath) =>
        (await this.probeCommand(installedPath, [])) ? installedPath : null,
    });

    if (installed.outcome === "success") {
      this.sgPath = installed.value;
      this.sgArgsPrefix = [];
      this.noteAvailable(startedAt, `ast-grep auto-installed: ${installed.value}`);
      return true;
    }

    if (this.sweepFallbackTransient) {
      return this.noteUnavailable(startedAt, "transient", this.sweepFallbackCause);
    }
    const { getInstallAttempt } = await import("./installer/index.ts");
    return this.noteUnavailable(
      startedAt,
      "missing",
      "not-found",
      describeInstallAttempt(getInstallAttempt("ast-grep"), {
        installedButRejected: installed.outcome === "non-installable",
      }),
      "caller",
    );
  }

  private noteAvailable(
    startedAt: number,
    message: string,
    opts: { retained?: boolean } = {},
  ): void {
    const provisional = this.sweepSawTransient;
    let retryAfterMs = 0;
    if (provisional) {
      retryAfterMs = this.availabilityLatch.noteProvisionallyAvailable(this.sweepTransientCause);
    } else {
      this.availabilityLatch.noteAvailable();
    }
    this.log(message);
    logAvailabilityDecision({
      tool: "ast-grep",
      verdict: "available",
      outcome: "success",
      cause: provisional ? this.sweepTransientCause : "ok",
      elapsedMs: Date.now() - startedAt,
      latched: !provisional,
      hostStallMs: this.sweepHostStallMs,
      budgetMs: PROBE_TIMEOUT_MS,
      ...(provisional && {
        provisional: true,
        unreachablePreferred: [...this.sweepUnreachable],
        ...(opts.retained === true && { retained: true }),
        ...(retryAfterMs > 0 && { retryAfterMs }),
      }),
    });
  }

  private noteUnavailable(
    startedAt: number,
    outcome: "missing" | "transient",
    cause: AvailabilityCause,
    evidence?: ProbeEvidence,
    classifiedBy: "probe" | "caller" = "probe",
  ): false {
    const retryAfterMs = this.availabilityLatch.noteUnavailable(outcome, cause);
    logAvailabilityDecision({
      tool: "ast-grep",
      verdict: "unavailable",
      outcome,
      cause,
      elapsedMs: Date.now() - startedAt,
      latched: outcome !== "transient",
      hostStallMs: this.sweepHostStallMs,
      ...(retryAfterMs > 0 && { retryAfterMs }),
      budgetMs: PROBE_TIMEOUT_MS,
      classifiedBy,
      ...(evidence !== undefined && { evidence }),
    });
    return false;
  }

  private async probePlatformPackageBinary(): Promise<string | undefined> {
    const { platform, arch } = process;
    const exeName = platform === "win32" ? "sg.exe" : "sg";

    const pkgSuffixes: string[] = [];
    if (platform === "linux" && arch === "x64") pkgSuffixes.push("linux-x64-gnu");
    if (platform === "linux" && arch === "arm64") pkgSuffixes.push("linux-arm64-gnu");
    if (platform === "darwin" && arch === "arm64") pkgSuffixes.push("darwin-arm64");
    if (platform === "darwin" && arch === "x64") pkgSuffixes.push("darwin-x64");
    if (platform === "win32" && arch === "x64") pkgSuffixes.push("win32-x64-msvc");
    if (platform === "win32" && arch === "arm64") pkgSuffixes.push("win32-arm64-msvc");

    const searchRoots: string[] = [];
    let dir = process.cwd();
    for (let depth = 0; depth < 5; depth++) {
      searchRoots.push(path.join(dir, "node_modules"));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    for (const suffix of pkgSuffixes) {
      const pkgName = `@ast-grep/cli-${suffix}`;
      for (const root of searchRoots) {
        const candidate = path.join(root, pkgName, exeName);
        try {
          if (fs.existsSync(candidate) && (await this.probeCommand(candidate, []))) {
            return candidate;
          }
        } catch {}
      }
    }
    return undefined;
  }

  private async probeHomebrew(): Promise<string | undefined> {
    try {
      const result = await safeSpawnAsync("brew", ["--prefix", "ast-grep"], {
        timeout: 3000,
      });
      if (result.error || result.status !== 0) return undefined;
      const prefix = result.stdout.trim();
      if (!prefix) return undefined;
      for (const name of ["ast-grep", "sg"]) {
        const candidate = path.join(prefix, "bin", name);
        if (fs.existsSync(candidate) && (await this.probeCommand(candidate, []))) {
          return candidate;
        }
      }
    } catch {}
    return undefined;
  }

  private isAstGrepVersionOutput(output: string): boolean {
    return /\bast[- ]grep\b/i.test(output);
  }

  private async probeCommand(
    cmd: string,
    argsPrefix: string[],
    fallback = false,
  ): Promise<boolean> {
    const sampler = startHostStallSampler();
    let result: Awaited<ReturnType<typeof safeSpawnAsync>>;
    let hostStallMs: number;
    try {
      result = await safeSpawnAsync(cmd, [...argsPrefix, "--version"], {
        timeout: PROBE_TIMEOUT_MS,
      });
    } finally {
      hostStallMs = sampler.stop();
      this.sweepHostStallMs += hostStallMs;
    }
    if (
      !result.error &&
      result.status === 0 &&
      this.isAstGrepVersionOutput(`${result.stdout}\n${result.stderr}`)
    ) {
      return true;
    }
    const { outcome, cause } = classifyProbeFailure(result, { hostStallMs });
    if (outcome === "transient") {
      if (fallback) {
        this.sweepFallbackTransient = true;
        this.sweepFallbackCause = cause;
      } else {
        this.sweepSawTransient = true;
        this.sweepTransientCause = cause;
        const name = path.basename(cmd);
        if (!this.sweepUnreachable.includes(name)) {
          this.sweepUnreachable.push(name);
        }
      }
    } else if (!this.sweepDurablyMissing.includes(cmd)) {
      this.sweepDurablyMissing.push(cmd);
    }
    return false;
  }

  private async probeCommandCandidates(
    candidates: Array<{ cmd: string; argsPrefix: string[]; fallback?: boolean }>,
  ): Promise<{ cmd: string; argsPrefix: string[] } | undefined> {
    for (const candidate of candidates) {
      if (
        await this.probeCommand(candidate.cmd, candidate.argsPrefix, candidate.fallback ?? false)
      ) {
        return candidate;
      }
    }
    return undefined;
  }

  private getSgCommand(): GetSgCommandResultContract {
    return {
      cmd: this.sgPath || "ast-grep",
      argsPrefix: this.sgArgsPrefix,
    };
  }

  private failureForSpawnResult(result: {
    error?: Error;
    failure?: string;
    spawnFailure?: SpawnResult["spawnFailure"];
  }): SgFailureKind | undefined {
    if (result.failure === "aborted") return "aborted";
    switch (result.spawnFailure?.kind) {
      case "tool-not-found":
        return "unavailable";
      case "timeout":
        return "timeout";
      case "killed":
        return result.failure === "aborted" ? "aborted" : "cli-failure";
      case "cwd-unresolvable":
      case "permission-denied":
      case "spawn-failed":
      case undefined:
        return result.error ? "cli-failure" : undefined;
    }
  }

  private formatPatternError(stderr: string, args: string[]): string {
    if (stderr.includes("Multiple AST nodes are detected")) {
      return (
        `Invalid AST pattern: The pattern appears to contain multiple AST nodes or is malformed.\n` +
        `Common causes:\n` +
        `  1. Missing parentheses: use it($TEST) not it"test"\n` +
        `  2. Raw text without structure: use console.log($MSG) not just "console.log"\n` +
        `  3. Unclosed quotes or brackets\n\n` +
        `Original error: ${stderr}`
      );
    }
    if (stderr.includes("Cannot parse query")) {
      return (
        `Pattern syntax error: The pattern could not be parsed as valid code.\n` +
        `Tips:\n` +
        `  - Patterns must be valid ${args.includes("--lang") ? args[args.indexOf("--lang") + 1] : "language"} syntax\n` +
        `  - Use metavariables like $NAME, $ARGS for variable parts\n` +
        `  - Example: 'function $NAME($$$PARAMS) { $$$BODY }'\n\n` +
        `Original error: ${stderr}`
      );
    }
    return stderr;
  }

  async execRaw(
    args: string[],
    timeout = DEFAULT_EXEC_TIMEOUT_MS,
    options: SgExecutionOptions = {},
  ): Promise<SgRawResult> {
    const command = this.getSgCommand();
    const result = await safeSpawnAsync(command.cmd, [...command.argsPrefix, ...args], {
      timeout,
      deadlineAt: options.deadlineAt,
      signal: options.signal,
      maxOutputBytes: MAX_SG_OUTPUT_BYTES,
    });
    const failure = this.failureForSpawnResult(result);
    return assignOptionalProperties(
      {
        stdout: result.stdout,
        stderr: result.stderr,
        status: result.status,
        error: result.error?.message,
        failure,
      },
      result.outputTruncated,
      () => ({ outputTruncated: true }),
    );
  }

  async exec(args: string[], options: SgExecutionOptions = {}): Promise<SgResult> {
    const command = this.getSgCommand();
    const allArgs = [...command.argsPrefix, ...args];
    const isWindows = process.platform === "win32";
    const hasBash = Boolean(process.env.MSYSTEM || process.env.GIT_SHELL);
    const useBash = isWindows && hasBash;
    const result = await safeSpawnAsync(
      useBash ? "bash" : command.cmd,
      useBash ? buildBashRunArgs(command.cmd, allArgs) : allArgs,
      {
        timeout: DEFAULT_EXEC_TIMEOUT_MS,
        deadlineAt: options.deadlineAt,
        signal: options.signal,
        maxOutputBytes: MAX_SG_OUTPUT_BYTES,
      },
    );
    const empty = (): SgResult => ({
      matches: [],
      totalMatches: 0,
      truncated: false,
    });
    const spawnFailure = this.failureForSpawnResult(result);
    if (spawnFailure) {
      return {
        ...empty(),
        error:
          spawnFailure === "unavailable"
            ? "ast-grep CLI not found. Install: npm i -D @ast-grep/cli"
            : result.error?.message || "ast-grep CLI failed to start",
      };
    }
    if (result.status !== 0) {
      const stdout = result.stdout.trim();
      const stderr = result.stderr.trim();
      if (result.status === 1 && stdout) {
        const matches = tryParseNonZeroSgMatches(result);
        if (matches) {
          return {
            matches,
            totalMatches: matches.length,
            truncated: false,
          };
        }
      }
      if (result.status === 1 && !stdout && !stderr) return empty();
      return {
        ...empty(),
        error: this.formatPatternError(
          stderr || `Command failed with exit code ${result.status}`,
          args,
        ),
      };
    }
    if (!result.stdout.trim()) return empty();
    if (result.outputTruncated) {
      return {
        ...empty(),
        error: "Failed to parse output: output was truncated",
      };
    }
    {
      const matches = tryParseSgMatches(result.stdout);
      if (matches) {
        return {
          matches,
          totalMatches: matches.length,
          truncated: false,
        };
      }
      return { ...empty(), error: "Failed to parse output" };
    }
  }

  private prepareTempScan(ruleId: string, ruleYaml: string): PrepareTempScanResultContract {
    const sessionDir = path.join(os.tmpdir(), `choco-pi-lsp-temp-${ruleId}-${Date.now()}`);
    const rulesSubdir = path.join(sessionDir, "rules");
    const configFile = path.join(sessionDir, ".sgconfig.yml");
    fs.mkdirSync(rulesSubdir, { recursive: true });
    fs.writeFileSync(configFile, `ruleDirs:\n  - ./rules\n`);
    fs.writeFileSync(path.join(rulesSubdir, `${ruleId}.yml`), ruleYaml);

    return { sessionDir, configFile };
  }

  private cleanupTempScan(sessionDir: string): void {
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch (err) {
      this.log(`Cleanup failed: ${err instanceof Error ? err.message : undefined}`);
    }
  }

  private interpretScanResult(result: SpawnResult, args: string[]): SgScanResult {
    const failure = this.failureForSpawnResult(result);
    if (failure) {
      return {
        matches: [],
        status: result.status,
        error: result.error?.message || "ast-grep CLI failed to start",
        failure,
      };
    }
    if (result.status !== 0) {
      const stdout = result.stdout.trim();
      const stderr = result.stderr.trim();
      if (result.status === 1 && stdout) {
        const matches = tryParseNonZeroSgMatches(result);
        if (matches) {
          return { matches, status: result.status };
        }
      }
      if (result.status === 1 && !stdout && !stderr) {
        return { matches: [], status: result.status };
      }
      return {
        matches: [],
        status: result.status,
        error: this.formatPatternError(
          stderr || `ast-grep scan failed with exit code ${result.status}`,
          args,
        ),
        failure: "cli-failure",
      };
    }
    if (!result.stdout.trim()) return { matches: [], status: result.status };
    if (result.outputTruncated) {
      return {
        matches: [],
        status: result.status,
        error: "Failed to parse ast-grep scan output: output was truncated",
        failure: "parse-failure",
      };
    }
    {
      const matches = tryParseSgMatches(result.stdout);
      if (matches) {
        return { matches, status: result.status };
      }
      return {
        matches: [],
        status: result.status,
        error: "Failed to parse ast-grep scan output: invalid JSON",
        failure: "parse-failure",
      };
    }
  }

  async tempScanDetailedAsync(
    dir: string,
    ruleId: string,
    ruleYaml: string,
    timeout = DEFAULT_EXEC_TIMEOUT_MS,
    options: SgExecutionOptions = {},
  ): Promise<SgScanResult> {
    const { sessionDir, configFile } = this.prepareTempScan(ruleId, ruleYaml);
    try {
      const { getSgCommand } = await import("./dispatch/runners/utils/runner-helpers.ts");
      const { cmd: sgCmd, args: sgPre } = getSgCommand();
      const result = await safeSpawnAsync(
        sgCmd,
        [...sgPre, "scan", "--config", configFile, "--json", ...sgExcludeArgsForProject(dir), dir],
        {
          timeout,
          deadlineAt: options.deadlineAt,
          signal: options.signal,
          maxOutputBytes: MAX_SG_OUTPUT_BYTES,
        },
      );
      return this.interpretScanResult(result, ["scan"]);
    } finally {
      this.cleanupTempScan(sessionDir);
    }
  }

  async tempScanAsync(
    dir: string,
    ruleId: string,
    ruleYaml: string,
    timeout = DEFAULT_EXEC_TIMEOUT_MS,
    options: SgExecutionOptions = {},
  ): Promise<SgMatch[]> {
    const result = await this.tempScanDetailedAsync(dir, ruleId, ruleYaml, timeout, options);
    return result.matches;
  }

  async tempScanWithFixAsync(
    dir: string,
    ruleId: string,
    ruleYaml: string,
    applyFixes: boolean,
    timeout = DEFAULT_EXEC_TIMEOUT_MS,
    options: SgExecutionOptions = {},
  ): Promise<{ matches: SgMatch[]; error?: string }> {
    const { sessionDir, configFile } = this.prepareTempScan(ruleId, ruleYaml);
    try {
      const { getSgCommand } = await import("./dispatch/runners/utils/runner-helpers.ts");
      const { cmd: sgCmd, args: sgPre } = getSgCommand();
      const scanArgs = [
        ...sgPre,
        "scan",
        "--config",
        configFile,
        "--json",
        ...sgExcludeArgsForProject(dir),
        dir,
      ];
      const spawnOptions = {
        timeout,
        deadlineAt: options.deadlineAt,
        signal: options.signal,
        maxOutputBytes: MAX_SG_OUTPUT_BYTES,
      };
      if (!applyFixes) {
        const result = await safeSpawnAsync(sgCmd, scanArgs, spawnOptions);
        const scan = this.interpretScanResult(result, ["scan"]);
        return scan.failure || scan.error
          ? { matches: [], error: scan.error }
          : { matches: scan.matches };
      }
      const jsonResult = await safeSpawnAsync(sgCmd, scanArgs, spawnOptions);
      const scan = this.interpretScanResult(jsonResult, ["scan"]);
      if (scan.failure || scan.error) {
        return { matches: [], error: scan.error };
      }
      const applyResult = await safeSpawnAsync(
        sgCmd,
        [
          ...sgPre,
          "scan",
          "--config",
          configFile,
          "--update-all",
          ...sgExcludeArgsForProject(dir),
          dir,
        ],
        spawnOptions,
      );
      if (applyResult.error || applyResult.failure || applyResult.status !== 0) {
        return {
          matches: [],
          error:
            applyResult.error?.message ||
            `ast-grep apply failed with exit code ${applyResult.status}`,
        };
      }
      return { matches: scan.matches };
    } catch (err) {
      return { matches: [], error: String(err) };
    } finally {
      this.cleanupTempScan(sessionDir);
    }
  }

  formatMatches(
    matches: SgMatch[],
    isDryRun = false,
    maxItems = 50,
    showModeIndicator = false,
  ): string {
    if (matches.length === 0) {
      if (showModeIndicator) {
        return isDryRun
          ? "[DRY-RUN] No matches found."
          : "[NOT APPLIED] No matches found — nothing was changed. Run ast_grep_search to confirm the pattern matches before applying.";
      }
      return "No matches found";
    }

    const shown = matches.slice(0, maxItems);
    const lines = shown.map((m) => {
      const loc = `${m.file}:${m.range.start.line + 1}:${m.range.start.column + 1}`;
      const text = m.text.length > 100 ? `${m.text.slice(0, 100)}...` : m.text;
      const langSuffix = m.language ? `  [${m.language}]` : "";
      const base =
        isDryRun && m.replacement
          ? `${loc}\n  - ${text}\n  + ${m.replacement}`
          : `${loc}: ${text}${langSuffix}`;
      const captures = formatMetaVarCaptures(m.metaVariables);
      return captures ? `${base}\n${captures}` : base;
    });

    if (matches.length > maxItems) {
      lines.unshift(`Found ${matches.length} matches (showing first ${maxItems}):`);
    }

    if (showModeIndicator) {
      const prefix = isDryRun ? "[DRY-RUN]" : "[APPLIED]";
      const suffix = isDryRun ? "\n\n(Dry run — use apply=true to apply changes)" : "";
      return `${prefix} ${matches.length} replacement(s):\n\n${lines.join("\n")}${suffix}`;
    }

    return lines.join("\n");
  }
}
