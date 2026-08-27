import { spawn } from "node:child_process";
import type {
  CommandHook,
  HookHandler,
  HookInput,
  HookOutput,
  HttpHook,
  JsonObject,
  JsonValue,
  McpToolHook,
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
  mcpTool?: (hook: McpToolHook, input: HookInput, signal: AbortSignal) => Promise<RawExecution>;
  model?: (hook: ModelHook, input: HookInput, signal: AbortSignal) => Promise<RawExecution>;
  onAsyncResult?: (
    input: HookInput,
    result: MergedHookResult,
    rewake: boolean,
  ) => Promise<void> | void;
}

function timeoutFor(handler: HookHandler, event: HookInput["hook_event_name"]): number {
  if (handler.timeout !== undefined) return handler.timeout * 1000;
  if (handler.type === "prompt") return 30_000;
  if (handler.type === "agent") return 60_000;
  if (event === "UserPromptSubmit") return 30_000;
  if (event === "MessageDisplay") return 10_000;
  if (event === "SessionEnd") return 1_500;
  return 600_000;
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

function runCommand(
  hook: CommandHook,
  input: HookInput,
  signal: AbortSignal,
): Promise<RawExecution> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: input.cwd };
    if (isStringValue(input._claude_env_file)) env.CLAUDE_ENV_FILE = input._claude_env_file;
    const execForm = hook.args !== undefined;
    let command = hook.command.replaceAll("${CLAUDE_PROJECT_DIR}", input.cwd);
    let args = hook.args?.map((arg) => arg.replaceAll("${CLAUDE_PROJECT_DIR}", input.cwd));
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
      cwd: input.cwd,
      env,
      signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ exitCode: 1, stdout, stderr: stderr || error.message }));
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
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
    body: JSON.stringify(input),
    signal,
  });
  const stdout = await response.text();
  return {
    exitCode: response.ok ? 0 : 1,
    stdout,
    stderr: response.ok ? "" : `HTTP ${response.status}`,
  };
}

export function parseOutput(stdout: string): ParsedHookOutput {
  const trimmed = stdout.trimStart();
  if (!trimmed.startsWith("{")) return { plainText: stdout };
  try {
    const value: RuntimeValue = JSON.parse(trimmed);
    if (!parseRuntimeRecord(value)) return { validationError: "hook output must be a JSON object" };
    // SAFETY: JSON parsing plus parseRuntimeRecord establishes the HookOutput property-bag representation.
    const output = value as HookOutput;
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
  } catch {
    return { plainText: stdout };
  }
}

export async function executeHandler(
  handler: HookHandler,
  input: HookInput,
  backends: HookBackends = {},
): Promise<RawExecution> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutFor(handler, input.hook_event_name));
  try {
    let result: RawExecution;
    if (handler.type === "command")
      result = await (backends.command ?? runCommand)(handler, input, controller.signal);
    else if (handler.type === "http")
      result = await (backends.http ?? runHttp)(handler, input, controller.signal);
    else if (handler.type === "mcp_tool") {
      if (!backends.mcpTool)
        return { exitCode: 1, stdout: "", stderr: "MCP hook backend is not connected" };
      const substituted = substitute(handler.input ?? {}, input);
      // SAFETY: An MCP handler input starts as a JsonObject and recursive substitution preserves that container.
      result = await backends.mcpTool(
        { ...handler, input: substituted as JsonObject },
        input,
        controller.signal,
      );
    } else {
      if (!backends.model)
        return {
          exitCode: 1,
          stdout: "",
          stderr: `${handler.type} hook backend is not configured`,
        };
      const prompt = handler.prompt.includes("$ARGUMENTS")
        ? handler.prompt.replaceAll("$ARGUMENTS", JSON.stringify(input))
        : `${handler.prompt}\n${JSON.stringify(input)}`;
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
  }
}
