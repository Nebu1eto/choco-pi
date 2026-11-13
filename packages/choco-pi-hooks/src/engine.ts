import os from "node:os";
import {
  executeHandler,
  parseAsyncOutput,
  parseOutput,
  sessionEndTimeouts,
  type HookBackends,
  type RawExecution,
} from "./executor.ts";
import { matches } from "./matcher.ts";
import { isStringValue, parseRuntimeRecord } from "./validation.ts";
import type {
  HookEventName,
  HookHandler,
  HookInput,
  HookInvocationResult,
  HookOutput,
  HookSource,
  JsonObject,
  JsonValue,
  MergedHookResult,
} from "./types.ts";

const EXIT_TWO_BLOCKS = new Set<HookEventName>([
  "PreToolUse",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "Stop",
  "SubagentStop",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
  "ConfigChange",
  "PostToolBatch",
  "PreCompact",
  "PreModelSwitch",
  "Elicitation",
  "ElicitationResult",
  "WorktreeCreate",
]);
const PLAIN_CONTEXT = new Set<HookEventName>([
  "UserPromptSubmit",
  "UserPromptExpansion",
  "SessionStart",
  "PostModelSwitch",
]);
const DECISION_BLOCKS = new Set<HookEventName>([
  "UserPromptSubmit",
  "UserPromptExpansion",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "Stop",
  "SubagentStop",
  "ConfigChange",
  "PreCompact",
  "PreModelSwitch",
  "TaskCreated",
]);
const PERMISSION_ORDER = { allow: 0, ask: 1, defer: 2, deny: 3 } as const;
/** Events whose JSON output is discarded apart from `terminalSequence`. */
const DISCARDS_OUTPUT = new Set<HookEventName>([
  "StopFailure",
  "Setup",
  "InstructionsLoaded",
  "SessionEnd",
  "WorktreeRemove",
]);
/** Events that discard `systemMessage` and `continue`. */
const DISCARDS_MESSAGE = new Set<HookEventName>([
  "Notification",
  "PreCompact",
  "PostCompact",
  "ConfigChange",
  "WorktreeCreate",
  "MessageDisplay",
]);
/** Events that discard `continue` only. */
const DISCARDS_CONTINUE = new Set<HookEventName>(["CwdChanged", "FileChanged", "DirectoryAdded"]);
/** Exit 2 sends these events back to work; `onFailure` has no effect on them. */
const CONTINUATION_EVENTS = new Set<HookEventName>([
  "Stop",
  "SubagentStop",
  "TaskCompleted",
  "TeammateIdle",
]);
const TOOL_EVENTS = new Set<HookEventName>(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);
/** Settings files share one copy of an identical handler; plugin and skill copies stay separate. */
const SETTINGS_KINDS = new Set<HookSource["kind"]>(["managed", "user", "project", "local"]);
const MODEL_HANDLER_EVENTS = new Set<HookEventName>([
  "PermissionDenied",
  "PermissionRequest",
  "PostToolBatch",
  "PostToolUse",
  "PostToolUseFailure",
  "PreToolUse",
  "Stop",
  "SubagentStop",
  "TaskCompleted",
  "TaskCreated",
  "TeammateIdle",
  "UserPromptExpansion",
  "UserPromptSubmit",
]);

function supportsHandler(event: HookEventName, handler: HookHandler): boolean {
  if (event === "PermissionRequest" || event === "PermissionDenied") return false;
  if (event === "SessionStart" || event === "Setup")
    return handler.type === "command" || handler.type === "mcp_tool";
  if (handler.type === "prompt" || handler.type === "agent") return MODEL_HANDLER_EVENTS.has(event);
  return true;
}

function glob(pattern: string, value: string): boolean {
  const reachable = new Set([0]);
  for (const character of value) {
    const next = new Set<number>();
    for (const index of reachable) {
      if (pattern[index] === "*") {
        next.add(index);
        next.add(index + 1);
      } else if (pattern[index] === character) next.add(index + 1);
    }
    reachable.clear();
    for (const index of next) reachable.add(index);
  }
  for (const start of reachable) {
    let index = start;
    while (pattern[index] === "*") index++;
    if (index === pattern.length) return true;
  }
  return false;
}

