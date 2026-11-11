#!/usr/bin/env node
// Runs the TLC model checker on one spec and config and prints per-rule verdicts
// with counterexample traces as one JSON document (see tlc-result.ts).
//
//   node tlc.ts check --spec <file.tla> --config <file.cfg> [--jar <path>]
//     [--tools-dir <dir>] [--max-states <n>] [--timeout-ms <n>] [--workers <n>]
//     [--out <dir>] [--no-deadlock]
//
// Exit codes: 0 pass, 3 violated, 4 inconclusive (bound or timeout), 2 error.
// It fails closed: output it cannot parse, an unknown TLC exit, or a run that
// did not finish is an error or inconclusive, never a pass.

import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { ConfigError, type ModelConfig, readModelConfig, runConfig } from "./tlc-config.ts";
import {
  EC,
  type TlcBreak,
  type TlcStats,
  type TlcTrace,
  completeRunProblem,
  endingProblem,
  hasMessage,
  readBreak,
  readFailures,
  readMessages,
  readStats,
  readTrace,
  readVersion,
  readWarnings,
  unexpectedStderr,
} from "./tlc-output.ts";
import { type CheckResult, EXIT, type RuleResult, checkResult } from "./tlc-result.ts";
import {
  JAR_NAME,
  MIN_JAVA_MAJOR,
  SETUP_SCRIPT,
  TLA_TOOLS_SHA256,
  type ProcessResult,
  defaultToolsDir,
  javaCommand,
  javaTooOld,
  killActive,
  probeJava,
  runProcess,
  sha256File,
} from "./tlc-tools.ts";

const DEFAULT_MAX_STATES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 << 20;
const MAX_SPEC_FILES = 200;
const BOUND_MODULE = "ChocoPiTlcBound";
const BOUND_OPERATOR = "ChocoPiTlcStateBound";
const FAIRNESS_NOTE =
  "Liveness results depend on the fairness assumptions (WF_/SF_ conjuncts) in the spec: without fairness, a property can fail only because the model may stop taking steps, and with too much fairness it can hold only because the model is forced to act.";

class UsageError extends Error {}

type Options = {
  spec: string;
  config: string;
  jar: string | undefined;
  toolsDir: string;
  maxStates: number;
  timeoutMs: number;
  workers: number;
  out: string | undefined;
  noDeadlock: boolean;
};

function positiveInt(
  name: string,
  value: string | undefined,
  fallback: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value))
    throw new UsageError(`--${name} must be a positive integer, not "${value}"`);
  const n = Number(value);
  if (n < 1 || n > max) throw new UsageError(`--${name} must be between 1 and ${max}`);
  return n;
}

function readOptions(argv: string[]): Options {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      spec: { type: "string" },
      config: { type: "string" },
      jar: { type: "string" },
      "tools-dir": { type: "string" },
      "max-states": { type: "string" },
      "timeout-ms": { type: "string" },
      workers: { type: "string" },
      out: { type: "string" },
      "no-deadlock": { type: "boolean" },
    },
  });
  if (positionals.length !== 1 || positionals[0] !== "check")
    throw new UsageError("usage: tlc.ts check --spec <file.tla> --config <file.cfg> [options]");
  if (!values.spec) throw new UsageError("--spec is required");
  if (!values.config) throw new UsageError("--config is required");
  return {
    spec: path.resolve(values.spec),
    config: path.resolve(values.config),
    jar: values.jar ? path.resolve(values.jar) : process.env.CHOCO_PI_TLA2TOOLS || undefined,
    toolsDir: path.resolve(values["tools-dir"] ?? defaultToolsDir(process.env)),
    maxStates: positiveInt("max-states", values["max-states"], DEFAULT_MAX_STATES, 2_000_000_000),
    timeoutMs: positiveInt("timeout-ms", values["timeout-ms"], DEFAULT_TIMEOUT_MS, 86_400_000),
    workers: positiveInt("workers", values.workers, 1, 256),
    out: values.out ? path.resolve(values.out) : undefined,
    noDeadlock: values["no-deadlock"] ?? false,
  };
}

