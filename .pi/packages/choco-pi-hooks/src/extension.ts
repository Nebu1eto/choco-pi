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
import {
  createScratchWarner,
  loadScratchGrants,
  scratchDirFor,
  scratchDestinations,
} from "../../../extensions/lib/scratch-path.ts";
import { loadHookSources } from "./config.ts";
import { createPiHookBackends } from "./backends.ts";
import { HookEngine } from "./engine.ts";
import { PROJECT_DIR_FIELD, sessionEndBudget } from "./executor.ts";
import { hookOutputDirectory, limitHookResult } from "./output-limits.ts";
import {
  registerRootSession,
  registerSubagentSession,
  resolveSubagentIdentity,
  rootSession,
  type SubagentIdentity,
  unregisterSubagentSession,
} from "./session-identity.ts";
import type {
  HookEventName,
  HookInput,
  HookSource,
  JsonObject,
  MergedHookResult,
} from "./types.ts";
import { type HookDispatch, registerSupplementalEvents } from "./supplemental-events.ts";
import { createHookWatchers, type HookWatchers } from "./watchers.ts";
import { applyHookEnvironment, hookEnvironmentFile, removeHookEnvironment } from "./environment.ts";
import { registerClaudeTaskTools } from "./tasks.ts";
import { isStringValue, type RuntimeValue } from "./validation.ts";
import { isStaleContextError, rethrowUnlessStaleContext } from "./lifecycle.ts";
import { readStopState } from "./stop-control.ts";

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
/** Claude Code's SessionStart `source`: Pi's `new` is `/clear`; a reload restarts. */
function sourceForStart(reason: string): string {
  if (reason === "fork") return "fork";
  if (reason === "resume") return "resume";
  if (reason === "new") return "clear";
  return "startup";
}
/** Claude Code's SessionEnd `reason` for a Pi shutdown. */
function endReason(reason: string, mode: string): string {
  if (reason === "resume") return "resume";
  if (reason === "new") return "clear";
  if (reason === "quit" && mode === "tui") return "prompt_input_exit";
  return "other";
}
/** Events whose exit-2 stderr Claude Code shows to the user only. */
const USER_STDERR_EVENTS = new Set<HookEventName>([
  "SessionStart",
  "SessionEnd",
  "CwdChanged",
  "FileChanged",
  "PostCompact",
  "PostModelSwitch",
]);
const PROMPT_CACHE_TTL_SECONDS = 300;

function textContent(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
  if (isStringValue(content)) return content;
  return content.flatMap((item) => (isStringValue(item.text) ? [item.text] : [])).join("\n");
}

/**
 * SessionStart's resume-cost fields: how long the transcript has been idle,
 * what its first request re-sends, and whether the prompt cache has likely expired.
 */
