export const HOOK_EVENTS = [
  "SessionStart",
  "Setup",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "PreToolUse",
  "PermissionRequest",
  "PermissionDenied",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "Notification",
  "MessageDisplay",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "Stop",
  "StopFailure",
  "TeammateIdle",
  "InstructionsLoaded",
  "ConfigChange",
  "CwdChanged",
  "DirectoryAdded",
  "FileChanged",
  "WorktreeCreate",
  "WorktreeRemove",
  "PreCompact",
  "PostCompact",
  "Elicitation",
  "ElicitationResult",
  "SessionEnd",
] as const;

export type HookEventName = (typeof HOOK_EVENTS)[number];
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue | undefined };

export interface HookInput extends JsonObject {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: HookEventName;
  prompt_id?: string;
  permission_mode?: "default" | "plan" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions";
  effort?: { level: "low" | "medium" | "high" | "xhigh" | "max" };
  agent_id?: string;
  agent_type?: string;
}

export interface HookOutput extends JsonObject {
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  terminalSequence?: string;
  decision?: "block";
  reason?: string;
  hookSpecificOutput?: JsonObject;
}

interface HandlerCommon {
  if?: string;
  timeout?: number;
  statusMessage?: string;
  once?: boolean;
}
export interface CommandHook extends HandlerCommon {
  type: "command";
  command: string;
  args?: string[];
  async?: boolean;
  asyncRewake?: boolean;
  shell?: "bash" | "powershell";
}
export interface HttpHook extends HandlerCommon {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
}
export interface McpToolHook extends HandlerCommon {
  type: "mcp_tool";
  server: string;
  tool: string;
  input?: JsonObject;
}
export interface ModelHook extends HandlerCommon {
  type: "prompt" | "agent";
  prompt: string;
  model?: string;
  continueOnBlock?: boolean;
}
export type HookHandler = CommandHook | HttpHook | McpToolHook | ModelHook;
export interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
}
export type HooksConfiguration = Partial<Record<HookEventName, HookGroup[]>>;
export interface SettingsWithHooks {
  hooks?: HooksConfiguration;
  disableAllHooks?: boolean;
}

export interface HookSource {
  id: string;
  kind: "managed" | "user" | "project" | "local" | "plugin" | "skill" | "agent" | "session";
  hooks: HooksConfiguration;
}
export interface HookInvocationResult {
  source: HookSource;
  handler: HookHandler;
  status: "success" | "blocking" | "error" | "timeout" | "background";
  exitCode?: number;
  output?: HookOutput;
  plainText?: string;
  stderr?: string;
  error?: string;
}
export interface MergedHookResult {
  invocations: HookInvocationResult[];
  blocked: boolean;
  continue: boolean;
  reason?: string;
  systemMessages: string[];
  additionalContext: string[];
  permissionDecision?: "deny" | "defer" | "ask" | "allow";
  updatedInput?: JsonObject;
  updatedToolOutput?: JsonValue;
  displayContent?: string;
  worktreePath?: string;
  retry?: boolean;
  elicitationAction?: "accept" | "decline" | "cancel";
  elicitationContent?: JsonObject;
  initialUserMessage?: string;
  sessionTitle?: string;
  watchPaths?: string[];
  reloadSkills?: boolean;
  updatedPermissions?: JsonValue[];
}
