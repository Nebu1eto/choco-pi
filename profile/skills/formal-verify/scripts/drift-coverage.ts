import { readdir, readFile } from "node:fs/promises";
import { extname, join, posix, relative, sep } from "node:path";
import { arr, compile, lit, obj, oneOf, opt, str, type Static } from "@earendil-works/pi-schema";
import {
  hashText,
  locateSymbol,
  PARSEABLE_EXTENSIONS,
  parseSources,
  parseSymbolRef,
  type ParseOutcome,
} from "./drift-extract.ts";

export const PENDING = "pending";

const CoverEntrySchema = obj({
  file: str({ minLength: 1 }),
  symbol: opt(str({ minLength: 1 })),
  hash: str({ minLength: 1 }),
});

const AssumptionSchema = obj({
  note: str({ minLength: 1 }),
  file: opt(str({ minLength: 1 })),
});

const CoverageSchema = obj({
  schema: lit(1),
  name: str({ minLength: 1 }),
  kind: oneOf(["tla", "property"]),
  artifact: str({ minLength: 1 }),
  command: str({ minLength: 1 }),
  covers: arr(CoverEntrySchema, { minItems: 1 }),
  assumes: arr(AssumptionSchema),
  checkedAt: obj({ commit: str({ minLength: 1 }) }),
});

const coverageValidator = compile(CoverageSchema);

export type Coverage = Static<typeof CoverageSchema>;
export type CoverEntry = Static<typeof CoverEntrySchema>;

export type EntryStatus = "fresh" | "stale" | "pending" | "missing";

export interface EntryResult {
  file: string;
  symbol?: string;
  status: EntryStatus;
  recorded: string;
  current?: string;
  reason?: string;
}

export function normaliseRepoPath(path: string): string | undefined {
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/u.test(path)
  ) {
    return undefined;
  }
  const normalised = posix.normalize(path);
  if (
    normalised === "." ||
    normalised === ".." ||
    normalised.startsWith("../") ||
    normalised.endsWith("/")
  ) {
    return undefined;
  }
  return normalised;
}

export function toRepoRelative(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join("/");
}

export type ParsedCoverage =
  | { readonly ok: true; readonly coverage: Coverage }
  | { readonly ok: false; readonly error: string };

export function parseCoverage(text: string): ParsedCoverage {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const result = coverageValidator.validate(value);
  if (!result.ok) {
    const details = result.errors
      .map((error) => `${error.path || "/"} ${error.message}`)
      .join("; ");
    return { ok: false, error: `schema violation: ${details}` };
  }
  const coverage = result.value;
  const seen = new Set<string>();
  const problems: string[] = [];
  coverage.covers.forEach((entry, index) => {
    const file = normaliseRepoPath(entry.file);
    if (file === undefined || file !== entry.file) {
      problems.push(
        `covers[${index}].file "${entry.file}" is not a normalised repository-relative path`,
      );
    }
    if (entry.symbol !== undefined && parseSymbolRef(entry.symbol) === undefined) {
      problems.push(`covers[${index}].symbol "${entry.symbol}" is not "name" or "Class.member"`);
    }
    if (
      entry.symbol !== undefined &&
      !PARSEABLE_EXTENSIONS.has(extname(entry.file).toLowerCase())
    ) {
      problems.push(
        `covers[${index}].symbol: symbols can be located only in TypeScript or JavaScript files (${[...PARSEABLE_EXTENSIONS].join(", ")}); remove "symbol" to hash the whole of "${entry.file}" instead`,
      );
    }
    const key = `${entry.file}\u0000${entry.symbol ?? ""}`;
    if (seen.has(key)) problems.push(`covers[${index}] duplicates an earlier entry`);
    seen.add(key);
  });
  coverage.assumes.forEach((assumption, index) => {
    if (assumption.file !== undefined) {
      const file = normaliseRepoPath(assumption.file);
      if (file === undefined || file !== assumption.file) {
        problems.push(
          `assumes[${index}].file "${assumption.file}" is not a normalised repository-relative path`,
        );
      }
    }
  });
  if (problems.length > 0) return { ok: false, error: problems.join("; ") };
  return { ok: true, coverage };
}

export async function findCoverageFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === "coverage.json") {
        if (!entry.isFile())
          throw new Error(`${full} is not a regular file; a coverage record must not be a symlink`);
        found.push(toRepoRelative(root, full));
      }
    }
  };
  await walk(join(root, "formal"));
  return found.sort();
}

type FileRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

async function readText(path: string): Promise<FileRead> {
  try {
    return { ok: true, text: await readFile(path, "utf8") };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { ok: false, reason: "file not found" };
    }
    return {
      ok: false,
      reason: `cannot read file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export class HashEvaluator {
  readonly #root: string;
  readonly #reads = new Map<string, Promise<FileRead>>();
  readonly #parses = new Map<string, ParseOutcome>();

  constructor(root: string) {
    this.#root = root;
  }

  #read(file: string): Promise<FileRead> {
    let pending = this.#reads.get(file);
    if (pending === undefined) {
      pending = readText(join(this.#root, file));
      this.#reads.set(file, pending);
    }
    return pending;
  }

  async prepare(entries: readonly CoverEntry[]): Promise<void> {
    const toParse = new Map<string, { fileName: string; text: string }>();
    for (const entry of entries) {
      const read = await this.#read(entry.file);
      if (entry.symbol !== undefined && read.ok && !this.#parses.has(entry.file)) {
        toParse.set(entry.file, { fileName: entry.file, text: read.text });
      }
    }
    if (toParse.size === 0) return;
    const parsed = await parseSources(toParse);
    for (const [file, outcome] of parsed) this.#parses.set(file, outcome);
  }

  async evaluate(entry: CoverEntry): Promise<EntryResult> {
    const result: EntryResult = { file: entry.file, status: "missing", recorded: entry.hash };
    if (entry.symbol !== undefined) result.symbol = entry.symbol;
    const read = await this.#read(entry.file);
    if (!read.ok) {
      result.reason = read.reason;
      return result;
    }
    let current: string;
    if (entry.symbol === undefined) {
      current = hashText(read.text);
    } else {
      const parsed = this.#parses.get(entry.file);
      const located = parsed?.ok === true ? locateSymbol(parsed.sourceFile, entry.symbol) : parsed;
      if (located === undefined) {
        result.reason = "file was not parsed";
        return result;
      }
      if (!located.ok) {
        result.reason = located.reason;
        return result;
      }
      current = hashText(located.text);
    }
    result.status = compareHashes(entry.hash, current);
    result.current = current;
    return result;
  }
}

export function compareHashes(recorded: string, current: string): EntryStatus {
  if (recorded === PENDING) return "pending";
  return recorded === current ? "fresh" : "stale";
}
