#!/usr/bin/env node
// Drift check between formal artefacts (TLA+ models, property tests) and the
// source symbols they declare in formal/**/coverage.json.
//
// This detects TEXTUAL change only. A fresh result means the covered text is
// unchanged since the artefact was last checked; it does not show that the
// artefact still matches the code. The check fails closed: a missing or
// ambiguous symbol, an unreadable or unparseable file, or a malformed
// declaration is never reported as fresh.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { compile, obj, opt, str } from "@earendil-works/pi-schema";
import {
  type Coverage,
  type EntryResult,
  findCoverageFiles,
  HashEvaluator,
  normaliseRepoPath,
  parseCoverage,
  PENDING,
  toRepoRelative,
} from "./drift-coverage.ts";
import { FormalRootNotFound, findFormalRoot } from "./formal-root.ts";

const execFileAsync = promisify(execFile);

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_DRIFT = 3;

export const USAGE = `Usage: node drift.ts <command> [options]

Detects TEXTUAL change in source symbols covered by formal artefacts (TLA+
models, property tests) declared in formal/**/coverage.json. "fresh" means the
covered text is unchanged since the artefact was last checked; it does not show
that the artefact still matches the code. Missing symbols, unreadable or
unparseable files and malformed declarations are errors, never "fresh".

Commands:
  check [--root <dir>]
      Validate every coverage.json under <root>/formal and recompute hashes.
      Exit 0 when all are fresh, 3 when any entry is stale, pending or missing.
  affected (--files <path>... | --base <git rev>) [--root <dir>]
      List declarations covering the given files, or any file changed since
      <rev> (committed, staged, unstaged and untracked). For each matching entry,
      report whether its current hash differs from the recorded one.
      Exit 0 when nothing is affected, 3 when something is.
  update --file <coverage.json> [--commit <rev>] [--root <dir>]
      Recompute and record hashes and checkedAt.commit (default HEAD), written
      atomically. Run this ONLY after the artefact has been re-run against the
      changed code and passed; updating hashes without re-running it hides drift.
      Refuses to write (exit 3) when any entry is missing.

Options:
  --root <dir>   Directory containing formal/ (default: the nearest of the
                 current directory and its parents that has one, up to the
                 git repository root). Covered paths are relative to it.

Exit codes: 0 ok, 2 usage, malformed declaration or tool error, 3 drift.
An entry with "symbol" hashes one declaration (from its first modifier or
keyword, excluding leading comments, to its end); symbols can be located only in
TypeScript and JavaScript files. An entry without "symbol" hashes the whole file
and works for any language, at the cost of reporting every edit to the file.
Text is hashed with SHA-256 after converting CRLF/CR to LF and stripping
trailing whitespace per line. Indentation changes still count as changes.`;

class UsageError extends Error {
  override readonly name = "UsageError";
}

class ToolError extends Error {
  override readonly name = "ToolError";
}

type Args =
  | { readonly command: "help" }
  | { readonly command: "check"; readonly root: string | undefined }
  | {
      readonly command: "affected";
      readonly root: string | undefined;
      readonly files: readonly string[] | undefined;
      readonly base: string | undefined;
    }
  | {
      readonly command: "update";
      readonly root: string | undefined;
      readonly file: string;
      readonly commit: string | undefined;
    };

function flagsFor(command: string): readonly string[] | undefined {
  switch (command) {
    case "check":
      return ["--root"];
    case "affected":
      return ["--root", "--files", "--base"];
    case "update":
      return ["--root", "--file", "--commit"];
    default:
      return undefined;
  }
}

