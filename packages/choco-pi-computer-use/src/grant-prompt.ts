import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { rethrowUnlessStaleContext } from "@choco-pi/shared/lifecycle";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  denyForSession,
  foregroundPromptMode,
  getLoadedComputerUseConfig,
  grantForSession,
  isSessionDenied,
  normalizeBundleId,
  sessionGrantGeneration,
  setSessionForegroundPromptMode,
  userComputerUseConfigPath,
  type ComputerUseConfig,
  type ForegroundPromptMode,
} from "./config.ts";
import { isJsonObject, isString, type JsonObject, type JsonValue } from "./json.ts";

export const GRANT_OPTION_SESSION = "Allow for this session";
export const GRANT_OPTION_ALWAYS = "Always allow (saves to user config)";
export const GRANT_OPTION_DENY = "Not now";

export interface GrantPromptTarget {
  bundleId?: string;
  appName: string;
}

export interface GrantPromptRefusal {
  action: string;
  capability: string;
  pidPointerAttempted?: boolean;
}

export function notifyUnlessStale(
  ui: ExtensionContext["ui"],
  message: string,
  level: "info" | "warning" | "error",
): void {
  try {
    ui.notify(message, level);
  } catch (error) {
    rethrowUnlessStaleContext(error);
  }
}

export type GrantPromptSkipReason =
  | "no_ui"
  | "not_tui"
  | "prompt_off"
  | "no_bundle_id"
  | "session_denied"
  | "aborted"
  | "stale_session";

export type PersistOutcome =
  | { persisted: true; path: string; shadowedBy?: string[] }
  | { persisted: false; path: string; error: string };

export type GrantPromptOutcome =
  | { decision: "skipped"; reason: GrantPromptSkipReason }
  | { decision: "denied" }
  | { decision: "session" }
  | { decision: "auto" }
  | ({ decision: "always" } & PersistOutcome);

export function grantPromptGranted(outcome: GrantPromptOutcome): boolean {
  return (
    outcome.decision === "session" || outcome.decision === "always" || outcome.decision === "auto"
  );
}

const pendingPrompts = new Map<string, Promise<GrantPromptOutcome>>();
let persistChain: Promise<void> = Promise.resolve();

function skipped(reason: GrantPromptSkipReason): GrantPromptOutcome {
  return { decision: "skipped", reason };
}

