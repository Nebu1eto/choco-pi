/**
 * Parse bash commands for the file access the agent performed, so the read-guard
 * stays consistent with how the Read/Write tools are tracked:
 *
 *   - VIEW commands (cat/head/tail/sed -n) → reads, recorded with the exact line
 *     range shown (like the Read tool's delivered range).
 *   - WRITE commands (redirects, tee, sed -i, cp/mv dest, touch) → the agent
 *     authored/owns the resulting file, exactly like the Write tool — these are
 *     registered via noteCreatedFile + recordWritten so a follow-up edit is not
 *     blocked.
 *
 * NOT treated as reads: grep (scattered matches, not a contiguous view), find
 * and ls (names only, no content), and bare path mentions in arbitrary commands.
 * Treating those as reads would let an edit through for content never shown.
 */
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { isReadableSourceFile } from "./file-kinds.js";
import { countFileLines } from "./read-guard-tool-lines.js";
import type { SearchReadLocation } from "./search-read-registration.js";

/** A contiguous range of lines a bash command showed the agent. */
export interface ReadSpan {
  filePath: string;
  /** 1-based first line read. */
  offset: number;
  /** Number of lines read. */
  limit: number;
}

function stripQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return token.slice(1, -1);
    }
  }
  return token;
}

const ANSI_ESCAPE_SEQUENCE = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "g");

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_SEQUENCE, "");
}

/** Small conservative shell lexer shared by command-analysis consumers. */
export interface ShellCommandSegment {
  tokens: string[];
  unsupported: boolean;
}

export function tokenizeShellCommand(command: string): ShellCommandSegment[] {
  const segments: ShellCommandSegment[] = [];
  let tokens: string[] = [];
  let word = "";
  let quote: "single" | "double" | undefined;
  let escaped = false;
  let unsupported = false;
  let atTokenStart = true;
  const flushWord = () => {
    if (word) tokens.push(word);
    word = "";
    atTokenStart = true;
  };
  const flushSegment = () => {
    flushWord();
    if (tokens.length > 0 || unsupported) segments.push({ tokens, unsupported });
    tokens = [];
    unsupported = false;
    atTokenStart = true;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];
    if (quote === "single") {
      if (ch === "'") quote = undefined;
      else word += ch;
      continue;
    }
    if (quote === "double") {
      if (escaped) {
        word += ch;
        escaped = false;
      } else if (ch === "\\") escaped = true;
      else if (ch === '"') quote = undefined;
      else word += ch;
      continue;
    }
    if (escaped) {
      // A backslash-newline is a shell line continuation, not part of the
      // command argument. Keeping the newline here makes a continued git command
      // visible to command guards.
      if (ch !== "\n") word += ch;
      escaped = false;
      atTokenStart = false;
      continue;
    }
    if (ch === "\\") {
      // Bash uses backslash as a general escape, but command inputs on
      // Windows routinely contain native paths (C:\\src\\file.ts). Preserve
      // backslashes before ordinary path characters while still honoring
      // shell escapes and line continuations.
      if (next === "\n" || /[\s\\'";$|&<>]/.test(next ?? "")) {
        escaped = true;
      } else {
        word += ch;
        atTokenStart = false;
      }
      atTokenStart = false;
      continue;
    }
    if (ch === "'") {
      quote = "single";
      atTokenStart = false;
      continue;
    }
    if (ch === '"') {
      quote = "double";
      atTokenStart = false;
      continue;
    }
    if (ch === "#" && atTokenStart) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
      continue;
    }
    if (/\s/.test(ch)) {
      flushWord();
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") {
      flushWord();
      if (ch === "|" && next === "|") i++;
      else if (ch === "&" && next === "&") i++;
      else if (ch === "|" || ch === "&") unsupported = true;
      flushSegment();
      continue;
    }
    if (ch === "<" || ch === ">") {
      flushWord();
      unsupported = true;
      continue;
    }
    word += ch;
    atTokenStart = false;
  }
  if (quote || escaped) unsupported = true;
  flushSegment();
  return segments;
}

/** Resolve a token to an absolute path if it looks like a source file. */
function resolveCandidate(token: string, cwd: string): string | null {
  const cleaned = stripQuotes(token);
  if (!cleaned || cleaned.startsWith("-") || !isReadableSourceFile(cleaned)) {
    return null;
  }
  return path.isAbsolute(cleaned) ? cleaned : path.resolve(cwd, cleaned);
}

