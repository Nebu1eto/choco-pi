#!/usr/bin/env node
// Runs every TLA+ model declared by a formal/tla/*/check.json manifest: the
// base model and each mutation, through tlc.ts as a child process (tlc.ts runs
// on import and exports nothing). Prints one JSON summary.
//
//   node check-all.ts [--root <dir>] [--tools-dir <dir>] [--jar <path>]
//     [--jobs <n>] [--only <name>]
//
// Without --root it searches the current directory and its parents, up to the
// git repository root, for the nearest one containing formal/.
//
// Exit codes: 0 every expectation met, or no manifest under an existing formal/
// (the summary then has "manifests": 0 and a message saying nothing was
// checked); 3 an expectation failed (a base model
// that does not give its `expect` result, a mutation whose violated set is not
// exactly its `expectViolated`, or any run that was inconclusive or errored);
// 2 usage error, no formal/ directory, unreadable or malformed manifest, or
// --only naming no model.
// It fails closed: a rule TLC did not check never counts as holding.

import type { Stats } from "node:fs";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  arr,
  compile,
  int,
  lit,
  obj,
  oneOf,
  opt,
  str,
  type Static,
} from "@earendil-works/pi-schema";
import { type CheckResult, checkResult } from "./tlc-result.ts";
import { findFormalRoot } from "./formal-root.ts";
import { killActive, runProcess } from "./tlc-tools.ts";

const TLC_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "tlc.ts");
const MAX_OUTPUT_BYTES = 256 << 20;
/** Extra time past a run's own timeout before the runner kills tlc.ts itself. */
const KILL_MARGIN_MS = 60_000;

const MutationSchema = obj({
  name: str({ minLength: 1 }),
  spec: str({ minLength: 1 }),
  config: str({ minLength: 1 }),
  expectViolated: arr(str({ minLength: 1 })),
});

const ManifestSchema = obj({
  schema: lit(1),
  name: str({ minLength: 1 }),
  spec: str({ minLength: 1 }),
  config: str({ minLength: 1 }),
  expect: oneOf(["pass", "violated"]),
  expectViolated: opt(arr(str({ minLength: 1 }))),
  bounds: obj({ maxStates: int({ minimum: 1 }), timeoutMs: int({ minimum: 1 }) }),
  mutations: arr(MutationSchema),
});

type Manifest = Static<typeof ManifestSchema>;
const manifestValidator = compile(ManifestSchema);

class UsageError extends Error {}

type Options = {
  root: string;
  toolsDir: string | undefined;
  jar: string | undefined;
  jobs: number;
  only: string | undefined;
};

/** One TLC run the runner checks against an expectation. */
type Job = {
  model: string;
  kind: "base" | "mutation";
  name: string;
  spec: string;
  config: string;
  maxStates: number;
  timeoutMs: number;
  /** "pass", or the exact set of rules (and "deadlock") expected violated. */
  expected: "pass" | string[];
};

type JobResult = {
  model: string;
  kind: "base" | "mutation";
  name: string;
  config: string;
  status: CheckResult["status"] | "runner-error";
  expected: "pass" | string[];
  violated: string[];
  notChecked: string[];
  distinct: number | null;
  elapsedMs: number;
  ok: boolean;
  problem?: string;
};

/** Parsed arguments; --root is resolved separately by findFormalRoot. */
type Arguments = Omit<Options, "root"> & { root: string | undefined };

