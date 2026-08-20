import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

const RUNNING_SESSION_GUIDANCE =
  /Session (\d+) still running\. Resume near completion with (?:tools\.)?write_stdin and an appropriate yield_time_ms(?:; do not use wait)?/g;
const CLOSED_STDIN_GUIDANCE =
  "stdin is closed for this session; rerun exec_command with tty=true to keep stdin open";

type ToolContent = { type: string; text?: string };

export function clarifyExecSessionGuidance<T extends ToolContent>(content: T[]): T[] {
  let changed = false;
  const clarified = content.map((item) => {
    if (item.type !== "text" || typeof item.text !== "string") return item;

    const text = item.text
      .replace(
        RUNNING_SESSION_GUIDANCE,
        (_match, sessionId: string) =>
          `Exec command session ${sessionId} is still running. Wait near completion with tools.write_stdin({ session_id: ${sessionId}, yield_time_ms: ... }) and omit chars. Send chars only when the original exec_command used tty=true; wait is only for a yielded exec cell.`,
      )
      .replace(
        CLOSED_STDIN_GUIDANCE,
        "stdin is closed for this non-TTY session; call write_stdin again without chars to wait for output. Do not rerun the command solely to enable TTY",
      );
    if (text === item.text) return item;
    changed = true;
    return { ...item, text };
  });

  return changed ? clarified : content;
}

export default function execSessionGuidance(pi: ExtensionAPI): void {
  pi.on("tool_result", (event: ToolResultEvent) => {
    if (event.toolName !== "exec") return;
    const content = clarifyExecSessionGuidance(event.content);
    if (content === event.content) return;
    return { content };
  });
}
