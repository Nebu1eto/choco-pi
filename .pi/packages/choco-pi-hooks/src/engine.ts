import { executeHandler, parseOutput, type HookBackends } from "./executor.ts";
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
  "Elicitation",
  "ElicitationResult",
  "WorktreeCreate",
]);
const PLAIN_CONTEXT = new Set<HookEventName>([
  "UserPromptSubmit",
  "UserPromptExpansion",
  "SessionStart",
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
  "TaskCreated",
]);
const PERMISSION_ORDER = { allow: 0, ask: 1, defer: 2, deny: 3 } as const;
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
  const match = rule.match(/^([^()]+)\((.*)\)$/);
  if (!match || String(input.tool_name ?? "") !== match[1]) return false;
  const pattern = match[2] ?? "";
  const toolInput = input.tool_input;
  const toolRecord = parseRuntimeRecord(toolInput);
  if (!toolRecord) return pattern === "";
  const candidate = String(toolRecord.command ?? toolRecord.file_path ?? toolRecord.path ?? "");
  if (glob(pattern, candidate)) return true;
  if (String(input.tool_name) === "Bash")
    return candidate.split(/(?:&&|\|\||;|\n)/).some((part) => glob(pattern, part.trim()));
  return false;
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

function modelOutput(
  event: HookEventName,
  handler: HookHandler,
  parsed: HookOutput | undefined,
): HookOutput | undefined {
  if ((handler.type !== "prompt" && handler.type !== "agent") || !parsed) return parsed;
  const ok = parsed.ok;
  if (ok === true) return {};
  if (ok !== false || !isStringValue(parsed.reason)) return undefined;
  if (
    handler.type === "prompt" &&
    parsed.impossible === true &&
    (event === "Stop" || event === "SubagentStop")
  )
    return {};
  return { decision: "block", reason: parsed.reason, impossible: parsed.impossible };
}

function handlerKey(handler: HookHandler): string {
  return JSON.stringify(handler);
}

export class HookEngine {
  readonly #once = new Set<string>();
  readonly #background = new Set<Promise<void>>();
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
          const key = `${source.kind}:${handlerKey(handler)}`;
          const once = source.kind === "skill" && handler.once === true;
          if (seen.has(key) || (once && this.#once.has(key))) continue;
          seen.add(key);
          if (once) this.#once.add(key);
          jobs.push({ source, handler, key });
        }
      }
    let completionOrder = 0;
    const invocations = await Promise.all(
      jobs.map(async ({ source, handler }) => {
        if (handler.type === "command" && (handler.async || handler.asyncRewake)) {
          const pending = executeHandler(handler, input, this.backends).then(async (raw) => {
            const parsed = parseOutput(raw.stdout);
            const invocation: HookInvocationResult = {
              source,
              handler,
              status: raw.timedOut ? "timeout" : raw.exitCode === 2 ? "blocking" : "success",
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
        const raw = await executeHandler(handler, input, this.backends);
        const parsed = parseOutput(raw.stdout);
        const output = modelOutput(event, handler, parsed.output);
        const validationError =
          parsed.validationError ??
          (handler.type === "http" && parsed.plainText
            ? "HTTP hook response body must be a JSON object"
            : undefined) ??
          ((handler.type === "prompt" || handler.type === "agent") && parsed.output && !output
            ? "invalid model hook response"
            : undefined);
        const blocking = raw.exitCode === 2 && EXIT_TWO_BLOCKS.has(event);
        let status: HookInvocationResult["status"] = "success";
        if (raw.timedOut) status = "timeout";
        else if (blocking) status = "blocking";
        else if (validationError || (raw.exitCode !== 0 && !output)) status = "error";
        return {
          source,
          handler,
          status,
          exitCode: raw.exitCode,
          output,
          plainText: parsed.plainText,
          stderr: raw.stderr,
          error: validationError,
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
}

export function mergeResults(
  event: HookEventName,
  invocations: HookInvocationResult[],
): MergedHookResult {
  let blocked = false;
  let continueProcessing = true;
  let reason: string | undefined;
  let permissionDecision: MergedHookResult["permissionDecision"];
  let permissionRequestDecision: MergedHookResult["permissionRequestDecision"];
  let updatedInput: JsonObject | undefined;
  let updatedToolOutput: JsonValue | undefined;
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
  const systemMessages: string[] = [];
  const terminalSequences: string[] = [];
  const additionalContext: string[] = [];
  for (const item of invocations) {
    const output = item.output;
    if (item.exitCode === 2 && EXIT_TWO_BLOCKS.has(event)) {
      blocked = true;
      reason ??= item.stderr;
    }
    if (!output) {
      if (item.plainText && PLAIN_CONTEXT.has(event) && item.exitCode === 0)
        additionalContext.push(item.plainText);
      if (event === "WorktreeCreate" && item.exitCode === 0 && item.plainText)
        worktreePath = item.plainText.trim().split(/\r?\n/).filter(Boolean).at(-1);
      continue;
    }
    if (output.continue === false) {
      continueProcessing = false;
      reason ??= isStringValue(output.stopReason) ? output.stopReason : undefined;
    }
    if (isStringValue(output.systemMessage)) systemMessages.push(output.systemMessage);
    if (isStringValue(output.additionalContext)) additionalContext.push(output.additionalContext);
    if (event === "PostToolUse" && output.updatedToolOutput !== undefined)
      updatedToolOutput = output.updatedToolOutput;
    if (isStringValue(output.terminalSequence)) {
      if (validTerminalSequence(output.terminalSequence))
        terminalSequences.push(output.terminalSequence);
      else systemMessages.push("Hook returned a disallowed terminal sequence");
    }
    if (output.decision === "block" && DECISION_BLOCKS.has(event)) {
      blocked = true;
      reason ??= output.reason;
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
      event === "PreToolUse" &&
      (candidate === "allow" ||
        candidate === "ask" ||
        candidate === "defer" ||
        candidate === "deny")
    ) {
      if (
        !permissionDecision ||
        PERMISSION_ORDER[candidate] > PERMISSION_ORDER[permissionDecision]
      ) {
        permissionDecision = candidate;
        reason = isStringValue(specific.permissionDecisionReason)
          ? specific.permissionDecisionReason
          : reason;
      }
      if (
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
        reason = isStringValue(decision.message) ? decision.message : reason;
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
  return {
    invocations,
    blocked,
    continue: continueProcessing,
    reason,
    systemMessages,
    terminalSequences,
    additionalContext,
    permissionDecision,
    permissionRequestDecision,
    updatedInput,
    updatedToolOutput,
    displayContent,
    worktreePath,
    retry,
    elicitationAction,
    elicitationContent,
    initialUserMessage,
    sessionTitle,
    watchPaths,
    reloadSkills,
    updatedPermissions,
  };
}
