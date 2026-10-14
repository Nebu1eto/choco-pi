import crypto from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import type {
  CompactionEntry,
  CustomToolCallEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { loadHookSources } from "./config.ts";
import { createPiHookBackends } from "./backends.ts";
import { HookEngine } from "./engine.ts";
import type { HookEventName, HookInput, HookSource, JsonObject } from "./types.ts";
import { type HookDispatch, registerSupplementalEvents } from "./supplemental-events.ts";
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

/**
 * Subagents run in the parent's process, so their hooks share its terminal and
 * environment. `root_session_id` names the top-level session a subagent
 * belongs to, letting hook consumers tell its events from the parent's. The
 * subagents registry is the identity source; it drops a child id before the
 * child's shutdown, so the answer is taken once at session_start.
 */
const SUBAGENTS_MANAGER_KEY = Symbol.for("pi-subagents:manager");
const SUBAGENT_SESSION_MARKER = "choco-pi:subagent";
const SESSION_ROOTS_KEY = Symbol.for("choco-pi-hooks:subagent-session-roots");
const ChildSessionRegistrySchema = Type.Object({
  isChildSessionId: Type.Function([Type.String()], Type.Boolean()),
});

function subagentSessionRoots(): Map<string, string> {
  // SAFETY: Symbol.for provides a process-wide slot that only this module writes, always with a Map.
  const slot = globalThis as typeof globalThis & { [SESSION_ROOTS_KEY]?: Map<string, string> };
  slot[SESSION_ROOTS_KEY] ??= new Map();
  return slot[SESSION_ROOTS_KEY];
}

function subagentRootSessionId(sessionId: string, ctx: ExtensionContext): string | undefined {
  const registry: unknown = Object.getOwnPropertyDescriptor(
    globalThis,
    SUBAGENTS_MANAGER_KEY,
  )?.value;
  if (!Value.Check(ChildSessionRegistrySchema, registry)) return undefined;
  if (registry.isChildSessionId(sessionId) !== true) return undefined;
  const marker = ctx.sessionManager
    .getEntries()
    .findLast((entry) => entry.type === "custom" && entry.customType === SUBAGENT_SESSION_MARKER);
  const data: unknown = marker?.type === "custom" ? marker.data : undefined;
  const parent =
    data instanceof Object && "parentSessionId" in data ? data.parentSessionId : undefined;
  if (!isStringValue(parent) || !parent) return undefined;
  // A nested subagent's parent is itself a subagent; resolve to the top level.
  return subagentSessionRoots().get(parent) ?? parent;
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

/**
 * Background-compaction adoption signal published by `choco-pi-compaction`.
 *
 * Background adoption does not run external PreCompact/PostCompact hooks.
 * A boundary adoption emits no host compaction event at all; the idle and
 * threshold routes emit a real session_before_compact/session_compact pair,
 * which the signal identifies by owner token and candidate ID so they are
 * skipped here. Host and manual compactions keep running each hook once. An
 * absent or foreign slot leaves hook behavior unchanged.
 */
const BACKGROUND_ADOPTION_SIGNAL = Symbol.for("choco-pi:compaction-background-adoption");
const AdoptionSignalSchema = Type.Object({
  version: Type.Literal(1),
  willAdopt: Type.Function([], Type.Unknown()),
  isAdoption: Type.Function([], Type.Unknown()),
});
interface AdoptionSignal {
  willAdopt(sessionId: string, event: SessionBeforeCompactEvent): Promise<boolean>;
  isAdoption(sessionId: string, entry: CompactionEntry): boolean;
}
function isAdoptionSignal<T>(value: T): value is T & AdoptionSignal {
  return Value.Check(AdoptionSignalSchema, value);
}
function adoptionSignal(): AdoptionSignal | undefined {
  const found: unknown = Object.getOwnPropertyDescriptor(
    globalThis,
    BACKGROUND_ADOPTION_SIGNAL,
  )?.value;
  return isAdoptionSignal(found) ? found : undefined;
}
/** Whether this compaction request is answered by a background adoption. */
async function isBackgroundAdoptionRequest(
  ctx: ExtensionContext,
  event: SessionBeforeCompactEvent,
): Promise<boolean> {
  const signal = adoptionSignal();
  if (!signal) return false;
  const sessionId = ctx.sessionManager.getSessionId();
  try {
    return (await signal.willAdopt(sessionId, event)) === true;
  } catch {
    // A failed decision cannot adopt; the hook runs as for any host compaction.
    return false;
  }
}
function isBackgroundAdoptionEntry(ctx: ExtensionContext, entry: CompactionEntry): boolean {
  const signal = adoptionSignal();
  if (!signal) return false;
  return signal.isAdoption(ctx.sessionManager.getSessionId(), entry) === true;
}

/** One read-only `/hooks` row per configured handler. */
function configuredHookRows(sources: HookSource[]): string[] {
  return sources.flatMap(sourceHookRows);
}
function sourceHookRows(source: HookSource): string[] {
  return Object.entries(source.hooks).flatMap(([event, groups]) =>
    (groups ?? []).flatMap((group) =>
      group.hooks.map(
        (handler) =>
          `${event} ${group.matcher ?? "*"} [${handler.type}] (${source.kind}: ${source.id})`,
      ),
    ),
  );
}
function warnBlockedReason(ctx: ExtensionContext, reason: string | undefined): void {
  if (reason && ctx.hasUI) ctx.ui.notify(reason, "warning");
}
/**
 * Run WorktreeCreate for an `Agent` call that asks for worktree isolation.
 * Returns a block result when a configured hook fails to supply a path.
 */
async function createHookWorktree(
  dispatch: HookDispatch,
  ctx: ExtensionContext,
  call: Pick<CustomToolCallEvent, "input" | "toolCallId">,
): Promise<{ block: true; reason: string } | undefined> {
  const { input, toolCallId } = call;
  const created = await dispatch("WorktreeCreate", ctx, {
    name:
      Object.prototype.toString.call(input.name) === "[object String]"
        ? String(input.name)
        : `agent-${toolCallId.slice(0, 8)}`,
  });
  if (created.invocations.length === 0) return undefined;
  if (created.blocked || !created.worktreePath)
    return { block: true, reason: created.reason ?? "WorktreeCreate hook returned no path" };
  input.__choco_hook_worktree_path = created.worktreePath;
  return undefined;
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
  let rootSessionId: string | undefined;
  let transcriptPath = "";
  let stopHookActive = false;
  let stopHookBlocks = 0;
  let stopTaskGeneration = 0;
  let watchers: HookWatchers | undefined;
  let currentSources: HookSource[] = [];
  let envFile = hookEnvironmentFile(sessionId);
  let lastCwd = "";
  let lifecycleGeneration = 0;
  let unregisterResourceCleanup: (() => void) | undefined;

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
    if (rootSessionId) hookInput.root_session_id = rootSessionId;
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
      const rows = configuredHookRows(currentSources);
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
      const mode = ctx.mode;
      await dispatch("DirectoryAdded", ctx, {
        directory,
        source: "slash_command",
      });
      // Hosts without the TUI otherwise get no confirmation at all.
      if (mode !== "tui") ctx.ui.notify(`Ran DirectoryAdded hooks for ${directory}.`, "info");
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
    lifecycleGeneration += 1;
    const unregister = unregisterResourceCleanup;
    unregisterResourceCleanup = undefined;
    unregister?.();
    watchers?.dispose();
    watchers = undefined;
    supplemental.dispose();
    removeDirectoryAddedListener();
    removeWorktreeListener();
  };

  pi.on("session_start", async (event, ctx) => {
    lifecycleGeneration += 1;
    const generation = lifecycleGeneration;
    watchers?.dispose();
    watchers = undefined;
    reload(ctx);
    rootSessionId = subagentRootSessionId(sessionId, ctx);
    if (rootSessionId) subagentSessionRoots().set(sessionId, rootSessionId);
    unregisterResourceCleanup?.();
    const ownedSessionId = sessionId;
    unregisterResourceCleanup = registerSessionResourceCleanup((cleanupSessionId) => {
      if (cleanupSessionId === undefined || cleanupSessionId === ownedSessionId)
        disposeExternalProducers();
    });
    lastCwd = ctx.cwd;
    supplemental.setContext(ctx);
    const generationToken = supplemental.captureGeneration();
    let setupTrigger: "maintenance" | "init" | undefined;
    if (pi.getFlag("maintenance")) setupTrigger = "maintenance";
    else if (pi.getFlag("init-only") || pi.getFlag("init")) setupTrigger = "init";
    if (setupTrigger) {
      await dispatch("Setup", ctx, { trigger: setupTrigger });
      if (generation !== lifecycleGeneration || !supplemental.isCurrentGeneration(generationToken))
        return;
    }
    const result = await dispatch("SessionStart", ctx, {
      source: sourceForStart(event.reason),
      model: ctx.model?.id,
    });
    if (generation !== lifecycleGeneration || !supplemental.isCurrentGeneration(generationToken))
      return;
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
    if (event.source !== "extension") {
      stopTaskGeneration += 1;
      stopHookActive = false;
      stopHookBlocks = 0;
    }
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
        warnBlockedReason(ctx, expansionResult.reason);
        return { action: "handled" } as const;
      }
      expansionContext = expansionResult.additionalContext.join("\n");
    }
    const result = await dispatch("UserPromptSubmit", ctx, { prompt: event.text });
    notify(ctx, result.systemMessages);
    if (result.blocked || !result.continue) {
      warnBlockedReason(ctx, result.reason);
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
      const blocked = await createHookWorktree(dispatch, ctx, event);
      if (blocked) return blocked;
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
    if (await isBackgroundAdoptionRequest(ctx, event)) return;
    const result = await dispatch("PreCompact", ctx, {
      trigger: event.reason === "manual" ? "manual" : "auto",
      custom_instructions: event.customInstructions ?? "",
    });
    if (result.blocked || !result.continue) return { cancel: true };
  });
  pi.on("session_compact", async (event, ctx) => {
    if (isBackgroundAdoptionEntry(ctx, event.compactionEntry)) return;
    await dispatch("PostCompact", ctx, {
      trigger: event.reason === "manual" ? "manual" : "auto",
      compact_summary: event.compactionEntry.summary,
    });
  });
  pi.on("agent_end", async (event, ctx) => {
    const generation = lifecycleGeneration;
    const taskGeneration = stopTaskGeneration;
    const last = event.messages.findLast((message) => message.role === "assistant");
    if (last?.role === "assistant" && last.stopReason === "error") {
      const errorText = last.errorMessage ?? textOf(last);
      await dispatch("StopFailure", ctx, {
        error: stopFailureType(errorText),
        error_details: errorText,
        last_assistant_message: errorText,
      });
      if (generation !== lifecycleGeneration || taskGeneration !== stopTaskGeneration) return;
      stopHookActive = false;
      return;
    }
    const result = await dispatch("Stop", ctx, {
      stop_hook_active: stopHookActive,
      last_assistant_message: textOf(last),
      background_tasks: supplemental.getBackgroundTasks(),
      session_crons: [],
    });
    if (generation !== lifecycleGeneration || taskGeneration !== stopTaskGeneration) return;
    notify(ctx, result.systemMessages);
    const continuation =
      result.blocked && result.reason ? result.reason : result.additionalContext.join("\n");
    if (continuation) {
      const configuredCap = Number(process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP ?? 8);
      const cap = Number.isSafeInteger(configuredCap) && configuredCap > 0 ? configuredCap : 8;
      stopHookBlocks += 1;
      if (stopHookBlocks < cap) {
        stopHookActive = true;
        pi.sendUserMessage(continuation, { deliverAs: "followUp" });
      } else stopHookActive = false;
    } else {
      stopHookActive = false;
      stopHookBlocks = 0;
    }
  });
  pi.on("session_shutdown", async (event, ctx) => {
    disposeExternalProducers();
    if (rootSessionId) subagentSessionRoots().delete(sessionId);
    await dispatch("SessionEnd", ctx, { reason: endReason(event.reason) });
    await engine.waitForBackground();
    removeHookEnvironment(envFile);
  });
}