/** Parse a count flag value like `-20`, `-n20`, or the `20` following `-n`. */
function parseCountFlag(token: string): number | undefined {
  const digits = token.replace(/^-n?/, "").replace(/[^0-9]/g, "");
  if (!digits) return undefined;
  const n = Number.parseInt(digits, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function commandSegments(command: string): string[][] {
  return tokenizeShellCommand(command).map((segment) => segment.tokens);
}

/** Find redirect targets without treating quoted `>` characters as syntax. */
function extractRedirectTargets(command: string): string[] {
  const targets: string[] = [];
  let quote: "single" | "double" | undefined;
  let escaped = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote === "single") {
      if (ch === "'") quote = undefined;
      continue;
    }
    if (quote === "double") {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quote = undefined;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'") {
      quote = "single";
      continue;
    }
    if (ch === '"') {
      quote = "double";
      continue;
    }
    if (ch !== ">") continue;
    while (i + 1 < command.length && /\s/.test(command[i + 1])) i += 1;
    if (command[i + 1] === ">") i += 1;
    while (i + 1 < command.length && /\s/.test(command[i + 1])) i += 1;
    let target = "";
    for (i += 1; i < command.length; i += 1) {
      const next = command[i];
      if (/\s/.test(next) || next === ";" || next === "|" || next === "&") {
        i -= 1;
        break;
      }
      target += next;
    }
    if (target) targets.push(target);
  }
  return targets;
}

/**
 * Extract the line ranges a bash command explicitly showed the agent.
 * Only file-VIEWING commands, and only the exact lines shown:
 *   cat/less/more/bat/nl FILE → whole file
 *   head [-n N] FILE          → lines 1..N (default 10)
 *   tail [-n N] FILE          → last N lines (default 10)
 *   sed -n 'A,Bp' FILE        → lines A..B
 */
export function extractReadPathsFromCommand(command: string, cwd: string): ReadSpan[] {
  const spans: ReadSpan[] = [];
  const seen = new Set<string>();

  const resolveFile = (token: string): { abs: string; total: number } | null => {
    const abs = resolveCandidate(token, cwd);
    if (!abs) return null;
    try {
      if (!nodeFs.statSync(abs).isFile()) return null;
    } catch {
      return null;
    }
    return { abs, total: countFileLines(abs) };
  };

  const addSpan = (token: string, start: number, count: number) => {
    const file = resolveFile(token);
    if (!file) return;
    const offset = Math.min(Math.max(1, start), file.total);
    const limit = Math.min(count, file.total - offset + 1);
    if (limit < 1) return;
    const key = `${file.abs}:${offset}:${limit}`;
    if (seen.has(key)) return;
    seen.add(key);
    spans.push({ filePath: file.abs, offset, limit });
  };

  for (const tokens of commandSegments(command)) {
    if (tokens.length === 0) continue;
    const verb = path.basename(tokens[0] ?? "");
    const args = tokens.slice(1);

    if (["cat", "bat", "less", "more", "nl"].includes(verb)) {
      for (const a of args) addSpan(a, 1, Number.MAX_SAFE_INTEGER);
    } else if (verb === "head" || verb === "tail") {
      let count: number | undefined;
      const files: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "-n" || a === "-c") {
          const next = args[i + 1];
          if (next !== undefined) {
            count = parseCountFlag(next) ?? count;
            i++;
          }
        } else if (/^-n?\d+$/.test(a)) {
          count = parseCountFlag(a) ?? count;
        } else if (!a.startsWith("-")) {
          files.push(a);
        }
      }
      const n = count ?? 10; // GNU head/tail default
      for (const f of files) {
        const file = resolveFile(f);
        if (!file) continue;
        if (verb === "head") addSpan(f, 1, n);
        else addSpan(f, file.total - n + 1, n); // tail: last n lines
      }
    } else if (verb === "sed") {
      if (args.includes("-i")) continue; // sed -i writes, not reads
      let range: { start: number; end: number } | undefined;
      for (const a of args) {
        const m = stripQuotes(a).match(/^(\d+),(\d+)p$/);
        if (m) {
          range = {
            start: Number.parseInt(m[1], 10),
            end: Number.parseInt(m[2], 10),
          };
          break;
        }
      }
      if (!range) continue;
      for (const a of args) addSpan(a, range.start, range.end - range.start + 1);
    }
  }

  return spans;
}

function grepHasLineNumbers(args: string[]): boolean {
  return args.some((arg) => {
    const token = stripQuotes(arg);
    if (token === "--line-number") return true;
    if (!token.startsWith("-") || token.startsWith("--")) return false;
    return token.slice(1).includes("n");
  });
}

const GREP_OPTIONS_WITH_VALUE = new Set([
  "-e",
  "-f",
  "-m",
  "-A",
  "-B",
  "-C",
  "--regexp",
  "--file",
  "--max-count",
  "--after-context",
  "--before-context",
  "--context",
]);

