import crypto from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { loadHookSources } from "./config.ts";
import { createPiHookBackends } from "./backends.ts";
import { HookEngine } from "./engine.ts";
import type { HookEventName, HookInput, HookSource, JsonObject } from "./types.ts";
import { registerSupplementalEvents } from "./supplemental-events.ts";
import { createHookWatchers, type HookWatchers } from "./watchers.ts";
import { applyHookEnvironment, hookEnvironmentFile, removeHookEnvironment } from "./environment.ts";
import { registerClaudeTaskTools } from "./tasks.ts";
import { isStringValue, type RuntimeValue } from "./validation.ts";
import { isStaleContextError, rethrowUnlessStaleContext } from "./lifecycle.ts";

const TOOL_NAMES = new Map([
  ["bash", "Bash"],
  ["read", "Read"],
  ["edit", "Edit"],
  ["write", "Write"],
  ["grep", "Grep"],
  ["find", "Glob"],
  ["ls", "Glob"],
]);

function claudeToolName(name: string): string {
  return TOOL_NAMES.get(name) ?? name;
}
function sourceForStart(reason: string): string {
  if (reason === "fork") return "fork";
  if (reason === "resume") return "resume";
  return "startup";
}
function endReason(reason: string): string {
  return reason === "resume" ? "resume" : "other";
}
function textOf(message: AgentMessage | undefined): string {
  if (!message || message.role !== "assistant") return "";
  return message.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("");
}

function stopFailureType(message: string): string {
  if (/rate.?limit/i.test(message)) return "rate_limit";
  if (/overload|service unavailable/i.test(message)) return "overloaded";
  if (/auth|unauthorized|forbidden/i.test(message)) return "authentication_failed";
  if (/billing|payment/i.test(message)) return "billing_error";
  if (/model.+not found/i.test(message)) return "model_not_found";
  if (/max(?:imum)? output|output tokens/i.test(message)) return "max_output_tokens";
  if (/invalid request/i.test(message)) return "invalid_request";
  if (/server error/i.test(message)) return "server_error";
  return "unknown";
}