// ---------------------------------------------------------------------------
// One TLC run

type RunOutcome =
  | { kind: "complete"; stats: TlcStats }
  | { kind: "violation"; broke: TlcBreak; trace: TlcTrace; stats: TlcStats }
  | { kind: "timeout"; stats: TlcStats }
  | { kind: "error"; message: string; stats: TlcStats };

const NO_STATS: TlcStats = { generated: undefined, distinct: undefined, depth: undefined };

const tail = (text: string) => text.trim().split("\n").slice(-20).join("\n");

/** Classifies a finished TLC process. Anything not positively recognised is an error. */
function classifyRun(
  result: ProcessResult,
): RunOutcome & { version: string | undefined; warnings: { code: number; text: string }[] } {
  const none = { version: undefined, warnings: [] };
  if (result.spawnError)
    return {
      ...none,
      kind: "error",
      message: `cannot start Java: ${result.spawnError}`,
      stats: NO_STATS,
    };
  if (result.overflow)
    return {
      ...none,
      kind: "error",
      message: `TLC printed more than ${MAX_OUTPUT_BYTES} bytes; stopped it`,
      stats: NO_STATS,
    };
  const { parts, malformed } = readMessages(result.stdout);
  const stats = readStats(parts);
  const extra = { version: readVersion(parts), warnings: readWarnings(parts) };
  if (result.timedOut) return { ...extra, kind: "timeout", stats };
  const fail = (message: string): RunOutcome & typeof extra => ({
    ...extra,
    kind: "error",
    message: `${message}\n${tail(result.stdout + result.stderr)}`.trim(),
    stats,
  });
  if (result.signal) return fail(`TLC was stopped by ${result.signal}`);
  if (malformed) return fail(malformed);
  const stderr = unexpectedStderr(result.stderr);
  if (stderr.length) return fail(`TLC wrote to stderr: ${stderr.slice(0, 5).join(" | ")}`);
  const failures = readFailures(parts);
  if (failures.length) return { ...extra, kind: "error", message: failures.join("\n"), stats };
  if (!hasMessage(parts, EC.TLC_FINISHED))
    return fail(`TLC exited ${result.exitCode} without reporting that it finished`);
  const ending = endingProblem(parts);
  if (ending) return fail(ending);
  let broke: TlcBreak | undefined;
  try {
    broke = readBreak(parts);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (result.exitCode === 0) {
    if (broke) return fail("TLC exited 0 but reported a violation");
    if (!hasMessage(parts, EC.TLC_SUCCESS))
      return fail("TLC exited 0 without reporting that model checking completed");
    const problem = completeRunProblem(parts);
    if (problem) return fail(problem);
    return { ...extra, kind: "complete", stats };
  }
  if (hasMessage(parts, EC.TLC_SUCCESS))
    return fail(`TLC exited ${result.exitCode} but also reported that model checking completed`);
  const expected =
    broke?.kind === "deadlock"
      ? result.exitCode === 11
      : broke?.kind === "temporal"
        ? result.exitCode === 13
        : broke !== undefined && (result.exitCode === 12 || result.exitCode === 13);
  if (!broke || !expected)
    return fail(`TLC exited ${result.exitCode} with no violation this wrapper recognises`);
  let trace: TlcTrace;
  try {
    trace = readTrace(parts);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (trace.steps.length === 0)
    return fail("TLC reported a violation without a counterexample trace");
  if (broke.kind === "temporal" && !trace.loop)
    return fail("TLC reported a liveness violation without a loop");
  return { ...extra, kind: "violation", broke, trace, stats };
}

// ---------------------------------------------------------------------------
// The check

type Group = { invariants: string[]; properties: string[]; deadlock: boolean };

type Workspace = { dir: string; specDir: string; module: string };

const MODULE_NAME = /^\w*[A-Za-z]\w*$/;

async function prepareWorkspace(specFile: string): Promise<Workspace> {
  const module = path.basename(specFile, ".tla");
  if (path.extname(specFile) !== ".tla" || !MODULE_NAME.test(module))
    throw new UsageError(
      `--spec must name a .tla file whose name is a TLA+ module name: ${specFile}`,
    );
  if (module === BOUND_MODULE)
    throw new UsageError(`the spec module may not be called ${BOUND_MODULE}`);
  const info = await stat(specFile);
  if (!info.isFile()) throw new UsageError(`--spec is not a file: ${specFile}`);
  const source = path.dirname(specFile);
  const siblings = (await readdir(source, { withFileTypes: true })).filter(
    (e) => e.isFile() && e.name.endsWith(".tla"),
  );
  if (siblings.length > MAX_SPEC_FILES)
    throw new UsageError(
      `the spec directory holds more than ${MAX_SPEC_FILES} .tla files; give the model its own directory`,
    );
  if (siblings.some((e) => e.name === `${BOUND_MODULE}.tla`))
    throw new UsageError(`the spec directory may not contain ${BOUND_MODULE}.tla`);
  const dir = await mkdtemp(path.join(tmpdir(), "choco-pi-tlc-"));
  const specDir = path.join(dir, "spec");
  await mkdir(specDir);
  await mkdir(path.join(dir, "tmp"));
  for (const entry of siblings)
    await copyFile(path.join(source, entry.name), path.join(specDir, entry.name));
  return { dir, specDir, module };
}

function boundModule(module: string, maxStates: number): string {
  return [
    `---- MODULE ${BOUND_MODULE} ----`,
    `EXTENDS ${module}`,
    `LOCAL ChocoPiTlc == INSTANCE TLC`,
    `${BOUND_OPERATOR} == ChocoPiTlc!TLCGet("distinct") < ${maxStates}`,
    "====",
    "",
  ].join("\n");
}

const SANY_FAILURE =
  /\*\*\*Parse Error\*\*\*|Semantic errors:|Fatal errors|\*\*\* Errors:|Could not parse|Lexical error|Cannot find source file/;

type Artifact = { name: string; text: string };

async function check(options: Options): Promise<CheckResult> {
  const deadline = Date.now() + options.timeoutMs;
  const result: CheckResult = {
    schema: 1,
    spec: options.spec,
    config: options.config,
    tool: { tlcVersion: null, jarSha256: null, java: null },
    bounds: { maxStates: options.maxStates, timeoutMs: options.timeoutMs },
    status: "error",
    stats: { generated: null, distinct: null, depth: null },
    invariants: [],
    properties: [],
    deadlock: { checked: false, found: false },
    errors: [],
    notes: [],
  };
  const notes = new Set<string>();
  const artifacts: Artifact[] = [];
  let workspace: Workspace | undefined;
  let timedOut = false;
  let cut = false;
  try {
    let config: ModelConfig;
    try {
      config = readModelConfig(await readFile(options.config, "utf8"));
    } catch (error) {
      if (error instanceof ConfigError) throw new UsageError(`${options.config}: ${error.message}`);
      throw error;
    }
    const invariants = new Map<string, RuleResult>(
      config.invariants.map((name) => [name, { name, status: "not_checked" }]),
    );
    const properties = new Map<string, RuleResult>(
      config.properties.map((name) => [name, { name, status: "not_checked" }]),
    );
    result.invariants = [...invariants.values()];
    result.properties = [...properties.values()];
    if (properties.size) notes.add(FAIRNESS_NOTE);
    const deadlockOn = !options.noDeadlock && config.checkDeadlock !== false;
    if (options.noDeadlock) notes.add("Deadlock checking was turned off with --no-deadlock.");
    else if (config.checkDeadlock === false)
      notes.add("Deadlock checking was turned off by CHECK_DEADLOCK FALSE in the config.");
    let deadlockDecided = !deadlockOn;

    const jar = await resolveJar(options, notes);
    result.tool.jarSha256 = jar.sha256;
    const java = javaCommand(process.env);
    const probe = await probeJava(java, process.env, deadline);
    if ("error" in probe) throw new UsageError(probe.error);
    result.tool.java = probe.version;
    if (probe.major < MIN_JAVA_MAJOR) throw new UsageError(javaTooOld(probe.major));

    workspace = await prepareWorkspace(options.spec);
    const ws = workspace;
    await writeFile(
      path.join(ws.specDir, `${BOUND_MODULE}.tla`),
      boundModule(ws.module, options.maxStates),
    );
    const jvm = [`-Djava.io.tmpdir=${path.join(ws.dir, "tmp")}`, "-cp", jar.path];
    const realSpecDir = await realpath(ws.specDir);
    const readable = (text: string) =>
      text
        .replaceAll(realSpecDir, path.dirname(options.spec))
        .replaceAll(ws.specDir, path.dirname(options.spec));

    const sany = await runProcess(java, [...jvm, "tla2sany.SANY", `${ws.module}.tla`], {
      cwd: ws.specDir,
      env: process.env,
      deadline,
      maxBytes: MAX_OUTPUT_BYTES,
    });
    const sanyText = readable(`${sany.stdout}${sany.stderr}`);
    artifacts.push({ name: "sany.out", text: sanyText });
    if (sany.timedOut) {
      timedOut = true;
    } else if (
      sany.spawnError ||
      sany.overflow ||
      sany.exitCode !== 0 ||
      SANY_FAILURE.test(sanyText) ||
      !sanyText.includes(`Semantic processing of module ${ws.module}`)
    ) {
      result.errors.push(
        `SANY could not parse ${options.spec}:\n${sany.spawnError ?? tail(sanyText)}`,
      );
      return result;
    }

    const groups: Group[] = timedOut
      ? []
      : [
          {
            invariants: [...config.invariants],
            properties: [...config.properties],
            deadlock: deadlockOn,
          },
        ];
    const maxRuns = 2 * (config.invariants.length + config.properties.length) + 3;
    const stats = { generated: 0, distinct: 0, depth: 0, seen: false };
    let runs = 0;
    let completeRuns = 0;
    while (groups.length) {
      const first = groups[0];
      if (!first) break;
      const group: Group = {
        invariants: first.invariants.filter((n) => invariants.get(n)?.status === "not_checked"),
        properties: first.properties.filter((n) => properties.get(n)?.status === "not_checked"),
        deadlock: first.deadlock && !deadlockDecided,
      };
      if (runs > 0 && !group.invariants.length && !group.properties.length && !group.deadlock) {
        groups.shift();
        continue;
      }
      if (runs >= maxRuns) {
        result.errors.push(`stopped after ${runs} TLC runs without settling every rule`);
        break;
      }
      runs++;
      const cfgName = `run-${runs}.cfg`;
      const cfgText = runConfig(config, group.invariants, group.properties, BOUND_OPERATOR);
      await writeFile(path.join(ws.dir, cfgName), cfgText);
      const args = [
        "-XX:+UseParallelGC",
        ...jvm,
        "tlc2.TLC",
        "-tool",
        "-workers",
        String(options.workers),
        "-fp",
        "0",
        "-lncheck",
        "final",
        ...(group.deadlock ? [] : ["-deadlock"]),
        "-metadir",
        path.join(ws.dir, `meta-${runs}`),
        "-config",
        path.join(ws.dir, cfgName),
        BOUND_MODULE,
      ];
      const run = await runProcess(java, args, {
        cwd: ws.specDir,
        env: process.env,
        deadline,
        maxBytes: MAX_OUTPUT_BYTES,
      });
      artifacts.push(
        { name: cfgName, text: cfgText },
        { name: `run-${runs}.out`, text: `${run.stdout}${run.stderr}` },
      );
      const outcome = classifyRun(run);
      result.tool.tlcVersion ??= outcome.version ?? null;
      for (const warning of outcome.warnings)
        if (warning.code !== 2401 && (warning.code !== 2284 || config.constrained))
          notes.add(`TLC warning: ${warning.text}`);
      for (const key of ["generated", "distinct", "depth"] as const) {
        const value = outcome.stats[key];
        if (value !== undefined) {
          stats[key] = Math.max(stats[key], value);
          stats.seen = true;
        }
      }
      const reachedBound = (outcome.stats.distinct ?? options.maxStates) >= options.maxStates;
      if (outcome.kind === "timeout") {
        timedOut = true;
        break;
      }
      if (outcome.kind === "error") {
        result.errors.push(readable(outcome.message));
        break;
      }
      if (outcome.kind === "complete") {
        groups.shift();
        if (reachedBound) {
          cut = true;
          continue;
        }
        completeRuns++;
        for (const name of group.invariants) setStatus(invariants, name, "holds");
        for (const name of group.properties) setStatus(properties, name, "holds");
        if (group.deadlock) {
          deadlockDecided = true;
          result.deadlock = { checked: true, found: false };
        }
        continue;
      }
      const { broke, trace } = outcome;
      const steps = trace.steps.map((step) => ({
        index: step.index,
        action: step.action,
        state: step.state,
      }));
      if (broke.kind === "deadlock") {
        if (!group.deadlock) {
          result.errors.push("TLC reported a deadlock in a run that did not check for deadlock");
          break;
        }
        deadlockDecided = true;
        result.deadlock = { checked: true, found: true, trace: steps };
      } else if (broke.kind === "temporal") {
        if (reachedBound) {
          cut = true;
          groups.splice(0, 1, {
            invariants: group.invariants,
            properties: [],
            deadlock: group.deadlock,
          });
          notes.add(
            "A liveness violation found in a run that reached the state bound was discarded: cutting the state space can create false liveness counterexamples.",
          );
          for (const name of group.properties) setStatus(properties, name, "not_checked", true);
        } else if (group.properties.length === 1 && group.properties[0] !== undefined) {
          setStatus(properties, group.properties[0], "violated", false, steps, trace);
        } else if (group.properties.length === 0) {
          result.errors.push("TLC reported a liveness violation in a run that checked no property");
          break;
        } else {
          groups.splice(
            0,
            1,
            { invariants: group.invariants, properties: [], deadlock: group.deadlock },
            ...group.properties.map((name) => ({
              invariants: [],
              properties: [name],
              deadlock: false,
            })),
          );
        }
      } else {
        const name = broke.name;
        if (broke.kind === "invariant" && group.invariants.includes(name))
          setStatus(invariants, name, "violated", false, steps);
        else if (group.properties.includes(name))
          setStatus(properties, name, "violated", false, steps, trace);
        else {
          result.errors.push(`TLC reported a violation of ${name}, which this run did not check`);
          break;
        }
      }
    }
    if (stats.seen)
      result.stats = { generated: stats.generated, distinct: stats.distinct, depth: stats.depth };
    if (cut)
      notes.add(
        `TLC reached the bound of ${options.maxStates} distinct states; rules marked not_checked were not checked on the whole model. Shrink the constants or raise --max-states.`,
      );
    if (timedOut)
      notes.add(
        `The check stopped at the ${options.timeoutMs} ms time limit; rules marked not_checked were not decided.`,
      );
    if (deadlockOn && !deadlockDecided)
      notes.add(
        "Deadlock checking was on but did not finish, so the absence of deadlock is not shown.",
      );
    if (options.workers > 1)
      notes.add(
        "With more than one worker, TLC's counterexamples are not guaranteed to be the shortest.",
      );

    const ruleStates = [...invariants.values(), ...properties.values()];
    const anyViolated = ruleStates.some((r) => r.status === "violated") || result.deadlock.found;
    const anyOpen =
      ruleStates.some((r) => r.status === "not_checked") || !deadlockDecided || cut || timedOut;
    if (result.errors.length) result.status = "error";
    else if (anyViolated) result.status = "violated";
    else if (anyOpen) result.status = "inconclusive";
    else if (completeRuns > 0) {
      result.status = "pass";
      notes.add("A pass covers this model within the bounds above, not the code it describes.");
    } else result.errors.push("no TLC run completed the state space");
    return result;
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    return result;
  } finally {
    if (result.errors.length) result.status = "error";
    result.notes = [...notes];
    if (workspace) await rm(workspace.dir, { recursive: true, force: true });
    if (options.out) {
      try {
        await writeArtifacts(options.out, artifacts, result);
      } catch (error) {
        result.status = "error";
        result.errors.push(
          `cannot write --out: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

function setStatus(
  rules: Map<string, RuleResult>,
  name: string,
  status: RuleResult["status"],
  force = false,
  trace?: RuleResult["trace"],
  tlcTrace?: TlcTrace,
): void {
  const rule = rules.get(name);
  if (!rule || (!force && rule.status !== "not_checked")) return;
  rule.status = status;
  if (trace) rule.trace = trace;
  if (tlcTrace?.loop) rule.loop = tlcTrace.loop;
}

async function resolveJar(
  options: Options,
  notes: Set<string>,
): Promise<{ path: string; sha256: string }> {
  const explicit = options.jar;
  const jar = explicit ?? path.join(options.toolsDir, JAR_NAME);
  let sha256: string;
  try {
    sha256 = await sha256File(jar);
  } catch {
    throw new UsageError(
      explicit
        ? `cannot read the TLA+ tools jar ${jar}`
        : `no TLA+ tools jar at ${jar}; run node ${SETUP_SCRIPT}${options.toolsDir === defaultToolsDir(process.env) ? "" : ` --dir ${options.toolsDir}`} first`,
    );
  }
  if (sha256 !== TLA_TOOLS_SHA256) {
    if (!explicit)
      throw new UsageError(
        `${jar} is not the pinned tla2tools.jar (SHA-256 ${sha256}); delete it and run node ${SETUP_SCRIPT}${options.toolsDir === defaultToolsDir(process.env) ? "" : ` --dir ${options.toolsDir}`}`,
      );
    notes.add(
      `The jar ${jar} is not the pinned release; its output format may differ from what this wrapper was tested on.`,
    );
  }
  return { path: jar, sha256 };
}

async function writeArtifacts(
  out: string,
  artifacts: Artifact[],
  result: CheckResult,
): Promise<void> {
  await mkdir(out, { recursive: true });
  if ((await readdir(out)).length) throw new Error(`${out} is not empty`);
  for (const artifact of artifacts)
    await writeFile(path.join(out, artifact.name), artifact.text, { flag: "wx" });
  await writeFile(path.join(out, "result.json"), `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
  });
}

// ---------------------------------------------------------------------------
// CLI

function usageResult(message: string): CheckResult {
  return {
    schema: 1,
    spec: "",
    config: "",
    tool: { tlcVersion: null, jarSha256: null, java: null },
    bounds: { maxStates: DEFAULT_MAX_STATES, timeoutMs: DEFAULT_TIMEOUT_MS },
    status: "error",
    stats: { generated: null, distinct: null, depth: null },
    invariants: [],
    properties: [],
    deadlock: { checked: false, found: false },
    errors: [message],
    notes: [],
  };
}

async function main(): Promise<number> {
  let result: CheckResult;
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    void killActive();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    result = await check(readOptions(process.argv.slice(2)));
  } catch (error) {
    result = usageResult(error instanceof Error ? error.message : String(error));
  }
  if (interrupted) {
    result.status = "error";
    result.errors.push("interrupted");
  }
  if (!checkResult.check(result)) {
    const problems = checkResult.errors(result).map((e) => `${e.path} ${e.message}`);
    result = usageResult(
      `internal error: the result does not match its schema: ${problems.join("; ")}`,
    );
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return EXIT[result.status];
}

process.exitCode = await main();
