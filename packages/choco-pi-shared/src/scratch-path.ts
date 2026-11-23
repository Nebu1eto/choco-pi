// Scratch-path ownership: temporary files belong under /tmp/choco-pi/<root session id>/.
// Warn mode only. Nothing here denies a tool call or inspects command contents.
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isJsonRecord, isString, type RuntimeValue } from "./runtime-values.ts";

export const SCRATCH_BASE = "/tmp/choco-pi";
export const ROOT_SESSION_ENV = "PI_ROOT_SESSION_ID";
export const SCRATCH_DIR_ENV = "PI_SCRATCH_DIR";
export const PREVIOUS_SCRATCH_DIR_ENV = "PI_PREVIOUS_SCRATCH_DIR";
export const SCRATCH_GRANTS_KEY = "scratchGrants";

const ROOTS_KEY = Symbol.for("choco-pi:scratch-roots");
const PREVIOUS_KEY = Symbol.for("choco-pi:scratch-previous");

export interface ScratchResolution {
  rootSessionId: string;
  currentSessionId: string;
  /** Always ends with a slash. */
  scratchDir: string;
  previousScratchDir?: string;
}

export interface ResolveScratchInput {
  /** Lineage root when known; the current id otherwise. */
  rootSessionId?: string | undefined;
  currentSessionId: string;
  previousSessionId?: string | undefined;
}

export function scratchDirFor(rootSessionId: string): string {
  return `${SCRATCH_BASE}/${rootSessionId}/`;
}

export function resolveScratch(input: ResolveScratchInput): ScratchResolution {
  const rootSessionId = input.rootSessionId || input.currentSessionId;
  const resolution: ScratchResolution = {
    rootSessionId,
    currentSessionId: input.currentSessionId,
    scratchDir: scratchDirFor(rootSessionId),
  };
  if (input.previousSessionId && input.previousSessionId !== rootSessionId)
    resolution.previousScratchDir = scratchDirFor(input.previousSessionId);
  return resolution;
}

function sharedMap(key: symbol): Map<string, string> {
  const existing: RuntimeValue = Object.getOwnPropertyDescriptor(globalThis, key)?.value;
  if (existing instanceof Map) return existing;
  const created = new Map<string, string>();
  Object.defineProperty(globalThis, key, { value: created, configurable: true });
  return created;
}

/** Records that `sessionId` belongs to the lineage rooted at `rootSessionId` (subagent children). */
export function registerScratchRoot(sessionId: string, rootSessionId: string): void {
  if (sessionId === rootSessionId) return;
  sharedMap(ROOTS_KEY).set(sessionId, rootSessionId);
}

export function unregisterScratchRoot(sessionId: string): void {
  sharedMap(ROOTS_KEY).delete(sessionId);
  sharedMap(PREVIOUS_KEY).delete(sessionId);
}

/**
 * Lineage root of a session: an inherited `PI_ROOT_SESSION_ID`, else the registered root of a subagent
 * child, else the session itself.
 */
export function scratchRootFor(
  sessionId: string,
  inherited: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const fromEnv = inherited[ROOT_SESSION_ENV];
  if (fromEnv) return fromEnv;
  return sharedMap(ROOTS_KEY).get(sessionId) ?? sessionId;
}

export function scratchDirForSession(
  sessionId: string,
  inherited: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return scratchDirFor(scratchRootFor(sessionId, inherited));
}

export function setPreviousScratchDir(sessionId: string, previousScratchDir: string): void {
  sharedMap(PREVIOUS_KEY).set(sessionId, previousScratchDir);
}

export type ScratchEnv = {
  PI_ROOT_SESSION_ID?: string;
  PI_SCRATCH_DIR?: string;
  PI_PREVIOUS_SCRATCH_DIR?: string;
};