export default function chocoPiHooks(pi: ExtensionAPI): void {
  pi.registerFlag("init-only", { description: "Run Setup hooks and exit", type: "boolean" });
  pi.registerFlag("init", { description: "Run Setup hooks before print mode", type: "boolean" });
  pi.registerFlag("maintenance", {
    description: "Run maintenance Setup hooks before print mode",
    type: "boolean",
  });
  let engine = new HookEngine([]);
  let sessionId: string = crypto.randomUUID();
  let transcriptPath = "";
  let stopHookActive = false;
  let stopHookBlocks = 0;
  let watchers: HookWatchers | undefined;
  let currentSources: HookSource[] = [];
  let envFile = hookEnvironmentFile(sessionId);
  let lastCwd = "";

  function reload(ctx: ExtensionContext): void {
    const loaded = loadHookSources({ cwd: ctx.cwd });
    currentSources =
      ctx.mode === "tui" && !ctx.isProjectTrusted()
        ? loaded.sources.filter((source) => source.kind === "managed")
        : loaded.sources;
    engine = new HookEngine(currentSources, createPiHookBackends(pi));
    watchers?.replaceSources(currentSources);
    sessionId = ctx.sessionManager.getSessionId() || sessionId;
    envFile = hookEnvironmentFile(sessionId);
    transcriptPath = ctx.sessionManager.getSessionFile() ?? "";
  }
  function input(event: HookEventName, ctx: ExtensionContext, extra: JsonObject = {}): HookInput {
    // SAFETY: Required common fields are set here and extra is a JSON event-specific property bag.
    const hookInput = {
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: ctx.cwd,
      hook_event_name: event,
      permission_mode: "default",
      _claude_env_file: envFile,
      ...extra,
    } as HookInput;
    if (ctx.thinkingLevel === "minimal") hookInput.effort = { level: "low" };
    else if (ctx.thinkingLevel && ctx.thinkingLevel !== "off")
      hookInput.effort = { level: ctx.thinkingLevel };
    return hookInput;
  }
  function notify(ctx: ExtensionContext, messages: string[]): void {
    if (ctx.hasUI) for (const message of messages) ctx.ui.notify(message, "warning");
  }
  function replaceToolInput(target: ToolCallEvent["input"], replacement: JsonObject): void {
    // SAFETY: ToolCallEvent input variants are mutable JSON property bags at this documented Pi boundary.
    const mutable = target as JsonObject;
    for (const key of Object.keys(mutable)) delete mutable[key];
    Object.assign(target, replacement);
  }
  const dispatch = async (event: HookEventName, ctx: ExtensionContext, extra: JsonObject = {}) => {
    const hookInput = input(event, ctx, extra);
    const mode = ctx.mode;
    const result = await engine.run(hookInput);
    if (mode === "tui")
      for (const sequence of result.terminalSequences) process.stdout.write(sequence);
    if (event === "SessionStart" || event === "CwdChanged" || event === "FileChanged")
      applyHookEnvironment(envFile);
    return result;
  };
  const ensureCwd = async (ctx: ExtensionContext): Promise<void> => {
    if (!lastCwd) {
      lastCwd = ctx.cwd;
      return;
    }
    if (lastCwd === ctx.cwd) return;
    const oldCwd = lastCwd;
    lastCwd = ctx.cwd;
    const result = await dispatch("CwdChanged", ctx, { old_cwd: oldCwd, new_cwd: ctx.cwd });
    notify(ctx, result.systemMessages);
    if (result.watchPaths) watchers?.replaceDynamicPaths(result.watchPaths);
  };
  const supplemental = registerSupplementalEvents(pi, dispatch);
  registerClaudeTaskTools(pi, dispatch);
  pi.registerCommand("hooks", {
    description: "Browse configured Claude-compatible hooks",
    handler: async (_args, ctx) => {
      const rows = currentSources.flatMap((source) =>
        Object.entries(source.hooks).flatMap(([event, groups]) =>
          (groups ?? []).flatMap((group) =>
            group.hooks.map(
              (handler) =>
                `${event} ${group.matcher ?? "*"} [${handler.type}] (${source.kind}: ${source.id})`,
            ),
          ),
        ),
      );
      if (!rows.length) {
        ctx.ui.notify("No hooks configured", "info");
        return;
      }
      await ctx.ui.select("Configured hooks (read-only)", rows);
    },
  });
  pi.registerCommand("add-dir", {
    description: "Add a working directory and run DirectoryAdded hooks",
    handler: async (args, ctx) => {
      const directory = args.trim();
      if (!directory) {
        ctx.ui.notify("Usage: /add-dir <path>", "warning");
        return;
      }
      await dispatch("DirectoryAdded", ctx, {
        directory,
        source: "slash_command",
      });
    },
  });
  const removeDirectoryAddedListener = pi.events.on(
    "choco-pi-hooks:register-repo-root",
    async (payload) => {
      if (!(payload instanceof Object) || Array.isArray(payload)) return;
      // SAFETY: The SDK bridge supplies a directory string and optional callback; each is checked below.
      const request = payload as { directory?: unknown; done?: unknown };
      if (Object.prototype.toString.call(request.directory) !== "[object String]") return;
      let completed = false;
      const complete = (): void => {
        if (completed) return;
        completed = true;
        if (request.done instanceof Function) request.done();
      };
      const ctx = supplemental.getContext();
      if (!ctx) {
        complete();
        return;
      }
      try {
        await dispatch("DirectoryAdded", ctx, {
          directory: String(request.directory),
          source: "register_repo_root",
        });
      } catch (error: unknown) {
        // SAFETY: Caught JavaScript values are valid RuntimeValue inputs for lifecycle classification.
        rethrowUnlessStaleContext(error as RuntimeValue);
      } finally {
        complete();
      }
    },
  );
  const removeWorktreeListener = pi.events.on("subagents:worktree-remove", async (payload) => {
    if (!(payload instanceof Object) || Array.isArray(payload)) return;
    // SAFETY: The subagent bridge supplies a path and lifecycle callbacks; members are checked before use.
    const request = payload as { path?: unknown; claim?: unknown; done?: unknown };
    if (
      Object.prototype.toString.call(request.path) !== "[object String]" ||
      !(request.claim instanceof Function) ||
      !(request.done instanceof Function)
    )
      return;
    const ctx = supplemental.getContext();
    if (!ctx) return;
    // SAFETY: The preceding instanceof Function check validates this lifecycle callback.
    const claim = request.claim as () => void;
    // SAFETY: The preceding instanceof Function check validates this lifecycle callback.
    const done = request.done as () => void;
    claim();
    let completed = false;
    const complete = (): void => {
      if (completed) return;
      completed = true;
      done();
    };
    try {
      await dispatch("WorktreeRemove", ctx, { worktree_path: String(request.path) });
    } catch (error: unknown) {
      // SAFETY: Caught JavaScript values are valid RuntimeValue inputs for lifecycle classification.
      if (!isStaleContextError(error as RuntimeValue)) throw error;
    } finally {
      complete();
    }
  });
  let externalProducersDisposed = false;

  const disposeExternalProducers = (): void => {
    if (externalProducersDisposed) return;
    externalProducersDisposed = true;
    watchers?.dispose();
    watchers = undefined;
    supplemental.dispose();
    removeDirectoryAddedListener();
    removeWorktreeListener();
  };

  pi.on("session_start", async (event, ctx) => {
    watchers?.dispose();
    watchers = undefined;
    reload(ctx);
    lastCwd = ctx.cwd;
    supplemental.setContext(ctx);
    let setupTrigger: "maintenance" | "init" | undefined;
    if (pi.getFlag("maintenance")) setupTrigger = "maintenance";
    else if (pi.getFlag("init-only") || pi.getFlag("init")) setupTrigger = "init";
    if (setupTrigger) {
      await dispatch("Setup", ctx, { trigger: setupTrigger });
      if (supplemental.getContext() !== ctx) return;
    }
    const result = await dispatch("SessionStart", ctx, {
      source: sourceForStart(event.reason),
      model: ctx.model?.id,
    });
    if (supplemental.getContext() !== ctx) return;
    notify(ctx, result.systemMessages);
    watchers = createHookWatchers({
      cwd: ctx.cwd,
      ctx,
      sources: currentSources,
      dispatch,
      onAllowedConfigChange: () => reload(ctx),
    });
    if (result.watchPaths) watchers.replaceDynamicPaths(result.watchPaths);
    if (result.sessionTitle) pi.setSessionName(result.sessionTitle);
    if (result.initialUserMessage) pi.sendUserMessage(result.initialUserMessage);
    if (result.additionalContext.length)
      pi.sendMessage({
        customType: "choco-pi-hooks",
        content: result.additionalContext.join("\n"),
        display: false,
      });
    if (pi.getFlag("init-only")) ctx.shutdown();
  });
  pi.on("input", async (event, ctx) => {
    supplemental.setContext(ctx);
    await ensureCwd(ctx);
    if (event.source === "extension") return { action: "continue" };
    const expansion = event.text.match(/^\/([^\s]+)(?:\s+(.*))?$/s);
    let expansionContext = "";
    if (expansion) {
      const expansionResult = await dispatch("UserPromptExpansion", ctx, {
        expansion_type: "slash_command",
        command_name: expansion[1],
        command_args: expansion[2] ?? "",
        command_source: "user",
        prompt: event.text,
      });
      if (expansionResult.blocked || !expansionResult.continue) {
        if (expansionResult.reason && ctx.hasUI) ctx.ui.notify(expansionResult.reason, "warning");
        return { action: "handled" } as const;
      }
      expansionContext = expansionResult.additionalContext.join("\n");
    }
    const result = await dispatch("UserPromptSubmit", ctx, { prompt: event.text });
    notify(ctx, result.systemMessages);
    if (result.blocked || !result.continue) {
      if (result.reason && ctx.hasUI) ctx.ui.notify(result.reason, "warning");
      return { action: "handled" } as const;
    }
    const promptContext = [expansionContext, ...result.additionalContext].filter(Boolean);
    if (promptContext.length)
      return {
        action: "transform",
        text: `${event.text}\n\n<hook_context>\n${promptContext.join("\n")}\n</hook_context>`,
        images: event.images,
      } as const;
    return { action: "continue" } as const;
  });
  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    await ensureCwd(ctx);
    if (event.toolName === "Agent" && event.input.isolation === "worktree") {
      const created = await dispatch("WorktreeCreate", ctx, {
        name:
          Object.prototype.toString.call(event.input.name) === "[object String]"
            ? String(event.input.name)
            : `agent-${event.toolCallId.slice(0, 8)}`,
      });
      if (created.invocations.length > 0) {
        if (created.blocked || !created.worktreePath)
          return { block: true, reason: created.reason ?? "WorktreeCreate hook returned no path" };
        event.input.__choco_hook_worktree_path = created.worktreePath;
      }
    }
    const result = await dispatch("PreToolUse", ctx, {
      tool_name: claudeToolName(event.toolName),
      // SAFETY: Pi tool inputs are JSON argument property bags.
      tool_input: event.input as JsonObject,
      tool_use_id: event.toolCallId,
    });
    notify(ctx, result.systemMessages);
    if (
      result.updatedInput &&
      result.permissionDecision !== "deny" &&
      result.permissionDecision !== "defer"
    )
      replaceToolInput(event.input, result.updatedInput);
    if (result.blocked || result.permissionDecision === "deny" || !result.continue)
      return {
        block: true,
        reason: result.reason ?? "Blocked by hook",
        terminate: !result.continue,
      };
  });
  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    const name = event.isError ? "PostToolUseFailure" : "PostToolUse";
    const extra: JsonObject = {
      tool_name: claudeToolName(event.toolName),
      // SAFETY: Pi tool inputs are JSON argument property bags.
      tool_input: event.input as JsonObject,
      tool_use_id: event.toolCallId,
    };
    if (event.isError)
      extra.error = event.content
        .flatMap((item) => (item.type === "text" ? [item.text] : []))
        .join("\n");
    else {
      // SAFETY: Pi tool result content/details are JSON-serializable hook response values.
      extra.tool_response = { content: event.content as never, details: event.details as never };
    }
    const result = await dispatch(name, ctx, extra);
    notify(ctx, result.systemMessages);
    const appended = result.additionalContext.map((value) => ({
      type: "text" as const,
      text: value,
    }));
    if (result.updatedToolOutput !== undefined)
      return {
        content: [
          {
            type: "text",
            text: isStringValue(result.updatedToolOutput)
              ? result.updatedToolOutput
              : JSON.stringify(result.updatedToolOutput),
          },
          ...appended,
        ],
      };
    if (appended.length) return { content: [...event.content, ...appended] };
  });
  pi.on("session_before_compact", async (event, ctx) => {
    const result = await dispatch("PreCompact", ctx, {
      trigger: event.reason === "manual" ? "manual" : "auto",
      custom_instructions: event.customInstructions ?? "",
    });
    if (result.blocked || !result.continue) return { cancel: true };
  });
  pi.on("session_compact", async (event, ctx) => {
    await dispatch("PostCompact", ctx, {
      trigger: event.reason === "manual" ? "manual" : "auto",
      compact_summary: event.compactionEntry.summary,
    });
  });
  pi.on("agent_end", async (event, ctx) => {
    const last = event.messages.findLast((message) => message.role === "assistant");
    if (last?.role === "assistant" && last.stopReason === "error") {
      const errorText = last.errorMessage ?? textOf(last);
      await dispatch("StopFailure", ctx, {
        error: stopFailureType(errorText),
        error_details: errorText,
        last_assistant_message: errorText,
      });
      stopHookActive = false;
      return;
    }
    const result = await dispatch("Stop", ctx, {
      stop_hook_active: stopHookActive,
      last_assistant_message: textOf(last),
      background_tasks: supplemental.getBackgroundTasks(),
      session_crons: [],
    });
    notify(ctx, result.systemMessages);
    if (result.blocked && result.reason) {
      const configuredCap = Number(process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP ?? 8);
      const cap = Number.isSafeInteger(configuredCap) && configuredCap > 0 ? configuredCap : 8;
      stopHookBlocks += 1;
      if (stopHookBlocks < cap) {
        stopHookActive = true;
        pi.sendUserMessage(result.reason, { deliverAs: "followUp" });
      } else stopHookActive = false;
    } else if (result.additionalContext.length) {
      stopHookActive = true;
      stopHookBlocks += 1;
      pi.sendUserMessage(result.additionalContext.join("\n"), { deliverAs: "followUp" });
    } else {
      stopHookActive = false;
      stopHookBlocks = 0;
    }
  });
  pi.on("session_shutdown", async (event, ctx) => {
    disposeExternalProducers();
    await dispatch("SessionEnd", ctx, { reason: endReason(event.reason) });
    await engine.waitForBackground();
    removeHookEnvironment(envFile);
  });
}
