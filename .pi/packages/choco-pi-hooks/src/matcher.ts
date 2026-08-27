import type { HookEventName, JsonObject } from "./types.ts";

const NARROW_EXACT = new Set<HookEventName>(["FileChanged", "StopFailure"]);
const NO_MATCHER = new Set<HookEventName>([
  "UserPromptSubmit",
  "PostToolBatch",
  "Stop",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
  "WorktreeCreate",
  "WorktreeRemove",
  "CwdChanged",
  "MessageDisplay",
]);

export function matcherValue(event: HookEventName, input: JsonObject): string {
  if (
    [
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "PermissionRequest",
      "PermissionDenied",
    ].includes(event)
  )
    return String(input.tool_name ?? "");
  if (event === "SessionStart") return String(input.source ?? "");
  if (event === "Setup") return String(input.trigger ?? "");
  if (event === "SessionEnd") return String(input.reason ?? "");
  if (event === "Notification") return String(input.notification_type ?? "");
  if (event === "SubagentStart" || event === "SubagentStop") return String(input.agent_type ?? "");
  if (event === "PreCompact" || event === "PostCompact") return String(input.trigger ?? "");
  if (event === "ConfigChange") return String(input.source ?? "");
  if (event === "DirectoryAdded") return String(input.source ?? "");
  if (event === "FileChanged")
    return (
      String(input.file_path ?? "")
        .replaceAll("\\", "/")
        .split("/")
        .at(-1) ?? ""
    );
  if (event === "StopFailure") return String(input.error ?? "");
  if (event === "InstructionsLoaded") return String(input.load_reason ?? "");
  if (event === "UserPromptExpansion") return String(input.command_name ?? "");
  if (event === "Elicitation" || event === "ElicitationResult")
    return String(input.mcp_server_name ?? "");
  return "";
}

export function matches(
  event: HookEventName,
  matcher: string | undefined,
  input: JsonObject,
): boolean {
  if (NO_MATCHER.has(event)) return true;
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  const value = matcherValue(event, input);
  const exactChars = NARROW_EXACT.has(event) ? /^[A-Za-z0-9_|]+$/ : /^[A-Za-z0-9_\- ,|]+$/;
  if (exactChars.test(matcher)) {
    const separator = NARROW_EXACT.has(event) ? /\|/ : /[|,]/;
    return matcher.split(separator).some((part) => part.trim() === value);
  }
  try {
    return new RegExp(matcher).test(value);
  } catch {
    return false;
  }
}