function resumeCost(ctx: ExtensionContext): JsonObject {
  const entries = ctx.sessionManager.getEntries();
  const lastIndex = entries.findLastIndex(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  );
  const last = entries[lastIndex];
  if (!last || last.type !== "message" || last.message.role !== "assistant") return {};
  const usage = last.message.usage;
  const seconds = Math.max(0, Math.round((Date.now() - last.message.timestamp) / 1000));
  const contextTokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
  const compactedSince = entries.slice(lastIndex + 1).some((entry) => entry.type === "compaction");
  const cacheWritePerMillion = ctx.model?.cost.cacheWrite ?? 0;
  return {
    seconds_since_last_response: seconds,
    context_tokens: contextTokens,
    prompt_cache_likely_expired: seconds > PROMPT_CACHE_TTL_SECONDS || compactedSince,
    estimated_cache_write_usd: (contextTokens * cacheWritePerMillion) / 1_000_000,
  };
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
interface AdoptionSignal {
  willAdopt(sessionId: string, event: SessionBeforeCompactEvent): Promise<boolean>;
  isAdoption(sessionId: string, entry: CompactionEntry): boolean;
}
function isAdoptionSignal<T>(value: T): value is T & AdoptionSignal {
  const record = Object(value);
  return (
    record === value &&
    !(value instanceof Function) &&
    record.version === 1 &&
    record.willAdopt instanceof Function &&
    record.isAdoption instanceof Function
  );
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
  /** Set for a subagent session; such a session runs only the hooks Claude Code fires for subagents. */
  let identity: SubagentIdentity | undefined;
  let unregisterRoot: (() => void) | undefined;
  let projectDir = "";
  let promptId: string | undefined;
  let transcriptPath = "";
  let stopHookActive = false;
  let stopHookBlocks = 0;
  let stopTaskGeneration = 0;
  let stopNoticeEpoch: number | undefined;
  let watchers: HookWatchers | undefined;
  let currentSources: HookSource[] = [];
  let envFile = hookEnvironmentFile(sessionId);
  let lastCwd = "";
  let lifecycleGeneration = 0;
  let unregisterResourceCleanup: (() => void) | undefined;
  /** PreToolUse context and start times, delivered with each call's result. */
  const preToolContext = new Map<string, string[]>();
  const toolStarts = new Map<string, number>();
  /** SubagentStart context already in this subagent's conversation. */
  const injectedSubagentContext = new Set<string>();
  // Warn mode: write destinations under /tmp outside the session scratch directory are reported, never blocked.
  let scratchGrants: Promise<string[]> | undefined;
  const scratchWarner = createScratchWarner({
    grants: () => (scratchGrants ??= loadScratchGrants()),
  });
  const pendingScratchWarnings = new Map<string, string[]>();
  const MAX_PENDING_SCRATCH_WARNINGS = 256;

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
    // A subagent's hooks fire in its top-level session, as in Claude Code.
    const root = identity ? rootSession(identity.rootSessionId) : undefined;
    const subagent: JsonObject = identity
      ? {
          agent_id: identity.agentId,
          agent_type: identity.agentType,
          root_session_id: identity.rootSessionId,
        }
      : {};
    // SAFETY: Required common fields are set here and extra is a JSON event-specific property bag.
    const hookInput = {
      session_id: identity?.rootSessionId ?? sessionId,
      transcript_path: root?.transcriptPath ?? transcriptPath,
      cwd: ctx.cwd,
      scratchpad_dir: scratchDirFor(identity?.rootSessionId ?? sessionId),
      hook_event_name: event,
      permission_mode: "default",
      _claude_env_file: root?.envFile ?? envFile,
      [PROJECT_DIR_FIELD]: root?.projectDir ?? (projectDir || ctx.cwd),
      ...subagent,
      ...extra,
    } as HookInput;
    if (promptId) hookInput.prompt_id = promptId;
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
    const hasUI = ctx.hasUI;
    const ui = ctx.ui;
    const outputDirectory = hookOutputDirectory(sessionId);
    const result: MergedHookResult = await limitHookResult(
      await engine.run(hookInput),
      outputDirectory,
    );
    if (mode === "tui")
      for (const sequence of result.terminalSequences) process.stdout.write(sequence);
    if (hasUI && USER_STDERR_EVENTS.has(event))
      for (const stderr of result.exitTwoStderr)
        ui.notify(`${event} hook error: ${stderr}`, "warning");
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
    // CwdChanged belongs to the main conversation.
    if (identity) return;
    const result = await dispatch("CwdChanged", ctx, { old_cwd: oldCwd, new_cwd: ctx.cwd });
    notify(ctx, result.systemMessages);
    if (result.watchPaths) watchers?.replaceDynamicPaths(result.watchPaths);
  };
  const supplemental = registerSupplementalEvents(pi, dispatch, {
    isSubagentSession: () => identity !== undefined,
  });
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
      // The add is complete; the hooks run in the background and their
      // systemMessage reaches Claude as context on the next turn.
      void dispatch("DirectoryAdded", ctx, { directory, source: "slash_command" })
        .then((result) => {
          if (!result.systemMessages.length) return;
          pi.sendMessage(
            {
              customType: "choco-pi-hooks",
              content: result.systemMessages.join("\n"),
              display: false,
            },
            { deliverAs: "nextTurn" },
          );
        })
        .catch(rethrowUnlessStaleContext);
      // Hosts without the TUI otherwise get no confirmation at all.
      if (mode !== "tui") ctx.ui.notify(`Started DirectoryAdded hooks for ${directory}.`, "info");
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
    scratchGrants = undefined;
    scratchWarner.reset();
    pendingScratchWarnings.clear();
    preToolContext.clear();
    toolStarts.clear();
    injectedSubagentContext.clear();
    promptId = undefined;
    unregisterRoot?.();
    unregisterRoot = undefined;
    identity = resolveSubagentIdentity(sessionId, ctx);
    if (identity) registerSubagentSession(sessionId, identity);
    else {
      projectDir = ctx.cwd;
      unregisterRoot = registerRootSession(sessionId, {
        get transcriptPath() {
          return transcriptPath;
        },
        get projectDir() {
          return projectDir;
        },
        get envFile() {
          return envFile;
        },
        backgroundTasks: () => supplemental.getBackgroundTasks(),
      });
    }
    unregisterResourceCleanup?.();
    const ownedSessionId = sessionId;
    unregisterResourceCleanup = registerSessionResourceCleanup((cleanupSessionId) => {
      if (cleanupSessionId === undefined || cleanupSessionId === ownedSessionId)
        disposeExternalProducers();
    });
    lastCwd = ctx.cwd;
    supplemental.setContext(ctx);
    // Claude Code fires no session-level events for a subagent; its SubagentStart runs per run.
    if (identity) return;
    const generationToken = supplemental.captureGeneration();
    let setupTrigger: "maintenance" | "init" | undefined;
    if (pi.getFlag("maintenance")) setupTrigger = "maintenance";
    else if (pi.getFlag("init-only") || pi.getFlag("init")) setupTrigger = "init";
    if (setupTrigger) {
      await dispatch("Setup", ctx, { trigger: setupTrigger });
      if (generation !== lifecycleGeneration || !supplemental.isCurrentGeneration(generationToken))
        return;
    }
    const source = sourceForStart(event.reason);
    const sessionTitle = ctx.sessionManager.getSessionName();
    const extra: JsonObject = { source, model: ctx.model?.id, session_title: sessionTitle };
    if (source === "resume" || source === "fork") Object.assign(extra, resumeCost(ctx));
    const interactive = ctx.mode === "tui" || ctx.mode === "rpc";
    const result = await dispatch("SessionStart", ctx, extra);
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
    applySessionStart(result, source, interactive);
    if (pi.getFlag("init-only")) ctx.shutdown();
  });
  /** Apply SessionStart output: title, first message, and context for Claude. */
  function applySessionStart(result: MergedHookResult, source: string, interactive: boolean): void {
    if (result.sessionTitle && ["startup", "resume", "fork"].includes(source))
      pi.setSessionName(result.sessionTitle);
    // `initialUserMessage` is the first turn of a non-interactive run only.
    if (result.initialUserMessage && !interactive)
      pi.sendUserMessage(result.initialUserMessage, { deliverAs: "followUp" });
    if (result.additionalContext.length)
      pi.sendMessage({
        customType: "choco-pi-hooks",
        content: result.additionalContext.join("\n"),
        display: false,
      });
  }
  pi.on("input", async (event, ctx) => {
    if (event.source !== "extension") {
      stopTaskGeneration += 1;
      stopHookActive = false;
      stopHookBlocks = 0;
    }
    supplemental.setContext(ctx);
    await ensureCwd(ctx);
    // A subagent's task is not a user prompt; Claude Code fires no prompt events for it.
    if (event.source === "extension" || identity) return { action: "continue" };
    promptId = crypto.randomUUID();
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
    const result = await dispatch("UserPromptSubmit", ctx, {
      prompt: event.text,
      session_title: ctx.sessionManager.getSessionName(),
    });
    notify(ctx, result.systemMessages);
    if (result.sessionTitle) pi.setSessionName(result.sessionTitle);
    if (result.blocked || !result.continue) {
      const message = result.reason ?? "Prompt blocked by hook";
      warnBlockedReason(
        ctx,
        result.suppressOriginalPrompt ? message : `${message}\n\nOriginal prompt: ${event.text}`,
      );
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
    // Consecutive stop-hook continuations are counted between tool calls.
    stopHookBlocks = 0;
    toolStarts.set(event.toolCallId, Date.now());
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
    if (result.additionalContext.length && result.permissionDecision !== "defer")
      preToolContext.set(event.toolCallId, result.additionalContext);
    if (
      result.updatedInput &&
      result.permissionDecision !== "deny" &&
      result.permissionDecision !== "defer"
    )
      replaceToolInput(event.input, result.updatedInput);
    const scratchWarnings = await scratchWarner.check({
      sessionId: ctx.sessionManager.getSessionId(),
      toolName: event.toolName,
      cwd: ctx.cwd,
      destinations: scratchDestinations(event.toolName, event.input),
    });
    if (scratchWarnings.length) {
      if (pendingScratchWarnings.size >= MAX_PENDING_SCRATCH_WARNINGS)
        pendingScratchWarnings.clear();
      pendingScratchWarnings.set(event.toolCallId, scratchWarnings);
    }
    if (result.blocked || result.permissionDecision === "deny" || !result.continue)
      return {
        block: true,
        reason: result.reason ?? "Blocked by hook",
        terminate: !result.continue,
      };
  });
  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    const name = event.isError ? "PostToolUseFailure" : "PostToolUse";
    const toolName = claudeToolName(event.toolName);
    const started = toolStarts.get(event.toolCallId);
    toolStarts.delete(event.toolCallId);
    const extra: JsonObject = {
      tool_name: toolName,
      // SAFETY: Pi tool inputs are JSON argument property bags.
      tool_input: event.input as JsonObject,
      tool_use_id: event.toolCallId,
    };
    if (started !== undefined) extra.duration_ms = Date.now() - started;
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
    // `continue: false` stops Claude after the tool result, with the reason shown to the user.
    if (!result.continue) {
      warnBlockedReason(ctx, result.reason);
      ctx.abort();
    }
    const scratchWarnings = pendingScratchWarnings.get(event.toolCallId) ?? [];
    pendingScratchWarnings.delete(event.toolCallId);
    const beforeContext = preToolContext.get(event.toolCallId) ?? [];
    preToolContext.delete(event.toolCallId);
    // A block reason and exit-2 stderr are shown to Claude next to the result; the tool already ran.
    const feedback = [
      ...(result.blocked && result.reason && result.continue ? [result.reason] : []),
      ...result.exitTwoStderr,
    ];
    const appended = [
      ...beforeContext,
      ...result.additionalContext,
      ...new Set(feedback),
      ...scratchWarnings,
    ].map((value) => ({
      type: "text" as const,
      text: value,
    }));
    const updatedOutput =
      result.updatedToolOutput ??
      (toolName.startsWith("mcp__") ? result.updatedMCPToolOutput : undefined);
    if (updatedOutput !== undefined)
      return {
        content: [
          {
            type: "text",
            text: isStringValue(updatedOutput) ? updatedOutput : JSON.stringify(updatedOutput),
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
      custom_instructions: event.reason === "manual" ? (event.customInstructions ?? null) : null,
    });
    if (result.blocked || !result.continue) return { cancel: true };
  });
  pi.on("session_compact", async (event, ctx) => {
    // Compaction drops injected SubagentStart context, so the next run injects it again.
    injectedSubagentContext.clear();
    const interactive = ctx.mode === "tui" || ctx.mode === "rpc";
    const generation = lifecycleGeneration;
    if (!isBackgroundAdoptionEntry(ctx, event.compactionEntry))
      await dispatch("PostCompact", ctx, {
        trigger: event.reason === "manual" ? "manual" : "auto",
        compact_summary: event.compactionEntry.summary,
      });
    if (identity || generation !== lifecycleGeneration) return;
    // SessionStart runs again after compaction so hooks can restore their context.
    const result = await dispatch("SessionStart", ctx, {
      source: "compact",
      model: ctx.model?.id,
      session_title: ctx.sessionManager.getSessionName(),
    });
    if (generation !== lifecycleGeneration) return;
    applySessionStart(result, "compact", interactive);
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (identity) {
      // SubagentStart fires each time the subagent starts work, including a resume.
      const result = await dispatch("SubagentStart", ctx);
      const fresh = result.additionalContext.filter((text) => !injectedSubagentContext.has(text));
      for (const text of fresh) injectedSubagentContext.add(text);
      if (!fresh.length) return;
      return {
        message: { customType: "choco-pi-hooks", content: fresh.join("\n"), display: false },
      };
    }
    if (event.messageType !== "custom") return;
    // Claude Code runs UserPromptSubmit on turns it starts on its own, such as
    // a background subagent reporting back to the session that started it.
    promptId = crypto.randomUUID();
    const result = await dispatch("UserPromptSubmit", ctx, {
      prompt: textContent(event.message.content),
      session_title: ctx.sessionManager.getSessionName(),
    });
    notify(ctx, result.systemMessages);
    if (result.sessionTitle) pi.setSessionName(result.sessionTitle);
    if (result.blocked || !result.continue) {
      warnBlockedReason(ctx, result.reason ?? "Prompt blocked by hook");
      ctx.abort();
      return;
    }
    if (!result.additionalContext.length) return;
    return {
      message: {
        customType: "choco-pi-hooks",
        content: result.additionalContext.join("\n"),
        display: false,
      },
    };
  });
  pi.on("model_select", async (event, ctx) => {
    // A subagent's model is not the session's, and the first selection is no switch.
    if (identity || !event.previousModel) return;
    const last = ctx.sessionManager
      .getEntries()
      .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
    const usage =
      last?.type === "message" && last.message.role === "assistant"
        ? last.message.usage
        : undefined;
    const contextTokens = usage
      ? usage.input + usage.cacheRead + usage.cacheWrite + usage.output
      : 0;
    const idleSeconds =
      last?.type === "message" ? (Date.now() - last.message.timestamp) / 1000 : Infinity;
    const cacheWrite = event.model.cost.cacheWrite;
    const sources = { set: "command", cycle: "picker", restore: "resume" } as const;
    const result = await dispatch("PostModelSwitch", ctx, {
      from_model: event.previousModel.id,
      to_model: event.model.id,
      requested_model: event.model.id,
      source: sources[event.source],
      context_tokens: contextTokens,
      prompt_cache_warm: idleSeconds < PROMPT_CACHE_TTL_SECONDS,
      cache_ttl: "5m",
      estimated_cache_write_usd: (contextTokens * cacheWrite) / 1_000_000,
      pricing: cacheWrite > 0 ? "catalog" : "default",
    });
    if (!result.additionalContext.length) return;
    pi.sendMessage(
      {
        customType: "choco-pi-hooks",
        content: result.additionalContext.join("\n"),
        display: false,
      },
      { deliverAs: "nextTurn" },
    );
  });
  pi.on("agent_end", async (event, ctx) => {
    const generation = lifecycleGeneration;
    const taskGeneration = stopTaskGeneration;
    // A subagent follows its root session's stop state; a root session uses its own id.
    const stopRoot = identity?.rootSessionId ?? sessionId;
    const stopEvent = identity ? "SubagentStop" : "Stop";
    // Reset the continuation state and tell the user once per stop epoch.
    const skipStopContinuation = (): void => {
      stopHookActive = false;
      stopHookBlocks = 0;
      const epoch = readStopState(stopRoot).epoch;
      if (stopNoticeEpoch === epoch) return;
      stopNoticeEpoch = epoch;
      if (ctx.hasUI)
        ctx.ui.notify("Stop hook continuation skipped: session work is stopped.", "info");
    };
    const last = event.messages.findLast((message) => message.role === "assistant");
    if (last?.role === "assistant" && last.stopReason === "error") {
      stopHookActive = false;
      // StopFailure belongs to the main conversation's turn.
      if (identity) return;
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
    // Claude Code does not run Stop hooks for a user interrupt; an Esc-aborted run is never auto-continued.
    if (last?.role === "assistant" && last.stopReason === "aborted") {
      stopHookActive = false;
      stopHookBlocks = 0;
      return;
    }
    if (readStopState(stopRoot).closed) {
      skipStopContinuation();
      return;
    }
    const subagentFields: JsonObject = identity ? { agent_transcript_path: transcriptPath } : {};
    const backgroundTasks = identity
      ? (rootSession(identity.rootSessionId)?.backgroundTasks() ?? [])
      : supplemental.getBackgroundTasks();
    const result = await dispatch(stopEvent, ctx, {
      stop_hook_active: stopHookActive,
      ...subagentFields,
      last_assistant_message: textOf(last),
      background_tasks: backgroundTasks,
      session_crons: [],
    });
    if (generation !== lifecycleGeneration || taskGeneration !== stopTaskGeneration) return;
    notify(ctx, result.systemMessages);
    if (readStopState(stopRoot).closed) {
      skipStopContinuation();
      return;
    }
    // `continue: false` ends the turn even when a hook also blocked.
    if (!result.continue) {
      warnBlockedReason(ctx, result.reason);
      stopHookActive = false;
      stopHookBlocks = 0;
      return;
    }
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
    const mode = ctx.mode;
    // Background hooks deliver results only while their session runs: end
    // those still running, then give SessionEnd's own a bounded wait.
    engine.cancelBackground();
    // One SessionEnd budget covers its synchronous and background hooks alike.
    const handlers = currentSources.flatMap((source) =>
      (source.hooks.SessionEnd ?? []).flatMap((group) => group.hooks),
    );
    const deadline = Date.now() + sessionEndBudget(handlers);
    if (identity) unregisterSubagentSession(sessionId);
    else {
      unregisterRoot?.();
      unregisterRoot = undefined;
      await dispatch("SessionEnd", ctx, { reason: endReason(event.reason, mode) });
    }
    let budget: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      engine.waitForBackground(),
      new Promise<void>((resolve) => {
        budget = setTimeout(resolve, Math.max(0, deadline - Date.now()));
      }),
    ]);
    clearTimeout(budget);
    engine.cancelBackground();
    await engine.waitForBackground();
    removeHookEnvironment(envFile);
  });
}