/** Variables to add to a child process env; a value already present in `inherited` is never replaced. */
export function scratchEnv(
  sessionId: string,
  inherited: Readonly<Record<string, string | undefined>> = process.env,
): ScratchEnv {
  const env: ScratchEnv = {};
  if (!inherited[ROOT_SESSION_ENV]) env[ROOT_SESSION_ENV] = scratchRootFor(sessionId, inherited);
  if (!inherited[SCRATCH_DIR_ENV])
    env[SCRATCH_DIR_ENV] = scratchDirForSession(sessionId, inherited);
  const previous = sharedMap(PREVIOUS_KEY).get(sessionId);
  if (previous && !inherited[PREVIOUS_SCRATCH_DIR_ENV]) env[PREVIOUS_SCRATCH_DIR_ENV] = previous;
  return env;
}

export function scratchPromptLine(
  sessionId: string,
  inherited: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return `Scratch directory: ${scratchDirForSession(sessionId, inherited)}`;
}

export function scratchWarningText(destination: string, scratchDir: string): string {
  return (
    `Scratch path warning: ${destination} is outside this session's scratch directory ${scratchDir}. ` +
    `Use ${scratchDir} for temporary files unless the user granted this path.`
  );
}

export function scratchChangedNotice(previousScratchDir: string, scratchDir: string): string {
  return `Scratch directory changed: previous ${previousScratchDir}; use ${scratchDir} from now on. Nothing was moved or deleted.`;
}

/** Session id embedded in a Pi session file name (`<timestamp>_<id>.jsonl`). */
export function sessionIdFromFile(sessionFile: string): string | undefined {
  const stem = path.basename(sessionFile, ".jsonl");
  const separator = stem.lastIndexOf("_");
  const id = separator < 0 ? stem : stem.slice(separator + 1);
  return id || undefined;
}

export interface ScratchChange {
  previousScratchDir: string;
  scratchDir: string;
  notice: string;
}

/**
 * The notice owed after a fork or resume replaced the root session, or `undefined` when the scratch
 * directory is unchanged (same id, other reasons, or an inherited root).
 */
export function describeScratchChange(input: {
  reason: string;
  previousSessionFile?: string | undefined;
  currentSessionId: string;
  inherited?: Readonly<Record<string, string | undefined>>;
}): ScratchChange | undefined {
  if (input.reason !== "fork" && input.reason !== "resume") return undefined;
  if (!input.previousSessionFile) return undefined;
  const previousId = sessionIdFromFile(input.previousSessionFile);
  const resolution = resolveScratch({
    rootSessionId: scratchRootFor(input.currentSessionId, input.inherited),
    currentSessionId: input.currentSessionId,
    previousSessionId: previousId ? scratchRootFor(previousId, input.inherited) : undefined,
  });
  if (!resolution.previousScratchDir) return undefined;
  return {
    previousScratchDir: resolution.previousScratchDir,
    scratchDir: resolution.scratchDir,
    notice: scratchChangedNotice(resolution.previousScratchDir, resolution.scratchDir),
  };
}

function mapPrivateTmp(value: string): string {
  if (value === "/private/tmp") return "/tmp";
  return value.startsWith("/private/tmp/") ? value.slice("/private".length) : value;
}

/**
 * Absolute, normalised path with symlinks resolved on the deepest existing ancestor, and macOS
 * `/private/tmp` mapped to `/tmp`.
 */
