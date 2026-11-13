import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import { compile, obj, oneOf } from "@earendil-works/pi-schema";
import type {
  CommandHook,
  HookHandler,
  HookInput,
  HookOutput,
  HttpHook,
  JsonObject,
  JsonValue,
  ModelHook,
  MergedHookResult,
} from "./types.ts";
import {
  isBooleanValue,
  isStringValue,
  parseRuntimeRecord,
  type RuntimeValue,
} from "./validation.ts";

export interface ParsedHookOutput {
  output?: HookOutput;
  plainText?: string;
  validationError?: string;
}

export interface RawExecution {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}
export interface HookBackends {
  command?: (hook: CommandHook, input: HookInput, signal: AbortSignal) => Promise<RawExecution>;
  http?: (hook: HttpHook, input: HookInput, signal: AbortSignal) => Promise<RawExecution>;
  model?: (hook: ModelHook, input: HookInput, signal: AbortSignal) => Promise<RawExecution>;
  onAsyncResult?: (
    input: HookInput,
    result: MergedHookResult,
    rewake: boolean,
  ) => Promise<void> | void;
}

/** Internal input field naming the project root a session started in; never sent to hooks. */
export const PROJECT_DIR_FIELD = "_claude_project_dir";
const SESSION_END_DEFAULT_MS = 1_500;
const SESSION_END_MAX_MS = 60_000;

function timeoutFor(handler: HookHandler, event: HookInput["hook_event_name"]): number {
  if (handler.timeout !== undefined) return handler.timeout * 1000;
  if (handler.type === "prompt") return 30_000;
  if (handler.type === "agent") return 60_000;
  if (event === "UserPromptSubmit") return 30_000;
  if (event === "PreModelSwitch" || event === "PostModelSwitch") return 30_000;
  if (event === "MessageDisplay") return 10_000;
  if (event === "SessionEnd") return SESSION_END_DEFAULT_MS;
  return 600_000;
}

function sessionEndOverrideMs(): number | undefined {
  const configured = Number(process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : undefined;
}

/**
 * Per-handler timeouts for one SessionEnd run. The shared budget is 1.5 seconds,
 * raised to the highest per-hook `timeout` up to 60 seconds, or set outright by
 * `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`, which also becomes the default for
 * handlers without their own `timeout`.
 */
/** The shared SessionEnd budget for these handlers. */
export function sessionEndBudget(handlers: HookHandler[]): number {
  const configured = handlers.flatMap((handler) =>
    handler.timeout === undefined ? [] : [handler.timeout * 1000],
  );
  return (
    sessionEndOverrideMs() ??
    Math.min(SESSION_END_MAX_MS, Math.max(SESSION_END_DEFAULT_MS, ...configured))
  );
}

export function sessionEndTimeouts(handlers: HookHandler[]): Map<HookHandler, number> {
  const override = sessionEndOverrideMs();
  const budget = sessionEndBudget(handlers);
  return new Map(
    handlers.map((handler) => [
      handler,
      Math.min(
        budget,
        handler.timeout === undefined
          ? (override ?? SESSION_END_DEFAULT_MS)
          : handler.timeout * 1000,
      ),
    ]),
  );
}

/** The JSON a hook receives: the input without host-internal fields. */
export function hookPayload(input: HookInput): string {
  const { [PROJECT_DIR_FIELD]: _projectDir, ...payload } = input;
  return JSON.stringify(payload);
}

function projectDirOf(input: HookInput): string {
  const projectDir = input[PROJECT_DIR_FIELD];
  return isStringValue(projectDir) && projectDir ? projectDir : input.cwd;
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Command hooks run in the current directory; when it no longer exists they run
 * from the first that does of the session's start directory, home, or temp.
 */
async function commandDirectory(input: HookInput): Promise<string> {
  for (const candidate of [input.cwd, projectDirOf(input), os.homedir()])
    if (candidate && (await isDirectory(candidate))) return candidate;
  return os.tmpdir();
}

export function substitute(value: JsonValue, input: JsonObject): JsonValue {
  if (isStringValue(value))
    return value.replace(/\$\{([^}]+)\}/g, (_whole, path: string) => {
      let cursor: JsonValue | undefined = input;
      for (const segment of path.split(".")) {
        if (segment === "__proto__" || segment === "prototype" || segment === "constructor")
          return "";
        if (!(cursor instanceof Object) || Array.isArray(cursor)) return "";
        cursor = cursor[segment];
      }
      return cursor === undefined || cursor instanceof Object
        ? JSON.stringify(cursor ?? "")
        : String(cursor);
    });
  if (Array.isArray(value)) return value.map((item) => substitute(item, input));
  if (value instanceof Object)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        item === undefined ? undefined : substitute(item, input),
      ]),
    );
  return value;
}