/** Parse CLI arguments; throws UsageError on anything unexpected. */
export function parseArgs(argv: readonly string[]): Args {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    return { command: "help" };
  }
  const values = new Map<string, string>();
  let files: string[] | undefined;
  const flags = flagsFor(command);
  if (flags === undefined) throw new UsageError(`unknown command "${command}"`);
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === undefined || !flags.includes(flag))
      throw new UsageError(`unexpected argument "${flag ?? ""}"`);
    if (flag === "--files") {
      if (files !== undefined) throw new UsageError("--files given twice");
      files = [];
      while (i + 1 < rest.length && !(rest[i + 1] ?? "").startsWith("--")) {
        i += 1;
        files.push(rest[i] ?? "");
      }
      if (files.length === 0) throw new UsageError("--files needs at least one path");
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--"))
      throw new UsageError(`${flag} needs a value`);
    if (values.has(flag)) throw new UsageError(`${flag} given twice`);
    values.set(flag, value);
    i += 1;
  }
  const root = values.get("--root");
  if (command === "check") return { command, root };
  if (command === "affected") {
    const base = values.get("--base");
    if ((files === undefined) === (base === undefined)) {
      throw new UsageError("affected needs exactly one of --files or --base");
    }
    return { command, root, files, base };
  }
  const file = values.get("--file");
  if (file === undefined) throw new UsageError("update needs --file");
  return { command: "update", root, file, commit: values.get("--commit") };
}

async function git(root: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ToolError(`git ${args.join(" ")} failed: ${detail}`);
  }
}

function splitNul(output: string): string[] {
  return output.split("\0").filter((part) => part.length > 0);
}

async function resolveRoot(cwd: string, root: string | undefined): Promise<string> {
  let absolute: string;
  try {
    absolute = await findFormalRoot(cwd, root);
  } catch (error) {
    if (error instanceof FormalRootNotFound) throw new ToolError(error.message);
    throw error;
  }
  const formal = join(absolute, "formal");
  const info = await stat(formal).catch(() => undefined);
  if (info === undefined || !info.isDirectory())
    throw new UsageError(`no formal/ directory under ${absolute}`);
  return absolute;
}

interface LoadedDeclaration {
  readonly path: string;
  readonly result: ReturnType<typeof parseCoverage>;
  readonly text: string;
}

async function loadDeclaration(root: string, path: string): Promise<LoadedDeclaration> {
  let text: string;
  try {
    text = await readFile(join(root, path), "utf8");
  } catch (error) {
    return { path, text: "", result: { ok: false, error: `cannot read: ${String(error)}` } };
  }
  return { path, text, result: parseCoverage(text) };
}

interface MalformedIdentity {
  readonly name: string;
  readonly kind: string;
}

const identityValidator = compile(obj({ name: opt(str()), kind: opt(str()) }, { open: true }));

/** Best-effort name and kind of a declaration that failed validation, for reporting only. */
function describeMalformed(text: string): MalformedIdentity {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { name: "", kind: "" };
  }
  const identity = identityValidator.validate(value);
  if (!identity.ok) return { name: "", kind: "" };
  return { name: identity.value.name ?? "", kind: identity.value.kind ?? "" };
}

export interface DeclarationReport {
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  readonly status: "fresh" | "stale" | "error";
  readonly entries: readonly EntryResult[];
  readonly error?: string;
  /** Why a declaration is stale beyond its entries, for example a pending checkedAt.commit. */
  reason?: string;
}

export interface CheckReport {
  readonly schema: 1;
  readonly root: string;
  readonly declarations: readonly DeclarationReport[];
}

/** check: every declaration under <root>/formal. */
export async function runCheck(root: string): Promise<{ report: CheckReport; exitCode: number }> {
  const paths = await findCoverageFiles(root);
  const loaded = await Promise.all(paths.map((path) => loadDeclaration(root, path)));
  const evaluator = new HashEvaluator(root);
  await evaluator.prepare(
    loaded.flatMap((item) => (item.result.ok ? item.result.coverage.covers : [])),
  );
  const declarations: DeclarationReport[] = [];
  for (const item of loaded) {
    if (!item.result.ok) {
      declarations.push({
        path: item.path,
        ...describeMalformed(item.text),
        status: "error",
        entries: [],
        error: item.result.error,
      });
      continue;
    }
    const coverage = item.result.coverage;
    const entries = await Promise.all(coverage.covers.map((entry) => evaluator.evaluate(entry)));
    const neverChecked = coverage.checkedAt.commit === PENDING;
    const allFresh = entries.every((entry) => entry.status === "fresh");
    const missing = entries.filter((entry) => entry.status === "missing").length;
    let reason: string | undefined;
    if (neverChecked) reason = "checkedAt.commit is pending: the artefact has never been checked";
    else if (missing > 0)
      reason = `${missing} covered entr${missing === 1 ? "y is" : "ies are"} missing`;
    const report: DeclarationReport = {
      path: item.path,
      name: coverage.name,
      kind: coverage.kind,
      status: allFresh && !neverChecked ? "fresh" : "stale",
      entries,
    };
    if (reason !== undefined) report.reason = reason;
    declarations.push(report);
  }
  let exitCode = EXIT_OK;
  if (declarations.some((declaration) => declaration.status === "error")) exitCode = EXIT_USAGE;
  else if (declarations.some((declaration) => declaration.status !== "fresh"))
    exitCode = EXIT_DRIFT;
  return { report: { schema: 1, root, declarations }, exitCode };
}