/**
 * The subcommands a Bash command runs: each `&&`, `||`, `;`, `|`, or newline
 * segment, plus the commands inside `$()` and backticks, each with leading
 * `VAR=value` assignments removed.
 */
function bashSubcommands(command: string): string[] {
  const nested = [
    ...[...command.matchAll(/\$\(([^()]*)\)/g)].map((found) => found[1] ?? ""),
    ...[...command.matchAll(/`([^`]*)`/g)].map((found) => found[1] ?? ""),
  ];
  return [command, ...nested]
    .flatMap((text) => text.split(/&&|\|\||;|\||\n/))
    .map((part) =>
      part.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+)+/, ""),
    )
    .filter(Boolean);
}

function bashPatternMatches(pattern: string, subcommand: string): boolean {
  // Legacy `prefix:*` matches the prefix alone or followed by arguments.
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2);
    return subcommand === prefix || subcommand.startsWith(`${prefix} `);
  }
  // `git *` covers `git` with any arguments, including none.
  if (pattern.endsWith(" *") && subcommand === pattern.slice(0, -2)) return true;
  return glob(pattern, subcommand);
}

function matchesBash(pattern: string, command: string): boolean {
  if (!pattern || pattern === "*") return true;
  if (bashSubcommands(command).some((part) => bashPatternMatches(pattern, part))) return true;
  // A pattern naming more than the command runs anyway when expansion hides what runs.
  const words = pattern.replace(/:\*$/, "").trim().split(/\s+/);
  const specific = words.slice(1).some((word) => word !== "*");
  return specific && /\$\(|`|\$[A-Za-z_{]/.test(command);
}

function pathGlobRegex(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index] ?? "";
    if (character === "*" && pattern[index + 1] === "*") {
      index++;
      if (pattern[index + 1] === "/") {
        index++;
        source += "(?:.*/)?";
      } else source += ".*";
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/**
 * File-tool rules use gitignore-style paths: `//abs` is absolute, `~/` is under
 * home, a pattern with a slash is relative to the working directory, and one
 * without a slash matches a file name at any depth.
 */
function matchesFilePath(pattern: string, filePath: string, cwd: string): boolean {
  if (!pattern || pattern === "*" || pattern === "**") return true;
  const absolute = filePath.replaceAll("\\", "/");
  const root = cwd.replaceAll("\\", "/").replace(/\/$/, "");
  const relative = absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : absolute;
  if (pattern.startsWith("//")) return pathGlobRegex(pattern.slice(1)).test(absolute);
  if (pattern.startsWith("~/"))
    return pathGlobRegex(`${os.homedir().replaceAll("\\", "/")}/${pattern.slice(2)}`).test(
      absolute,
    );
  const local = pattern.replace(/^\.?\//, "");
  if (!local.includes("/")) return pathGlobRegex(`**/${local}`).test(relative);
  return pathGlobRegex(local).test(relative);
}

export function matchesIf(
  rule: string | undefined,
  event: HookEventName,
  input: HookInput,
): boolean {
  if (!rule) return true;
  if (
    ![
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "PermissionRequest",
      "PermissionDenied",
    ].includes(event)
  )
    return false;
  const toolName = String(input.tool_name ?? "");
  const match = rule.match(/^([^()]+)(?:\((.*)\))?$/);
  if (!match) return false;
  const ruleTool = (match[1] ?? "").trim();
  // `mcp__server` names every tool from that server.
  const toolMatches =
    ruleTool === toolName ||
    (ruleTool.startsWith("mcp__") &&
      ruleTool.split("__").length === 2 &&
      toolName.startsWith(`${ruleTool}__`));
  if (!toolMatches) return false;
  const pattern = match[2];
  if (pattern === undefined) return true;
  const toolRecord = parseRuntimeRecord(input.tool_input);
  if (!toolRecord) return pattern === "";
  if (isStringValue(toolRecord.command) && (toolName === "Bash" || toolName === "PowerShell"))
    return matchesBash(pattern, toolRecord.command);
  const filePath = toolRecord.file_path ?? toolRecord.path;
  if (isStringValue(filePath)) return matchesFilePath(pattern, filePath, input.cwd);
  return glob(pattern, String(toolRecord.command ?? ""));
}

function validTerminalSequence(value: string): boolean {
  const allowedCodes = new Set(["0", "1", "2", "9", "99", "777"]);
  let index = 0;
  while (index < value.length) {
    if (value.charCodeAt(index) === 7) {
      index++;
      continue;
    }
    if (value.charCodeAt(index) !== 27 || value[index + 1] !== "]") return false;
    const separator = value.indexOf(";", index + 2);
    if (separator < 0 || !allowedCodes.has(value.slice(index + 2, separator))) return false;
    index = separator + 1;
    while (index < value.length) {
      if (value.charCodeAt(index) === 7) {
        index++;
        break;
      }
      if (value.charCodeAt(index) === 27 && value[index + 1] === "\\") {
        index += 2;
        break;
      }
      if (value.charCodeAt(index) === 27) return false;
      index++;
    }
  }
  return true;
}

interface ModelDecision {
  output?: HookOutput;
  modelBlock?: boolean;
}

/**
 * Translate a prompt or agent hook's `{ok, reason}` answer into the outcome
 * Claude Code gives it on each event. Agent hooks always behave as a prompt
 * hook with `continueOnBlock: true`.
 */
function modelOutput(
  event: HookEventName,
  handler: HookHandler,
  parsed: HookOutput | undefined,
): ModelDecision {
  if ((handler.type !== "prompt" && handler.type !== "agent") || !parsed) return { output: parsed };
  const ok = parsed.ok;
  if (ok === true) return { output: {} };
  if (ok !== false || !isStringValue(parsed.reason)) return {};
  const reason = parsed.reason;
  const continueOnBlock = handler.type === "agent" || handler.continueOnBlock === true;
  const stop: HookOutput = { continue: false, stopReason: reason };
  switch (event) {
    case "Stop":
    case "SubagentStop":
      if (handler.type === "prompt" && parsed.impossible === true) return { output: {} };
      return { output: { decision: "block", reason } };
    case "PreToolUse": {
      const deny: HookOutput = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      };
      return { output: continueOnBlock ? deny : { ...deny, ...stop } };
    }
    case "PostToolUse":
      return { output: continueOnBlock ? { decision: "block", reason } : stop };
    case "TeammateIdle":
      return continueOnBlock ? { output: { reason }, modelBlock: true } : { output: stop };
    case "TaskCompleted":
      return { output: { reason }, modelBlock: true };
    case "PermissionRequest":
    case "PermissionDenied":
      return { output: {} };
    default:
      return { output: { decision: "block", reason } };
  }
}

function handlerKey(source: HookSource, handler: HookHandler): string {
  const scope = SETTINGS_KINDS.has(source.kind) ? "settings" : `${source.kind}:${source.id}`;
  return `${scope}:${JSON.stringify(handler)}`;
}

function handlerLabel(handler: HookHandler): string {
  if (handler.type === "command") return [handler.command, ...(handler.args ?? [])].join(" ");
  if (handler.type === "http") return handler.url;
  if (handler.type === "mcp_tool") return `${handler.server}:${handler.tool}`;
  return handler.type;
}

/** `Stop`, `SubagentStop`, and `TaskCompleted` treat a hook whose file is missing as non-blocking. */
function missingHookFile(event: HookEventName, raw: RawExecution): boolean {
  return (
    (event === "Stop" || event === "SubagentStop" || event === "TaskCompleted") &&
    raw.exitCode === 2 &&
    !raw.stdout.trim() &&
    /No such file or directory/.test(raw.stderr)
  );
}

export class HookEngine {
  readonly #once = new Set<string>();
  /** Once-hook keys whose run is in progress, so an overlapping run skips them. */
  readonly #onceRunning = new Set<string>();
  readonly #background = new Set<Promise<void>>();
  /** Cancels background hooks still running when their session tears down. */
  #backgroundCancel = new AbortController();
  readonly sources: HookSource[];
  readonly backends: HookBackends;
  readonly #httpUrlAllowlist: string[] | undefined;
  readonly #httpEnvAllowlist: Set<string> | undefined;
  constructor(sources: HookSource[], backends: HookBackends = {}) {
    this.sources = sources;
    this.backends = backends;
    const urlLists = sources.flatMap((source) => source.allowedHttpHookUrls ?? []);
    this.#httpUrlAllowlist = sources.some((source) => source.allowedHttpHookUrls !== undefined)
      ? urlLists
      : undefined;
    const envLists = sources.flatMap((source) => source.httpHookAllowedEnvVars ?? []);
    this.#httpEnvAllowlist = sources.some((source) => source.httpHookAllowedEnvVars !== undefined)
      ? new Set(envLists)
      : undefined;
  }

  async run(input: HookInput): Promise<MergedHookResult> {
    const event = input.hook_event_name;
    const jobs: { source: HookSource; handler: HookHandler; key: string }[] = [];
    const seen = new Set<string>();
    for (const source of this.sources)
      for (const group of source.hooks[event] ?? []) {
        if (!matches(event, group.matcher, input)) continue;
        for (const configuredHandler of group.hooks) {
          if (
            configuredHandler.type === "http" &&
            this.#httpUrlAllowlist &&
            !this.#httpUrlAllowlist.some((allowed) => configuredHandler.url.startsWith(allowed))
          )
            continue;
          const handler =
            configuredHandler.type === "http" && this.#httpEnvAllowlist
              ? {
                  ...configuredHandler,
                  allowedEnvVars: (configuredHandler.allowedEnvVars ?? []).filter((name) =>
                    this.#httpEnvAllowlist?.has(name),
                  ),
                }
              : configuredHandler;
          if (!supportsHandler(event, handler)) continue;
          if (!matchesIf(handler.if, event, input)) continue;
          const key = handlerKey(source, handler);
          const once = source.kind === "skill" && handler.once === true;
          if (seen.has(key) || (once && (this.#once.has(key) || this.#onceRunning.has(key))))
            continue;
          seen.add(key);
          if (once) this.#onceRunning.add(key);
          jobs.push({ source, handler, key });
        }
      }
    const timeouts =
      event === "SessionEnd" ? sessionEndTimeouts(jobs.map((job) => job.handler)) : undefined;
    let completionOrder = 0;
    const invocations = await Promise.all(
      jobs.map(async ({ source, handler, key }) => {
        if (handler.type === "command" && (handler.async || handler.asyncRewake)) {
          this.#onceRunning.delete(key);
          const cancel = this.#backgroundCancel.signal;
          const pending = executeHandler(
            handler,
            input,
            this.backends,
            timeouts?.get(handler),
            cancel,
          ).then(async (raw) => {
            // A cancelled hook's output belongs to a session that is ending.
            if (cancel.aborted) return;
            try {
              const parsed = parseAsyncOutput(raw.stdout);
              let status: HookInvocationResult["status"] = "success";
              if (raw.timedOut) status = "timeout";
              else if (raw.exitCode === 2) status = "blocking";
              const invocation: HookInvocationResult = {
                source,
                handler,
                status,
                exitCode: raw.exitCode,
                output: parsed.output,
                plainText: parsed.plainText,
                stderr: raw.stderr,
                error: parsed.validationError,
              };
              const merged = mergeResults(event, [invocation]);
              await this.backends.onAsyncResult?.(
                input,
                merged,
                handler.asyncRewake === true && raw.exitCode === 2,
              );
            } catch (error) {
              console.error(
                "Async hook failed:",
                error instanceof Error ? error.message : String(error),
              );
            }
          });
          this.#background.add(pending);
          void pending.finally(() => this.#background.delete(pending));
          return {
            source,
            handler,
            status: "background",
            completionOrder: completionOrder++,
          } satisfies HookInvocationResult;
        }
        let executed: RawExecution;
        try {
          executed = await executeHandler(handler, input, this.backends, timeouts?.get(handler));
        } catch (error) {
          this.#onceRunning.delete(key);
          throw error;
        }
        const raw = missingHookFile(event, executed) ? { ...executed, exitCode: 1 } : executed;
        const parsed = parseOutput(raw.stdout);
        const decision = modelOutput(event, handler, parsed.output);
        let output = decision.output;
        const validationError =
          parsed.validationError ??
          (handler.type === "http" && parsed.plainText
            ? "HTTP hook response body must be a JSON object"
            : undefined) ??
          ((handler.type === "prompt" || handler.type === "agent") && parsed.output && !output
            ? "invalid model hook response"
            : undefined);
        let exitCode = raw.exitCode;
        let stderr = raw.stderr;
        // A failure of a hook set to `onFailure: "block"` acts as exit code 2 on its event.
        const failed =
          raw.timedOut === true ||
          (exitCode !== 0 && exitCode !== 2) ||
          validationError !== undefined;
        if (
          (handler.type === "command" || handler.type === "http") &&
          handler.onFailure === "block" &&
          failed &&
          !CONTINUATION_EVENTS.has(event)
        ) {
          const what = raw.timedOut ? "timed out" : "failed";
          stderr = [`${what}; blocking because onFailure is "block"`, raw.stderr.trim()]
            .filter(Boolean)
            .join("\n");
          exitCode = 2;
          output = undefined;
        }
        if (exitCode === 2 && TOOL_EVENTS.has(event))
          stderr = `${event}:${String(input.tool_name ?? "")} hook error: [${handlerLabel(handler)}]: ${stderr.trim()}`;
        const blocking = exitCode === 2 && EXIT_TWO_BLOCKS.has(event);
        let status: HookInvocationResult["status"] = "success";
        if (raw.timedOut) status = "timeout";
        else if (blocking) status = "blocking";
        else if (validationError || (exitCode !== 0 && !output)) status = "error";
        // A skill hook with `once: true` is removed only after its first successful run.
        this.#onceRunning.delete(key);
        if (status === "success" && source.kind === "skill" && handler.once === true)
          this.#once.add(key);
        return {
          source,
          handler,
          status,
          exitCode,
          output,
          plainText: parsed.plainText,
          stderr,
          error: validationError,
          modelBlock: decision.modelBlock,
          completionOrder: completionOrder++,
        } satisfies HookInvocationResult;
      }),
    );
    invocations.sort((left, right) => (left.completionOrder ?? 0) - (right.completionOrder ?? 0));
    const merged = mergeResults(event, invocations);
    return event === "ConfigChange" && input.source === "policy_settings"
      ? { ...merged, blocked: false }
      : merged;
  }

  async waitForBackground(): Promise<void> {
    await Promise.all(this.#background);
  }

  /** Cancel every running background hook; hooks started later are unaffected. */
  cancelBackground(): void {
    this.#backgroundCancel.abort();
    this.#backgroundCancel = new AbortController();
  }
}

export function mergeResults(
  event: HookEventName,
  invocations: HookInvocationResult[],
): MergedHookResult {
  let blocked = false;
  let continueProcessing = true;
  let permissionDecision: MergedHookResult["permissionDecision"];
  let permissionRequestDecision: MergedHookResult["permissionRequestDecision"];
  let updatedInput: JsonObject | undefined;
  let updatedToolOutput: JsonValue | undefined;
  let updatedMCPToolOutput: JsonValue | undefined;
  let displayContent: string | undefined;
  let worktreePath: string | undefined;
  let retry: boolean | undefined;
  let elicitationAction: MergedHookResult["elicitationAction"];
  let elicitationContent: JsonObject | undefined;
  let initialUserMessage: string | undefined;
  let sessionTitle: string | undefined;
  let watchPaths: string[] | undefined;
  let reloadSkills: boolean | undefined;
  let updatedPermissions: JsonValue[] | undefined;
  let suppressOriginalPrompt: boolean | undefined;
  let exitReason: string | undefined;
  let decisionReason: string | undefined;
  let stopReason: string | undefined;
  const systemMessages: string[] = [];
  const terminalSequences: string[] = [];
  const additionalContext: string[] = [];
  const exitTwoStderr: string[] = [];
  const discardsOutput = DISCARDS_OUTPUT.has(event);
  const discardsMessage = discardsOutput || DISCARDS_MESSAGE.has(event);
  const discardsContinue = discardsMessage || DISCARDS_CONTINUE.has(event);
  for (const item of invocations) {
    const output = item.output;
    if (item.exitCode === 2 && item.stderr) exitTwoStderr.push(item.stderr);
    if (item.exitCode === 2 && EXIT_TWO_BLOCKS.has(event)) {
      blocked = true;
      exitReason ??= item.stderr;
    }
    if (item.modelBlock) {
      blocked = true;
      decisionReason ??= isStringValue(output?.reason) ? output.reason : undefined;
    }
    if (output && isStringValue(output.terminalSequence)) {
      if (validTerminalSequence(output.terminalSequence))
        terminalSequences.push(output.terminalSequence);
      else if (!discardsMessage)
        systemMessages.push("Hook returned a disallowed terminal sequence");
    }
    if (discardsOutput) continue;
    if (!output) {
      if (item.plainText && PLAIN_CONTEXT.has(event) && item.exitCode === 0)
        additionalContext.push(item.plainText);
      if (event === "WorktreeCreate" && item.exitCode === 0 && item.plainText)
        worktreePath = item.plainText.trim().split(/\r?\n/).filter(Boolean).at(-1);
      continue;
    }
    if (output.continue === false && !discardsContinue) {
      continueProcessing = false;
      stopReason ??= isStringValue(output.stopReason) ? output.stopReason : undefined;
    }
    if (isStringValue(output.systemMessage) && !discardsMessage)
      systemMessages.push(output.systemMessage);
    if (isStringValue(output.additionalContext)) additionalContext.push(output.additionalContext);
    if (event === "PostToolUse" && output.updatedToolOutput !== undefined)
      updatedToolOutput = output.updatedToolOutput;
    if (output.decision === "block" && DECISION_BLOCKS.has(event)) {
      blocked = true;
      decisionReason ??= output.reason;
    }
    const specific =
      item.exitCode === 2 && (event === "Elicitation" || event === "ElicitationResult")
        ? undefined
        : output.hookSpecificOutput;
    if (!specific || specific.hookEventName !== event) {
      if (event === "WorktreeCreate" && item.exitCode === 0 && item.plainText)
        worktreePath = item.plainText.trim().split(/\r?\n/).filter(Boolean).at(-1);
      continue;
    }
    if (isStringValue(specific.additionalContext))
      additionalContext.push(specific.additionalContext);
    const candidate = specific.permissionDecision;
    if (
      (event === "PreToolUse" || event === "PreModelSwitch") &&
      (candidate === "allow" ||
        candidate === "ask" ||
        (candidate === "defer" && event === "PreToolUse") ||
        candidate === "deny")
    ) {
      if (
        !permissionDecision ||
        PERMISSION_ORDER[candidate] > PERMISSION_ORDER[permissionDecision]
      ) {
        permissionDecision = candidate;
        if (isStringValue(specific.permissionDecisionReason))
          decisionReason = specific.permissionDecisionReason;
      }
      if (
        event === "PreToolUse" &&
        (candidate === "allow" || candidate === "ask") &&
        specific.updatedInput &&
        parseRuntimeRecord(specific.updatedInput)
      ) {
        // SAFETY: updatedInput is a validated JSON hook property bag.
        updatedInput = specific.updatedInput as JsonObject;
      }
    }
    if (event === "PostToolUse" && specific.updatedToolOutput !== undefined)
      updatedToolOutput = specific.updatedToolOutput;
    if (event === "PostToolUse" && specific.updatedMCPToolOutput !== undefined)
      updatedMCPToolOutput = specific.updatedMCPToolOutput;
    if (event === "MessageDisplay" && isStringValue(specific.displayContent))
      displayContent = specific.displayContent;
    if (event === "WorktreeCreate" && isStringValue(specific.worktreePath))
      worktreePath = specific.worktreePath;
    if (
      event === "PermissionRequest" &&
      specific.decision &&
      parseRuntimeRecord(specific.decision)
    ) {
      // SAFETY: PermissionRequest decision is a validated hook property bag.
      const decision = specific.decision as JsonObject;
      if (decision.behavior === "deny") {
        permissionRequestDecision = "deny";
        blocked = true;
        if (isStringValue(decision.message)) decisionReason = decision.message;
      }
      if (decision.behavior === "allow") permissionRequestDecision = "allow";
      if (decision.behavior === "allow" && Array.isArray(decision.updatedPermissions))
        updatedPermissions = decision.updatedPermissions;
      if (decision.updatedInput && parseRuntimeRecord(decision.updatedInput)) {
        // SAFETY: PermissionRequest updatedInput is a validated hook property bag.
        updatedInput = decision.updatedInput as JsonObject;
      }
    }
    if (event === "PermissionDenied" && specific.retry === true) retry = true;
    if (
      (event === "Elicitation" || event === "ElicitationResult") &&
      (specific.action === "accept" ||
        specific.action === "decline" ||
        specific.action === "cancel")
    ) {
      elicitationAction = specific.action;
      if (specific.content && parseRuntimeRecord(specific.content)) {
        // SAFETY: Elicitation content is a validated JSON hook property bag.
        elicitationContent = specific.content as JsonObject;
      }
    }
    if (event === "SessionStart") {
      if (isStringValue(specific.initialUserMessage))
        initialUserMessage = specific.initialUserMessage;
      if (isStringValue(specific.sessionTitle)) sessionTitle = specific.sessionTitle;
      if (Array.isArray(specific.watchPaths) && specific.watchPaths.every(isStringValue)) {
        // SAFETY: every watchPaths element passed the string schema check.
        watchPaths = specific.watchPaths as string[];
      }
      if (specific.reloadSkills === true) reloadSkills = true;
    }
    if (event === "UserPromptSubmit") {
      if (isStringValue(specific.sessionTitle)) sessionTitle = specific.sessionTitle;
      if (specific.suppressOriginalPrompt === true) suppressOriginalPrompt = true;
    }
    if (
      (event === "CwdChanged" || event === "FileChanged") &&
      Array.isArray(specific.watchPaths) &&
      specific.watchPaths.every(isStringValue)
    ) {
      // SAFETY: every watchPaths element passed the string schema check.
      watchPaths = specific.watchPaths as string[];
    }
  }
  if (permissionDecision === "deny") blocked = true;
  // `continue: false` takes precedence; a JSON decision's reason replaces exit-code stderr.
  const reason = continueProcessing
    ? (decisionReason ?? exitReason ?? stopReason)
    : (stopReason ?? decisionReason ?? exitReason);
  return {
    invocations,
    blocked,
    continue: continueProcessing,
    reason,
    systemMessages,
    terminalSequences,
    additionalContext,
    exitTwoStderr,
    permissionDecision,
    permissionRequestDecision,
    updatedInput,
    updatedToolOutput,
    updatedMCPToolOutput,
    displayContent,
    worktreePath,
    retry,
    elicitationAction,
    elicitationContent,
    initialUserMessage,
    sessionTitle,
    suppressOriginalPrompt,
    watchPaths,
    reloadSkills,
    updatedPermissions,
  };
}