function extractGrepSearchFiles(args: string[], cwd: string): string[] {
  const files: string[] = [];
  let patternSeen = false;
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const token = stripQuotes(args[i]);
    if (!endOfOptions && token === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && GREP_OPTIONS_WITH_VALUE.has(token)) {
      i++;
      continue;
    }
    if (!endOfOptions && /^-[ef].+/.test(token)) continue;
    if (!endOfOptions && token.startsWith("-")) continue;
    if (!patternSeen) {
      patternSeen = true;
      continue;
    }
    const abs = resolveCandidate(token, cwd);
    if (!abs) continue;
    try {
      if (!nodeFs.statSync(abs).isFile()) continue;
    } catch {
      continue;
    }
    files.push(abs);
  }
  return files;
}

function parseGrepLineWithFile(line: string, cwd: string): SearchReadLocation | undefined {
  const match = /^(.*?):(\d+):/.exec(stripAnsi(line));
  if (!match) return undefined;
  const lineNumber = Number.parseInt(match[2], 10);
  if (!Number.isFinite(lineNumber) || lineNumber < 1) return undefined;
  const abs = resolveCandidate(match[1], cwd);
  if (!abs) return undefined;
  try {
    if (!nodeFs.statSync(abs).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return { file: abs, startLine: lineNumber, endLine: lineNumber };
}

function parseGrepLineWithoutFile(line: string, file: string): SearchReadLocation | undefined {
  const match = /^(\d+):/.exec(stripAnsi(line));
  if (!match) return undefined;
  const lineNumber = Number.parseInt(match[1], 10);
  if (!Number.isFinite(lineNumber) || lineNumber < 1) return undefined;
  return { file, startLine: lineNumber, endLine: lineNumber };
}

function collectGrepCommandFiles(command: string, cwd: string) {
  const files = new Set<string>();
  let hasLineNumberGrep = false;
  for (const tokens of commandSegments(command)) {
    const verb = path.basename(stripQuotes(tokens[0] ?? ""));
    if (verb !== "grep" && verb !== "egrep" && verb !== "fgrep") continue;
    const args = tokens.slice(1);
    if (!grepHasLineNumbers(args)) continue;
    hasLineNumberGrep = true;
    for (const file of extractGrepSearchFiles(args, cwd)) files.add(file);
  }
  return { hasLineNumberGrep, files };
}

function dedupePushSearchRead(
  out: SearchReadLocation[],
  seen: Set<string>,
  loc: SearchReadLocation | undefined,
): void {
  if (!loc) return;
  const key = `${loc.file}:${loc.startLine}:${loc.endLine ?? loc.startLine}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(loc);
}

function parseGrepOutputSearchReads(
  output: string,
  cwd: string,
  singleFile?: string,
): SearchReadLocation[] {
  const out: SearchReadLocation[] = [];
  const seen = new Set<string>();
  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine) continue;
    dedupePushSearchRead(out, seen, parseGrepLineWithFile(rawLine, cwd));
    if (singleFile) {
      dedupePushSearchRead(out, seen, parseGrepLineWithoutFile(rawLine, singleFile));
    }
  }
  return out;
}

/**
 * Parse `grep -n` output into the specific lines shown to the agent (#169).
 * Multi-file grep prints `file:line:text`; single-file grep prints `line:text`,
 * so the latter is only accepted when the command names exactly one source file.
 */
export function extractGrepSearchReadsFromOutput(
  command: string,
  cwd: string,
  output: string,
): SearchReadLocation[] {
  const { hasLineNumberGrep, files } = collectGrepCommandFiles(command, cwd);
  if (!hasLineNumberGrep) return [];
  const singleFile = files.size === 1 ? [...files][0] : undefined;
  return parseGrepOutputSearchReads(output, cwd, singleFile);
}

/**
 * Extract files a bash command WROTE/created, so the read-guard can treat them
 * as authored by the agent (mirrors the Write tool). Handles:
 *   redirects: `> FILE`, `>> FILE`, `N> FILE`, `&> FILE` (with or without space)
 *   tee [-a] FILE...,  sed -i ... FILE,  cp/mv/install ... DEST,  touch FILE...
 *
 * Returns absolute paths. The file need not exist yet (it may be created) —
 * existence is confirmed later by recordWritten at tool_result time.
 */
export function extractWrittenPathsFromCommand(command: string, cwd: string): string[] {
  const out = new Set<string>();
  const add = (token: string) => {
    const abs = resolveCandidate(token, cwd);
    if (abs) out.add(abs);
  };

  for (const tokens of commandSegments(command)) {
    if (tokens.length === 0) continue;

    // Redirect targets are collected by a quote-aware scanner. The shared
    // tokenizer supplies the normalized command arguments; it deliberately
    // does not expose shell redirection operators as arguments.
    for (const target of extractRedirectTargets(command)) add(target);
    // A command may contain multiple segments; only the first pass should
    // attach redirects, otherwise targets would be duplicated harmlessly but
    // needlessly rescanned.
    break;
  }
  for (const tokens of commandSegments(command)) {
    if (tokens.length === 0) continue;
    const verb = path.basename(tokens[0] ?? "");
    const args = tokens.slice(1);

    if (verb === "tee" || verb === "touch") {
      for (const a of args) if (!a.startsWith("-")) add(a);
    } else if (verb === "sed" && args.includes("-i")) {
      for (const a of args) add(a);
    } else if (verb === "cp" || verb === "mv" || verb === "install") {
      // Known miss (#1668 review F3): the GNU `-t DEST`/`--target-directory`
      // form puts the destination BEFORE the sources — this always treats
      // the LAST non-flag argument as the destination, so `-t DEST SRC` and
      // multi-source `-t DEST SRC1 SRC2...` are misread. Rare in agent-
      // authored bash (source-before-dest is the common form); documented
      // rather than fixed, since correctly parsing `-t` means recognizing it
      // takes a value while telling it apart from every other single-letter
      // flag this same branch already ignores.
      const files = args.filter((a) => !a.startsWith("-"));
      if (files.length >= 1) add(files[files.length - 1]); // destination
    } else if (verb === "git") {
      // git ops that REWRITE working-tree files with explicit paths:
      //   git checkout [<ref>] -- <files>   git restore [opts] <files>
      // These restore content but never go through the edit tool, so without
      // this choco-pi-lsp keeps stale diagnostics/fileSeq for the restored file.
      // Whole-tree ops (reset --hard, stash pop, revert, merge, rebase, pull,
      // or `git checkout <branch>`) don't name files and aren't handled here.
      const sub = args[0];
      if (sub === "checkout" || sub === "restore") {
        const dashDash = args.indexOf("--");
        const fileArgs =
          dashDash >= 0
            ? args.slice(dashDash + 1)
            : sub === "restore"
              ? args.slice(1).filter((a) => !a.startsWith("-"))
              : []; // `git checkout` without `--` is ambiguous (ref vs path)
        for (const a of fileArgs) add(a);
      } else if (sub === "mv") {
        // git mv SRC... DEST — the destination is a write, exactly like
        // plain `mv` above (#1668 review F2). The source side is a delete,
        // handled by extractDeletedPathsFromCommand.
        const files = args.slice(1).filter((a) => !a.startsWith("-"));
        if (files.length >= 1) add(files[files.length - 1]);
      }
    }
  }

  return Array.from(out);
}

/**
 * Extract files a bash command likely DELETED, for the type-3 (Deleted)
 * watched-files gap (#1668): `rm FILE...`, `git rm FILE...`, and the SOURCE
 * side of `mv SRC DEST` / `git mv SRC DEST` (the destination is a write,
 * covered by `extractWrittenPathsFromCommand` — including for `git mv`,
 * #1668 review F2).
 *
 * Deliberately narrow: only commands naming an explicit file target are
 * handled. A bare directory op (`rm -rf dir/`, `git clean`) is skipped —
 * resolving what vanished inside a directory would mean listing it before
 * and after, the "stat the world" cost this module exists to avoid. The
 * caller confirms each candidate by checking it no longer exists on disk;
 * this function only proposes what the command named.
 */
export function extractDeletedPathsFromCommand(command: string, cwd: string): string[] {
  const out = new Set<string>();
  const add = (token: string) => {
    const abs = resolveCandidate(token, cwd);
    if (abs) out.add(abs);
  };
  // mv SRC... DEST / git mv SRC... DEST — every argument except the last is
  // a source that vanishes from its original path once the move lands.
  // Known miss (#1668 review F3): the same `-t DEST`/`--target-directory`
  // form documented in `extractWrittenPathsFromCommand` misreads here too —
  // this assumes source-before-destination order.
  const addMoveSources = (args: string[]) => {
    const files = args.filter((a) => !a.startsWith("-"));
    if (files.length >= 2) {
      for (const src of files.slice(0, -1)) add(src);
    }
  };

  for (const tokens of commandSegments(command)) {
    if (tokens.length === 0) continue;
    const verb = path.basename(tokens[0] ?? "");
    const args = tokens.slice(1);

    if (verb === "rm") {
      for (const a of args) if (!a.startsWith("-")) add(a);
    } else if (verb === "git" && args[0] === "rm") {
      const rmArgs = args.slice(1);
      const dashDash = rmArgs.indexOf("--");
      const fileArgs =
        dashDash >= 0 ? rmArgs.slice(dashDash + 1) : rmArgs.filter((a) => !a.startsWith("-"));
      for (const a of fileArgs) add(a);
    } else if (verb === "git" && args[0] === "mv") {
      addMoveSources(args.slice(1));
    } else if (verb === "mv") {
      addMoveSources(args);
    }
  }

  return Array.from(out);
}
