/* oxlint-disable eslint/no-control-regex, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion -- Hook JSON is untyped external input and terminal sequence validation intentionally matches control bytes. */
import { executeHandler, parseOutput, type HookBackends } from "./executor.ts";
import { matches } from "./matcher.ts";
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

function glob(pattern: string, value: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\0")
    .replaceAll("*", "[^\\s]*")
    .replaceAll("\0", ".*");
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- Permission glob metacharacters were escaped above.
  return new RegExp(`^${source}$`).test(value);
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
  if (typeof toolInput !== "object" || toolInput === null || Array.isArray(toolInput))
    return pattern === "";
  const candidate = String(toolInput.command ?? toolInput.file_path ?? toolInput.path ?? "");
  if (glob(pattern, candidate)) return true;
  if (String(input.tool_name) === "Bash")
    return candidate.split(/(?:&&|\|\||;|\n)/).some((part) => glob(pattern, part.trim()));
  return false;
}

function validTerminalSequence(value: string): boolean {
  const stripped = value.replace(
    /(?:\x1B\](?:0|1|2|9|99|777);[^\x07\x1B]*(?:\x07|\x1B\\)|\x07)/g,
    "",
  );
  return stripped.length === 0;
}

function modelOutput(handler: HookHandler, parsed: HookOutput | undefined): HookOutput | undefined {
  if ((handler.type !== "prompt" && handler.type !== "agent") || !parsed) return parsed;
  const ok = parsed.ok;
  if (ok === true) return {};
  if (ok !== false || typeof parsed.reason !== "string") return undefined;
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
  constructor(sources: HookSource[], backends: HookBackends = {}) {
    this.sources = sources;
    this.backends = backends;
  }

  async run(input: HookInput): Promise<MergedHookResult> {
    const event = input.hook_event_name;
    const jobs: { source: HookSource; handler: HookHandler; key: string }[] = [];
    const seen = new Set<string>();
    for (const source of this.sources)
      for (const group of source.hooks[event] ?? []) {
        if (!matches(event, group.matcher, input)) continue;
        for (const handler of group.hooks) {
          if (!matchesIf(handler.if, event, input)) continue;
          const key = `${source.kind}:${handlerKey(handler)}`;
          if (seen.has(key) || (handler.once && this.#once.has(key))) continue;
          seen.add(key);
          if (handler.once) this.#once.add(key);
          jobs.push({ source, handler, key });
        }
      }
    const invocations = await Promise.all(
      jobs.map(async ({ source, handler }) => {
        if (handler.type === "command" && (handler.async || handler.asyncRewake)) {
          const pending = executeHandler(handler, input, this.backends).then(() => undefined);
          this.#background.add(pending);
          void pending.finally(() => this.#background.delete(pending));
          return { source, handler, status: "background" } satisfies HookInvocationResult;
        }
        const raw = await executeHandler(handler, input, this.backends);
        const parsed = parseOutput(raw.stdout);
        const output = modelOutput(handler, parsed.output);
        const validationError =
          parsed.validationError ??
          ((handler.type === "prompt" || handler.type === "agent") && parsed.output && !output
            ? "invalid model hook response"
            : undefined);
        const blocking = raw.exitCode === 2 && EXIT_TWO_BLOCKS.has(event);
        let status: HookInvocationResult["status"] = "success";
        if (raw.timedOut) status = "timeout";
        else if (blocking) status = "blocking";
        else if (validationError || raw.exitCode !== 0) status = "error";
        return {
          source,
          handler,
          status,
          exitCode: raw.exitCode,
          output,
          plainText: parsed.plainText,
          stderr: raw.stderr,
          error: validationError,
        } satisfies HookInvocationResult;
      }),
    );
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
      reason ??= typeof output.stopReason === "string" ? output.stopReason : undefined;
    }
    if (typeof output.systemMessage === "string") systemMessages.push(output.systemMessage);
    if (typeof output.additionalContext === "string")
      additionalContext.push(output.additionalContext);
    if (event === "PostToolUse" && output.updatedToolOutput !== undefined)
      updatedToolOutput = output.updatedToolOutput;
    if (
      typeof output.terminalSequence === "string" &&
      !validTerminalSequence(output.terminalSequence)
    )
      systemMessages.push("Hook returned a disallowed terminal sequence");
    if (output.decision === "block" && DECISION_BLOCKS.has(event)) {
      blocked = true;
      reason ??= output.reason;
    }
    const specific = output.hookSpecificOutput;
    if (!specific || specific.hookEventName !== event) {
      if (event === "WorktreeCreate" && item.exitCode === 0 && item.plainText)
        worktreePath = item.plainText.trim().split(/\r?\n/).filter(Boolean).at(-1);
      continue;
    }
    if (typeof specific.additionalContext === "string")
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
        reason =
          typeof specific.permissionDecisionReason === "string"
            ? specific.permissionDecisionReason
            : reason;
      }
      if (
        specific.updatedInput &&
        typeof specific.updatedInput === "object" &&
        !Array.isArray(specific.updatedInput)
      )
        updatedInput = specific.updatedInput as JsonObject;
    }
    if (event === "PostToolUse" && specific.updatedToolOutput !== undefined)
      updatedToolOutput = specific.updatedToolOutput;
    if (event === "MessageDisplay" && typeof specific.displayContent === "string")
      displayContent = specific.displayContent;
    if (event === "WorktreeCreate" && typeof specific.worktreePath === "string")
      worktreePath = specific.worktreePath;
    if (
      event === "PermissionRequest" &&
      specific.decision &&
      typeof specific.decision === "object" &&
      !Array.isArray(specific.decision)
    ) {
      const decision = specific.decision as JsonObject;
      if (decision.behavior === "deny") {
        blocked = true;
        reason = typeof decision.message === "string" ? decision.message : reason;
      }
      if (decision.behavior === "allow" && Array.isArray(decision.updatedPermissions))
        updatedPermissions = decision.updatedPermissions;
      if (
        decision.updatedInput &&
        typeof decision.updatedInput === "object" &&
        !Array.isArray(decision.updatedInput)
      )
        updatedInput = decision.updatedInput as JsonObject;
    }
    if (event === "PermissionDenied" && specific.retry === true) retry = true;
    if (
      (event === "Elicitation" || event === "ElicitationResult") &&
      (specific.action === "accept" ||
        specific.action === "decline" ||
        specific.action === "cancel")
    ) {
      elicitationAction = specific.action;
      if (
        specific.content &&
        typeof specific.content === "object" &&
        !Array.isArray(specific.content)
      )
        elicitationContent = specific.content as JsonObject;
    }
    if (event === "SessionStart") {
      if (typeof specific.initialUserMessage === "string")
        initialUserMessage = specific.initialUserMessage;
      if (typeof specific.sessionTitle === "string") sessionTitle = specific.sessionTitle;
      if (
        Array.isArray(specific.watchPaths) &&
        specific.watchPaths.every((value) => typeof value === "string")
      )
        watchPaths = specific.watchPaths as string[];
      if (specific.reloadSkills === true) reloadSkills = true;
    }
    if (
      (event === "CwdChanged" || event === "FileChanged") &&
      Array.isArray(specific.watchPaths) &&
      specific.watchPaths.every((value) => typeof value === "string")
    )
      watchPaths = specific.watchPaths as string[];
  }
  if (permissionDecision === "deny") blocked = true;
  return {
    invocations,
    blocked,
    continue: continueProcessing,
    reason,
    systemMessages,
    additionalContext,
    permissionDecision,
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