async function untilAborted(
  shared: Promise<GrantPromptOutcome>,
  signal: AbortSignal | undefined,
): Promise<GrantPromptOutcome> {
  if (!signal) return await shared;
  if (signal.aborted) return skipped("aborted");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<GrantPromptOutcome>((resolve) => {
    onAbort = (): void => resolve(skipped("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([shared, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function promptForegroundGrant(
  ctx: ExtensionContext | undefined,
  target: GrantPromptTarget,
  refusal: GrantPromptRefusal,
  signal?: AbortSignal,
): Promise<GrantPromptOutcome> {
  const generation = sessionGrantGeneration();
  if (signal?.aborted) return skipped("aborted");
  const mode = foregroundPromptMode();
  if (mode === "off") return skipped("prompt_off");
  const bundleId = normalizeBundleId(target.bundleId);
  if (!bundleId) return skipped("no_bundle_id");
  if (mode === "always") {
    grantForSession(bundleId);
    return { decision: "auto" };
  }
  if (!ctx?.hasUI) return skipped("no_ui");
  if (ctx.mode !== "tui") return skipped("not_tui");
  if (isSessionDenied(bundleId)) return skipped("session_denied");
  const key = `${generation}\u0000${bundleId}`;
  let shared = pendingPrompts.get(key);
  if (!shared) {
    const created = askOnce(ctx, bundleId, target.appName, refusal, generation, signal);
    shared = created;
    pendingPrompts.set(key, created);
    const forget = (): void => {
      if (pendingPrompts.get(key) === created) pendingPrompts.delete(key);
    };
    created.then(forget, forget);
  }
  return await untilAborted(shared, signal);
}

async function askOnce(
  ctx: ExtensionContext,
  bundleId: string,
  appName: string,
  refusal: GrantPromptRefusal,
  generation: number,
  signal: AbortSignal | undefined,
): Promise<GrantPromptOutcome> {
  const ui = ctx.ui;
  const lines = [
    `Allow pi to bring ${appName} (${bundleId}) to the front and send keyboard and mouse input?`,
    `The ${refusal.action} action needs ${refusal.capability}, which background delivery cannot provide.`,
  ];
  if (refusal.pidPointerAttempted === true)
    lines.push(
      `pi already sent this ${refusal.action} to ${appName} as background input and saw no visible change. It is not sent again now: allowing lets pi's next action on ${appName} use foreground input after the current state is checked.`,
    );
  const title = lines.join("\n");
  const choice = await ui.select(
    title,
    [GRANT_OPTION_SESSION, GRANT_OPTION_ALWAYS, GRANT_OPTION_DENY],
    signal ? { signal } : undefined,
  );
  if (signal?.aborted) return skipped("aborted");
  if (sessionGrantGeneration() !== generation) return skipped("stale_session");
  if (choice === GRANT_OPTION_SESSION) {
    grantForSession(bundleId);
    return { decision: "session" };
  }
  if (choice === GRANT_OPTION_ALWAYS) {
    grantForSession(bundleId);
    const persisted = await persistUserGrant(bundleId);
    if (!persisted.persisted && sessionGrantGeneration() === generation)
      notifyUnlessStale(
        ui,
        `Foreground input for ${appName} is allowed for this session only: saving to ${persisted.path} failed (${persisted.error}).`,
        "warning",
      );
    return { decision: "always", ...persisted };
  }
  denyForSession(bundleId);
  return { decision: "denied" };
}

export async function updateUserConfig(
  mutate: (config: JsonObject) => string | undefined,
): Promise<PersistOutcome> {
  const run = persistChain.then(() => writeUserConfig(mutate));
  persistChain = run.then(
    () => undefined,
    () => undefined,
  );
  return await run;
}

async function writeUserConfig(
  mutate: (config: JsonObject) => string | undefined,
): Promise<PersistOutcome> {
  const filePath = userComputerUseConfigPath();
  const failed = (error: string): PersistOutcome => ({ persisted: false, path: filePath, error });
  let text: string | undefined;
  try {
    text = await readFile(filePath, "utf-8");
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (!missing)
      return failed(
        `could not read the config: ${error instanceof Error ? error.message : String(error)}`,
      );
  }
  let document: JsonObject = {};
  if (text !== undefined && text.trim().length > 0) {
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return failed(
        `the existing config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isJsonObject(parsed)) return failed("the existing config is not a JSON object");
    document = parsed;
  }
  const container = isJsonObject(document.computer_use) ? document.computer_use : document;
  const mutationError = mutate(container);
  if (mutationError) return failed(mutationError);
  const written = await replaceFileAtomically(filePath, `${JSON.stringify(document, null, 2)}\n`);
  if (written) return failed(`could not write the config: ${written}`);
  return { persisted: true, path: filePath };
}

async function replaceFileAtomically(
  filePath: string,
  content: string,
): Promise<string | undefined> {
  let destination = filePath;
  let mode: number | undefined;
  try {
    destination = await realpath(filePath);
    mode = (await stat(destination)).mode & 0o777;
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (!missing) return error instanceof Error ? error.message : String(error);
    const danglingTarget = await danglingSymlinkTarget(filePath);
    if (danglingTarget !== undefined) destination = danglingTarget;
  }
  const temp = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(temp, content, mode === undefined ? "utf-8" : { encoding: "utf-8", mode });
    await rename(temp, destination);
    return undefined;
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    return error instanceof Error ? error.message : String(error);
  }
}

async function danglingSymlinkTarget(filePath: string): Promise<string | undefined> {
  try {
    const info = await lstat(filePath);
    if (!info.isSymbolicLink()) return undefined;
    const target = await readlink(filePath);
    return path.resolve(path.dirname(filePath), target);
  } catch {
    return undefined;
  }
}

function mergedGrant(existing: JsonValue | undefined, bundleId: string): JsonValue[] | undefined {
  if (existing === undefined || existing === null) return [bundleId];
  let entries: JsonValue[];
  if (Array.isArray(existing)) entries = [...existing];
  else if (isString(existing))
    entries = existing
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  else return undefined;
  if (entries.some((entry) => isString(entry) && (entry.trim() === bundleId || entry === "*")))
    return entries;
  entries.push(bundleId);
  return entries;
}

export async function persistUserGrant(bundleId: string): Promise<PersistOutcome> {
  const outcome = await updateUserConfig((config) => {
    const merged = mergedGrant(config.foreground_grant, bundleId);
    if (!merged) return "the existing foreground_grant is neither a list nor a string";
    config.foreground_grant = merged;
    return undefined;
  });
  return withShadows(outcome, "foreground_grant");
}

export async function setForegroundPromptMode(mode: ForegroundPromptMode): Promise<PersistOutcome> {
  setSessionForegroundPromptMode(mode);
  const outcome = await updateUserConfig((config) => {
    config.foreground_prompt = mode;
    return undefined;
  });
  return withShadows(outcome, "foreground_prompt");
}

const ENV_NAMES = {
  foreground_grant: "PI_COMPUTER_USE_FOREGROUND_GRANT",
  foreground_prompt: "PI_COMPUTER_USE_FOREGROUND_PROMPT",
} satisfies Record<"foreground_grant" | "foreground_prompt", string>;

function withShadows(
  outcome: PersistOutcome,
  key: keyof Pick<ComputerUseConfig, "foreground_grant" | "foreground_prompt">,
): PersistOutcome {
  if (!outcome.persisted) return outcome;
  const loaded = getLoadedComputerUseConfig();
  const shadowedBy = loaded.sources
    .filter((source) => source.path !== outcome.path && source.values?.[key] !== undefined)
    .map((source) => source.path);
  if (loaded.env[key] !== undefined) shadowedBy.push(ENV_NAMES[key]);
  return shadowedBy.length > 0 ? { ...outcome, shadowedBy } : outcome;
}

export function describePersist(outcome: PersistOutcome): string {
  if (!outcome.persisted) return `not saved to ${outcome.path}: ${outcome.error}`;
  return outcome.shadowedBy
    ? `saved to ${outcome.path}, but ${outcome.shadowedBy.join(" and ")} overrides it in later sessions`
    : `saved to ${outcome.path}`;
}