export async function canonicalizePath(target: string, cwd: string): Promise<string> {
  const resolved = mapPrivateTmp(path.resolve(cwd, target));
  const pending: string[] = [];
  let ancestor = resolved;
  for (;;) {
    try {
      const real = await realpath(ancestor);
      return mapPrivateTmp(path.join(real, ...pending.toReversed()));
    } catch {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return resolved;
      pending.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

export function isUnderDirectory(candidate: string, directory: string): boolean {
  const base = directory.endsWith("/") ? directory.slice(0, -1) : directory;
  return candidate === base || candidate.startsWith(`${base}/`);
}

export interface ScratchDestination {
  path: string;
  /** True when `path` is itself a directory (a shell cwd); files are keyed by their parent. */
  directory: boolean;
}

const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/;

/** Destinations of the host write tools; other tool names yield none. */
export function scratchDestinations<Input>(toolName: string, input: Input): ScratchDestination[] {
  if (!isJsonRecord(input)) return [];
  const name = toolName.toLowerCase();
  if (name === "write" || name === "edit") {
    const target = [input["path"], input["file_path"]].find(isString);
    return target ? [{ path: target, directory: false }] : [];
  }
  if (name === "apply_patch") {
    const patch = [input["input"], input["patch"]].find(isString);
    if (!patch) return [];
    return patch.split(/\r?\n/).flatMap((line) => {
      const match = PATCH_HEADER.exec(line);
      const target = match?.[1]?.trim();
      return target ? [{ path: target, directory: false }] : [];
    });
  }
  if (name === "ast_grep_replace") {
    const paths = input["paths"];
    if (!Array.isArray(paths)) return [];
    return paths.filter(isString).map((target) => ({ path: target, directory: true }));
  }
  return [];
}

function settingsFiles(): string[] {
  const home = homedir();
  const agentDir = process.env["PI_CODING_AGENT_DIR"] ?? path.join(home, ".pi", "agent");
  return [
    path.join(home, ".claude", "settings.json"),
    path.join(home, ".agents", "settings.json"),
    path.join(agentDir, "settings.json"),
  ];
}

/**
 * Absolute directories the user granted for temporary files (`scratchGrants` in user-level settings).
 * Project settings are not read: a repository must not silence the warning for itself.
 */
export async function loadScratchGrants(
  files: readonly string[] = settingsFiles(),
): Promise<string[]> {
  const grants: string[] = [];
  for (const file of files) {
    let parsed: RuntimeValue;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch {
      continue;
    }
    if (!isJsonRecord(parsed)) continue;
    const value = parsed[SCRATCH_GRANTS_KEY];
    if (!Array.isArray(value)) continue;
    for (const entry of value)
      if (isString(entry) && path.isAbsolute(entry)) grants.push(path.normalize(entry));
  }
  return grants;
}

export interface ScratchCheck {
  sessionId: string;
  toolName: string;
  cwd: string;
  destinations: readonly ScratchDestination[];
}

export interface ScratchWarner {
  /** Warnings for destinations under /tmp but outside the scratch directory, once per (tool, directory). */
  check(call: ScratchCheck): Promise<string[]>;
  reset(): void;
}

export interface ScratchWarnerOptions {
  grants?: () => readonly string[] | Promise<readonly string[]>;
  inherited?: Readonly<Record<string, string | undefined>>;
}

export function createScratchWarner(options: ScratchWarnerOptions = {}): ScratchWarner {
  const seen = new Set<string>();
  async function evaluate(call: ScratchCheck): Promise<string[]> {
    if (call.destinations.length === 0) return [];
    const scratchDir = scratchDirForSession(call.sessionId, options.inherited);
    const scratch = await canonicalizePath(scratchDir, "/");
    const grants = await Promise.all(
      [...((await options.grants?.()) ?? [])].map((grant) => canonicalizePath(grant, "/")),
    );
    const warnings: string[] = [];
    for (const destination of call.destinations) {
      const target = await canonicalizePath(destination.path, call.cwd);
      if (!isUnderDirectory(target, "/tmp")) continue;
      if (isUnderDirectory(target, scratch)) continue;
      if (grants.some((grant) => isUnderDirectory(target, grant))) continue;
      const directory = destination.directory ? target : path.dirname(target);
      const key = `${call.sessionId}\0${call.toolName}\0${directory}`;
      if (seen.has(key)) continue;
      seen.add(key);
      warnings.push(scratchWarningText(target, scratchDir));
    }
    return warnings;
  }
  return {
    reset: () => seen.clear(),
    // A warning is advisory: failing to compute one must never fail the tool call it accompanies.
    check: (call) => evaluate(call).catch(() => []),
  };
}