function parseOptions(argv: string[]): Arguments {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: "string" },
      "tools-dir": { type: "string" },
      jar: { type: "string" },
      jobs: { type: "string" },
      only: { type: "string" },
    },
  });
  if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`);
  const jobs = values.jobs === undefined ? 1 : Number(values.jobs);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 16) {
    throw new UsageError("--jobs must be an integer from 1 to 16");
  }
  return {
    root: values.root,
    toolsDir: values["tools-dir"] === undefined ? undefined : path.resolve(values["tools-dir"]),
    jar: values.jar === undefined ? undefined : path.resolve(values.jar),
    jobs,
    only: values.only,
  };
}

/** True when a filesystem error says the path does not exist. */
function isMissing(error: Error): boolean {
  return "code" in error && error.code === "ENOENT";
}

/**
 * Every formal/tla/<dir>/check.json under root, sorted. Only a formal/tla that
 * does not exist means "no models"; a plain file in formal/tla, or a directory
 * with no check.json entry, is not a model. Every other failure to look (an
 * unreadable directory, a dangling symlink, a check.json that is not a file)
 * is an error naming the path, so a model is never silently skipped.
 */
async function findManifests(root: string): Promise<string[]> {
  const base = path.join(root, "formal", "tla");
  try {
    await lstat(base);
  } catch (error) {
    if (error instanceof Error && isMissing(error)) return [];
    throw new UsageError(`cannot inspect ${base}: ${String(error)}`);
  }
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch (error) {
    throw new UsageError(`cannot list ${base}: ${String(error)}`);
  }
  const found: string[] = [];
  for (const entry of entries.sort()) {
    const dir = path.join(base, entry);
    let info: Stats;
    try {
      info = await stat(dir);
    } catch (error) {
      throw new UsageError(`cannot inspect ${dir}: ${String(error)}`);
    }
    if (!info.isDirectory()) continue;
    const file = path.join(dir, "check.json");
    try {
      await lstat(file);
    } catch (error) {
      if (error instanceof Error && isMissing(error)) continue;
      throw new UsageError(`cannot inspect ${file}: ${String(error)}`);
    }
    let target: Stats;
    try {
      target = await stat(file);
    } catch (error) {
      throw new UsageError(`cannot inspect ${file}: ${String(error)}`);
    }
    if (!target.isFile()) throw new UsageError(`${file} is not a file`);
    found.push(file);
  }
  return found;
}

/** Resolve a manifest-relative path that must stay inside the model directory. */
function inside(dir: string, relative: string, field: string): string {
  if (path.isAbsolute(relative)) throw new UsageError(`${field} must be relative: ${relative}`);
  const resolved = path.resolve(dir, relative);
  const rel = path.relative(dir, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new UsageError(`${field} leaves the model directory: ${relative}`);
  }
  return resolved;
}

async function readManifest(file: string): Promise<Manifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new UsageError(`${file}: cannot read JSON: ${String(error)}`);
  }
  if (!manifestValidator.check(parsed)) {
    throw new UsageError(
      `${file}: not a check.json manifest: ${JSON.stringify(manifestValidator.errors(parsed))}`,
    );
  }
  if (parsed.expect === "violated" && (parsed.expectViolated ?? []).length === 0) {
    throw new UsageError(`${file}: expect "violated" needs a non-empty expectViolated`);
  }
  if (parsed.expect === "pass" && parsed.expectViolated !== undefined) {
    throw new UsageError(`${file}: expectViolated is only allowed with expect "violated"`);
  }
  const names = new Set<string>();
  for (const mutation of parsed.mutations) {
    if (names.has(mutation.name)) {
      throw new UsageError(`${file}: duplicate mutation name ${mutation.name}`);
    }
    names.add(mutation.name);
    if (mutation.expectViolated.length === 0) {
      throw new UsageError(`${file}: mutation ${mutation.name} must expect a violation`);
    }
  }
  return parsed;
}

async function jobsFor(file: string): Promise<Job[]> {
  const manifest = await readManifest(file);
  const dir = path.dirname(file);
  const common = {
    model: manifest.name,
    maxStates: manifest.bounds.maxStates,
    timeoutMs: manifest.bounds.timeoutMs,
  };
  const jobs: Job[] = [
    {
      ...common,
      kind: "base",
      name: manifest.name,
      spec: inside(dir, manifest.spec, "spec"),
      config: inside(dir, manifest.config, "config"),
      expected: manifest.expect === "pass" ? "pass" : [...(manifest.expectViolated ?? [])],
    },
  ];
  for (const mutation of manifest.mutations) {
    jobs.push({
      ...common,
      kind: "mutation",
      name: mutation.name,
      spec: inside(dir, mutation.spec, `mutation ${mutation.name} spec`),
      config: inside(dir, mutation.config, `mutation ${mutation.name} config`),
      expected: [...mutation.expectViolated],
    });
  }
  for (const job of jobs) {
    for (const required of [job.spec, job.config]) {
      let info: Stats;
      try {
        info = await stat(required);
      } catch (error) {
        throw new UsageError(`${file}: cannot read ${required}: ${String(error)}`);
      }
      if (!info.isFile()) throw new UsageError(`${file}: ${required} is not a file`);
    }
  }
  return jobs;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((item) => right.has(item));
}

/** Whether a run met its expectation, and why not. */
type Verdict = { ok: boolean; problem?: string };

/** Compare one tlc.ts result with its expectation, failing closed. */
function judge(job: Job, result: CheckResult): Verdict {
  const rules = [...result.invariants, ...result.properties];
  const violated = rules.filter((rule) => rule.status === "violated").map((rule) => rule.name);
  if (result.deadlock.found) violated.push("deadlock");
  const notChecked = rules.filter((rule) => rule.status === "not_checked").map((rule) => rule.name);
  if (result.status === "error" || result.status === "inconclusive") {
    return { ok: false, problem: `run was ${result.status}: ${result.errors.join("; ")}` };
  }
  if (notChecked.length > 0) {
    return { ok: false, problem: `rules not checked: ${notChecked.join(", ")}` };
  }
  if (job.expected === "pass") {
    return result.status === "pass"
      ? { ok: true }
      : { ok: false, problem: `expected pass, violated: ${violated.join(", ")}` };
  }
  if (result.status !== "violated") {
    return { ok: false, problem: `expected ${job.expected.join(", ")} violated, got a pass` };
  }
  return sameSet(violated, job.expected)
    ? { ok: true }
    : {
        ok: false,
        problem: `expected exactly ${job.expected.join(", ")} violated, got ${violated.join(", ")}`,
      };
}

async function runJob(job: Job, options: Options): Promise<JobResult> {
  const args = [
    TLC_SCRIPT,
    "check",
    "--spec",
    job.spec,
    "--config",
    job.config,
    "--max-states",
    String(job.maxStates),
    "--timeout-ms",
    String(job.timeoutMs),
  ];
  if (options.toolsDir !== undefined) args.push("--tools-dir", options.toolsDir);
  if (options.jar !== undefined) args.push("--jar", options.jar);
  const base = {
    model: job.model,
    kind: job.kind,
    name: job.name,
    config: path.relative(options.root, job.config),
    expected: job.expected,
  };
  const run = await runProcess(process.execPath, args, {
    cwd: options.root,
    env: process.env,
    deadline: Date.now() + job.timeoutMs + KILL_MARGIN_MS,
    maxBytes: MAX_OUTPUT_BYTES,
  });
  const failed = (problem: string): JobResult => ({
    ...base,
    status: "runner-error",
    violated: [],
    notChecked: [],
    distinct: null,
    elapsedMs: run.elapsedMs,
    ok: false,
    problem,
  });
  if (run.spawnError !== undefined) return failed(`cannot start tlc.ts: ${run.spawnError}`);
  if (run.timedOut) return failed("tlc.ts did not finish within its timeout plus margin");
  if (run.overflow) return failed("tlc.ts output exceeded the runner's limit");
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    return failed(`tlc.ts printed no JSON (exit ${run.exitCode}): ${run.stderr.slice(0, 2000)}`);
  }
  if (!checkResult.check(parsed)) return failed("tlc.ts output does not match its schema");
  const rules = [...parsed.invariants, ...parsed.properties];
  const violated = rules.filter((rule) => rule.status === "violated").map((rule) => rule.name);
  if (parsed.deadlock.found) violated.push("deadlock");
  const verdict = judge(job, parsed);
  return {
    ...base,
    status: parsed.status,
    violated,
    notChecked: rules.filter((rule) => rule.status === "not_checked").map((rule) => rule.name),
    distinct: parsed.stats.distinct,
    elapsedMs: run.elapsedMs,
    ...verdict,
  };
}

/** Run jobs with at most `options.jobs` in flight; results keep job order. */
async function runAll(jobs: Job[], options: Options): Promise<JobResult[]> {
  const results: JobResult[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await runJob(jobs[index], options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.jobs, jobs.length) }, () => worker()));
  return results;
}

async function main(argv: string[]): Promise<number> {
  let options: Options;
  let jobs: Job[] = [];
  let manifests: string[] = [];
  try {
    const args = parseOptions(argv);
    let root: string;
    try {
      root = await findFormalRoot(process.cwd(), args.root);
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
    options = { ...args, root };
    const formal = path.join(root, "formal");
    let formalInfo: Stats | undefined;
    try {
      formalInfo = await stat(formal);
    } catch (error) {
      if (!(error instanceof Error && isMissing(error)))
        throw new UsageError(`cannot inspect ${formal}: ${String(error)}`);
    }
    if (formalInfo === undefined || !formalInfo.isDirectory()) {
      throw new UsageError(`no formal/ directory under ${root}`);
    }
    manifests = await findManifests(options.root);
    for (const manifest of manifests) jobs.push(...(await jobsFor(manifest)));
    if (options.only !== undefined) {
      const only = options.only;
      jobs = jobs.filter((job) => job.model === only);
      if (jobs.length === 0) throw new UsageError(`no model named ${only}`);
    }
    if (manifests.length === 0) {
      // Nothing to check is not a failure, but it must not read as "models passed".
      const message = `no TLA+ model manifest found: searched ${path.join(root, "formal", "tla", "*", "check.json")}; nothing was checked`;
      process.stdout.write(
        `${JSON.stringify({ schema: 1, ok: true, manifests: 0, message, results: [] }, null, 2)}\n`,
      );
      return 0;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      process.stdout.write(`${JSON.stringify({ schema: 1, ok: false, error: error.message })}\n`);
      return 2;
    }
    throw error;
  }
  const results = await runAll(jobs, options);
  const ok = results.every((result) => result.ok);
  process.stdout.write(
    `${JSON.stringify({ schema: 1, ok, manifests: manifests.length, results }, null, 2)}\n`,
  );
  return ok ? 0 : 3;
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const stop = () => {
    void killActive().then(() => process.exit(130));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const entry = async (): Promise<void> => {
    try {
      process.exitCode = await main(process.argv.slice(2));
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({ schema: 1, ok: false, error: `runner failed: ${String(error)}` })}\n`,
      );
      process.exitCode = 2;
    }
  };
  void entry();
}
