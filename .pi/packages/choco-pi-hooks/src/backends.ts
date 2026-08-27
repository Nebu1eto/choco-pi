import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HookBackends, RawExecution } from "./executor.ts";
import type { HookInput, McpToolHook, ModelHook } from "./types.ts";

interface McpHookRequest {
  server: string;
  tool: string;
  input: McpToolHook["input"];
  signal: AbortSignal;
  resolve(result: RawExecution): void;
}

function runPiEvaluator(
  hook: ModelHook,
  input: HookInput,
  signal: AbortSignal,
): Promise<RawExecution> {
  return new Promise((resolve) => {
    const executable = process.env.CHOCO_PI_HOOKS_PI_BIN || "pi";
    const args = [
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-session",
      "--system-prompt",
      'Evaluate the supplied hook condition. Return only one JSON object: {"ok":true} or {"ok":false,"reason":"..."}.',
    ];
    if (hook.type === "prompt") args.push("--no-tools");
    else args.push("--tools", "read,grep,find,ls,bash");
    if (hook.model) args.push("--model", hook.model);
    args.push("--print", hook.prompt);
    const child = spawn(executable, args, {
      cwd: input.cwd,
      env: { ...process.env, CHOCO_PI_HOOK_EVALUATOR: "1" },
      signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ exitCode: 1, stdout, stderr: stderr || error.message });
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function runMcpHook(
  pi: ExtensionAPI,
  hook: McpToolHook,
  _input: HookInput,
  signal: AbortSignal,
): Promise<RawExecution> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ exitCode: 1, stdout: "", stderr: "Hook aborted" });
      return;
    }
    let settled = false;
    const finish = (result: RawExecution): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => finish({ exitCode: 1, stdout: "", stderr: "Hook aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
    const request: McpHookRequest = {
      server: hook.server,
      tool: hook.tool,
      input: hook.input,
      signal,
      resolve: finish,
    };
    pi.events.emit("choco-pi-hooks:mcp-call", request);
  });
}

export function createPiHookBackends(pi: ExtensionAPI): HookBackends {
  return {
    model: runPiEvaluator,
    mcpTool: (hook, input, signal) => runMcpHook(pi, hook, input, signal),
    onAsyncResult: (_input, result, rewake) => {
      const content = [...result.additionalContext, ...result.systemMessages].join("\n");
      if (!content && !rewake) return;
      if (rewake) {
        pi.sendUserMessage(content || result.reason || "An async hook requested attention.", {
          deliverAs: "followUp",
        });
        return;
      }
      pi.sendMessage(
        { customType: "choco-pi-hooks-async", content, display: false },
        { triggerTurn: false, deliverAs: "nextTurn" },
      );
    },
  };
}

export type { McpHookRequest };