/** Repository-relative paths changed since `base`: committed, staged, unstaged and untracked. */
export async function changedFilesSince(root: string, base: string): Promise<string[]> {
  if (base.startsWith("-")) throw new UsageError(`invalid revision "${base}"`);
  const [diff, untracked] = await Promise.all([
    git(root, ["diff", "--name-only", "-z", "--no-renames", "--relative", base, "--"]),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return [...new Set([...splitNul(diff), ...splitNul(untracked)])].sort();
}

function normaliseInputFiles(cwd: string, root: string, files: readonly string[]): string[] {
  const result = new Set<string>();
  for (const file of files) {
    const relativePath = normaliseRepoPath(toRepoRelative(root, resolve(cwd, file)));
    if (relativePath === undefined) throw new UsageError(`path is outside the root: ${file}`);
    result.add(relativePath);
  }
  return [...result].sort();
}

export interface AffectedMatch {
  readonly file: string;
  symbol?: string;
  readonly via: "covers" | "assumes";
  /** Entry status from the hash check; absent for assumptions, which have no hash. */
  readonly status?: EntryResult["status"];
  /** Whether the covered text differs from the recorded hash (pending and missing count as changed); null for assumptions. */
  readonly changed: boolean | null;
  reason?: string;
}

export interface AffectedReport {
  readonly schema: 1;
  readonly root: string;
  readonly files: readonly string[];
  readonly declarations: readonly {
    readonly path: string;
    readonly name: string;
    readonly kind: string;
    readonly command: string;
    readonly changed: boolean;
    readonly matches: readonly AffectedMatch[];
  }[];
  readonly errors: readonly { readonly path: string; readonly error: string }[];
}

/** affected: declarations covering or assuming any of `files`. */
export async function runAffected(
  root: string,
  files: readonly string[],
): Promise<{ report: AffectedReport; exitCode: number }> {
  const changed = new Set(files);
  const paths = await findCoverageFiles(root);
  const loaded = await Promise.all(paths.map((path) => loadDeclaration(root, path)));
  const errors: { path: string; error: string }[] = [];
  const valid: { path: string; coverage: Coverage }[] = [];
  for (const item of loaded) {
    if (item.result.ok) valid.push({ path: item.path, coverage: item.result.coverage });
    else errors.push({ path: item.path, error: item.result.error });
  }
  const evaluator = new HashEvaluator(root);
  await evaluator.prepare(
    valid.flatMap(({ coverage }) => coverage.covers.filter((entry) => changed.has(entry.file))),
  );
  const declarations: AffectedReport["declarations"][number][] = [];
  for (const { path, coverage } of valid) {
    const matches: AffectedMatch[] = [];
    for (const entry of coverage.covers) {
      if (!changed.has(entry.file)) continue;
      const result = await evaluator.evaluate(entry);
      const match: AffectedMatch = {
        file: entry.file,
        via: "covers",
        status: result.status,
        changed: result.status !== "fresh",
      };
      if (entry.symbol !== undefined) match.symbol = entry.symbol;
      if (result.reason !== undefined) match.reason = result.reason;
      matches.push(match);
    }
    for (const assumption of coverage.assumes) {
      if (assumption.file !== undefined && changed.has(assumption.file)) {
        matches.push({ file: assumption.file, via: "assumes", changed: null });
      }
    }
    if (matches.length > 0) {
      declarations.push({
        path,
        name: coverage.name,
        kind: coverage.kind,
        command: coverage.command,
        changed: matches.some((match) => match.changed === true),
        matches,
      });
    }
  }
  let exitCode = EXIT_OK;
  if (errors.length > 0) exitCode = EXIT_USAGE;
  else if (declarations.length > 0) exitCode = EXIT_DRIFT;
  return { report: { schema: 1, root, files, declarations, errors }, exitCode };
}

/** Serialise a declaration the way update writes it: 2-space JSON and a trailing newline. */
export function formatCoverage(coverage: Coverage): string {
  return `${JSON.stringify(coverage, null, 2)}\n`;
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export interface UpdateReport {
  readonly schema: 1;
  readonly path: string;
  readonly written: boolean;
  readonly commit: string;
  readonly entries: readonly EntryResult[];
  readonly warnings: readonly string[];
}

/** update: recompute hashes of one declaration and record them with the commit. */
export async function runUpdate(
  root: string,
  cwd: string,
  file: string,
  commit: string | undefined,
): Promise<{ report: UpdateReport; exitCode: number }> {
  const absolute = resolve(cwd, file);
  const path = normaliseRepoPath(toRepoRelative(root, absolute));
  if (path === undefined || !path.startsWith("formal/") || basename(path) !== "coverage.json") {
    throw new UsageError(`--file must be a coverage.json under ${join(root, "formal")}`);
  }
  if (commit !== undefined && (commit.startsWith("-") || commit === PENDING)) {
    throw new UsageError(`invalid commit "${commit}"`);
  }
  const loaded = await loadDeclaration(root, path);
  if (!loaded.result.ok) throw new UsageError(`${path}: ${loaded.result.error}`);
  const coverage = loaded.result.coverage;
  const sha = (
    await git(root, ["rev-parse", "--verify", "--quiet", `${commit ?? "HEAD"}^{commit}`])
  ).trim();
  if (!/^[0-9a-f]{40,64}$/u.test(sha))
    throw new ToolError(`cannot resolve commit ${commit ?? "HEAD"}`);
  const evaluator = new HashEvaluator(root);
  await evaluator.prepare(coverage.covers);
  const entries = await Promise.all(coverage.covers.map((entry) => evaluator.evaluate(entry)));
  if (entries.some((entry) => entry.current === undefined)) {
    return {
      report: { schema: 1, path, written: false, commit: sha, entries, warnings: [] },
      exitCode: EXIT_DRIFT,
    };
  }
  coverage.covers.forEach((entry, index) => {
    const current = entries[index]?.current;
    if (current !== undefined) entry.hash = current;
  });
  coverage.checkedAt.commit = sha;
  const warnings: string[] = [];
  const coveredFiles = [...new Set(coverage.covers.map((entry) => entry.file))];
  const dirty = splitNul(
    await git(root, ["status", "--porcelain=v1", "-z", "--", ...coveredFiles]),
  );
  if (dirty.length > 0) {
    warnings.push(
      "covered files have uncommitted changes: the recorded hashes describe the working tree, not the recorded commit",
    );
  }
  await writeAtomically(join(root, path), formatCoverage(coverage));
  return {
    report: { schema: 1, path, written: true, commit: sha, entries, warnings },
    exitCode: EXIT_OK,
  };
}

export interface Io {
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** Run the CLI and return its exit code. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.command === "help") {
      io.stdout(`${USAGE}\n`);
      return EXIT_OK;
    }
    const root = await resolveRoot(io.cwd, args.root);
    let outcome: { report: object; exitCode: number };
    if (args.command === "check") {
      outcome = await runCheck(root);
    } else if (args.command === "affected") {
      const files =
        args.base === undefined
          ? normaliseInputFiles(io.cwd, root, args.files ?? [])
          : await changedFilesSince(root, args.base);
      outcome = await runAffected(root, files);
    } else {
      outcome = await runUpdate(root, io.cwd, args.file, args.commit);
    }
    io.stdout(`${JSON.stringify(outcome.report, null, 2)}\n`);
    return outcome.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`drift: ${message}\n`);
    if (error instanceof UsageError) io.stderr(`\n${USAGE}\n`);
    return EXIT_USAGE;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