/**
 * A write that failed only because the child closed its end of stdin before
 * reading it. `EPIPE` is the common case; macOS reports `ENOTCONN` when the
 * peer socket is already gone, and `ECONNRESET` appears on some kernels.
 * Node reports `ERR_STREAM_DESTROYED` once the stream itself is torn down.
 */
const isStdinClosedCode = compile(
  obj({ code: oneOf(["EPIPE", "ENOTCONN", "ECONNRESET", "ERR_STREAM_DESTROYED"]) }, { open: true }),
).check;

function isStdinClosedByChild(error: Error): boolean {
  return isStdinClosedCode(error);
}

function runCommand(
  hook: CommandHook,
  input: HookInput,
  signal: AbortSignal,
): Promise<RawExecution> {
  const payload = hookPayload(input);
  const projectDir = projectDirOf(input);
  return commandDirectory(input).then((cwd) =>
    spawnCommand(hook, input, signal, payload, projectDir, cwd),
  );
}

function spawnCommand(
  hook: CommandHook,
  input: HookInput,
  signal: AbortSignal,
  payload: string,
  projectDir: string,
  cwd: string,
): Promise<RawExecution> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
    if (isStringValue(input._claude_env_file)) env.CLAUDE_ENV_FILE = input._claude_env_file;
    if (input.effort) env.CLAUDE_EFFORT = input.effort.level;
    const execForm = hook.args !== undefined;
    let command = hook.command.replaceAll("${CLAUDE_PROJECT_DIR}", projectDir);
    let args = hook.args?.map((arg) => arg.replaceAll("${CLAUDE_PROJECT_DIR}", projectDir));
    if (!execForm) {
      if (hook.shell === "powershell") {
        args = ["-NoProfile", "-Command", command];
        command = process.platform === "win32" ? "powershell.exe" : "pwsh";
      } else {
        args = ["-c", command];
        command = process.platform === "win32" ? "bash" : "sh";
      }
    }
    const child = spawn(command, args ?? [], {
      cwd,
      env,
      signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const stdinErrors = new Set<Error>();
    const settle = (exitCode: number) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, stdout, stderr });
    };
    const onStdinError = (error: Error | null | undefined) => {
      if (!error || settled || stdinErrors.has(error)) return;
      stdinErrors.add(error);
      if (isStdinClosedByChild(error)) return;
      stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}Hook stdin: ${error.message}\n`;
    };
    child.stdin.on("error", onStdinError);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      stderr ||= error.message;
      settle(1);
    });
    child.on("close", (code) => settle(code ?? 1));
    child.stdin.write(payload, onStdinError);
    child.stdin.end();
  });
}

async function runHttp(
  hook: HttpHook,
  input: HookInput,
  signal: AbortSignal,
): Promise<RawExecution> {
  const allowed = new Set(hook.allowedEnvVars ?? []);
  const headers = Object.fromEntries(
    Object.entries(hook.headers ?? {}).map(([key, value]) => [
      key,
      value.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_whole, name: string) =>
        allowed.has(name) ? (process.env[name] ?? "") : "",
      ),
    ]),
  );
  const response = await fetch(hook.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: hookPayload(input),
    signal,
  });
  const stdout = await response.text();
  return {
    exitCode: response.ok ? 0 : 1,
    stdout,
    stderr: response.ok ? "" : `HTTP ${response.status}`,
  };
}

const OUTPUT_FIELDS = new Set([
  "continue",
  "stopReason",
  "suppressOutput",
  "systemMessage",
  "terminalSequence",
  "decision",
  "reason",
  "hookSpecificOutput",
]);

function parseJson(text: string): { value: RuntimeValue } | undefined {
  try {
    const value: RuntimeValue = JSON.parse(text);
    return { value };
  } catch {
    return undefined;
  }
}

/**
 * Stdout that does not parse as one object. Two or more lines that each parse
 * on their own are plain text unless one of them is an output object that sets
 * a field; everything else is a parse failure.
 */
function unparsedOutput(trimmed: string, stdout: string): ParsedHookOutput {
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim());
  const failure = { validationError: "hook output is not valid JSON" };
  if (lines.length < 2) return failure;
  const values: RuntimeValue[] = [];
  for (const line of lines) {
    const parsed = parseJson(line);
    if (!parsed) return failure;
    values.push(parsed.value);
  }
  const setsField = values.some((value) => {
    const record = parseRuntimeRecord(value);
    return record !== undefined && Object.keys(record).some((key) => OUTPUT_FIELDS.has(key));
  });
  return setsField
    ? { validationError: "print the hook output object with nothing else on stdout" }
    : { plainText: stdout };
}

export function parseOutput(stdout: string): ParsedHookOutput {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return { plainText: stdout };
  const parsed = parseJson(trimmed);
  if (!parsed) return unparsedOutput(trimmed, stdout);
  if (!parseRuntimeRecord(parsed.value))
    return { validationError: "hook output must be a JSON object" };
  // SAFETY: JSON parsing plus parseRuntimeRecord establishes the HookOutput property-bag representation.
  const output = parsed.value as HookOutput;
  const booleanFields = [
    [output.continue, "continue"],
    [output.suppressOutput, "suppressOutput"],
  ] as const;
  for (const [field, name] of booleanFields)
    if (field !== undefined && !isBooleanValue(field))
      return { validationError: `${name} must be boolean` };
  const stringFields = [
    [output.stopReason, "stopReason"],
    [output.systemMessage, "systemMessage"],
    [output.terminalSequence, "terminalSequence"],
    [output.reason, "reason"],
  ] as const;
  for (const [field, name] of stringFields)
    if (field !== undefined && !isStringValue(field))
      return { validationError: `${name} must be string` };
  if (output.decision !== undefined && output.decision !== "block")
    return { validationError: 'decision must be "block"' };
  if (output.hookSpecificOutput !== undefined && !parseRuntimeRecord(output.hookSpecificOutput))
    return { validationError: "hookSpecificOutput must be an object" };
  return { output };
}

/**
 * An async hook's response is either alone on stdout, possibly across several
 * lines, or on one line of its own among other output.
 */
export function parseAsyncOutput(stdout: string): ParsedHookOutput {
  const whole = parseOutput(stdout);
  if (whole.output) return whole;
  for (const line of stdout.split(/\r?\n/).reverse()) {
    const candidate = line.trim();
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
    const parsed = parseOutput(candidate);
    if (parsed.output) return parsed;
  }
  return whole;
}

function runsWithoutTimeout(handler: HookHandler): boolean {
  return handler.type === "command" && handler.async === true && handler.asyncRewake !== true;
}

export async function executeHandler(
  handler: HookHandler,
  input: HookInput,
  backends: HookBackends = {},
  timeoutMs?: number,
  cancel?: AbortSignal,
): Promise<RawExecution> {
  const controller = new AbortController();
  // Teardown cancellation ends a run that its timeout does not bound.
  const onCancel = () => controller.abort();
  if (cancel?.aborted) controller.abort();
  else cancel?.addEventListener("abort", onCancel, { once: true });
  // A background command hook is not bounded by its timeout; `asyncRewake` still is.
  const timer = runsWithoutTimeout(handler)
    ? undefined
    : setTimeout(() => controller.abort(), timeoutMs ?? timeoutFor(handler, input.hook_event_name));
  try {
    let result: RawExecution;
    if (handler.type === "command")
      result = await (backends.command ?? runCommand)(handler, input, controller.signal);
    else if (handler.type === "http")
      result = await (backends.http ?? runHttp)(handler, input, controller.signal);
    else if (handler.type === "mcp_tool") {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          "MCP hook backend is unavailable: choco-pi uses Pi's built-in MCP, which exposes tool execution only inside tool calls; use a command hook instead",
      };
    } else {
      if (!backends.model)
        return {
          exitCode: 1,
          stdout: "",
          stderr: `${handler.type} hook backend is not configured`,
        };
      const prompt = handler.prompt.includes("$ARGUMENTS")
        ? handler.prompt.replaceAll("$ARGUMENTS", hookPayload(input))
        : `${handler.prompt}\n${hookPayload(input)}`;
      result = await backends.model({ ...handler, prompt }, input, controller.signal);
    }
    return controller.signal.aborted ? { ...result, timedOut: true } : result;
  } catch (error) {
    if (controller.signal.aborted)
      return { exitCode: 1, stdout: "", stderr: "Hook timed out", timedOut: true };
    return {
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    cancel?.removeEventListener("abort", onCancel);
  }
}
