import type { PiMessages } from "../pi-rpc/protocol.ts";
import type { PiAcpSession } from "./session.ts";
import {
  bashCommand,
  bashExitCode,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool,
} from "./translate/bash.ts";
import { normalizePiAssistantText, normalizePiMessageText } from "./translate/pi-messages.ts";
import { toolResultToText } from "./translate/pi-tools.ts";

export async function replayPiMessages(
  session: PiAcpSession,
  messages: PiMessages["messages"],
  cwd: string,
): Promise<void> {
  for (const m of messages) {
    if (m.role === "user") {
      const text = normalizePiMessageText(m.content);
      if (text) {
        await session.sendUpdate({
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text },
        });
      }
    }

    if (m.role === "assistant") {
      const text = normalizePiAssistantText(m.content);
      if (text) {
        await session.sendUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        });
      }
    }

    if (m.role === "toolResult") {
      const toolName = String(m.toolName ?? "tool");
      const toolCallId = String(m.toolCallId ?? crypto.randomUUID());
      const isError = Boolean(m.isError);
      const isBash = isBashTool(toolName);

      if (isBash) {
        const text = bashResultText(m);
        const terminalExitMetadata = bashTerminalExitMeta(toolCallId, bashExitCode(m, isError));
        const updateMetadata = text
          ? Object.assign(bashTerminalOutputMeta(toolCallId, text), terminalExitMetadata)
          : terminalExitMetadata;
        await session.sendUpdate({
          sessionUpdate: "tool_call",
          toolCallId,
          title: bashCommand(m) ?? toolName,
          kind: "execute",
          status: "in_progress",
          content: bashTerminalContent(toolCallId),
          _meta: bashTerminalInfoMeta(toolCallId, cwd),
        });

        await session.sendUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: isError ? "failed" : "completed",
          _meta: updateMetadata,
        });
        continue;
      }

      await session.sendUpdate({
        sessionUpdate: "tool_call",
        toolCallId,
        title: toolName,
        kind:
          toolName === "read"
            ? "read"
            : toolName === "write" || toolName === "edit"
              ? "edit"
              : "other",
        status: "in_progress",
        rawInput: null,
        rawOutput: m,
      });

      const text = toolResultToText(m);
      await session.sendUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: isError ? "failed" : "completed",
        content: text ? [{ type: "content", content: { type: "text", text } }] : null,
        rawOutput: m,
      });
    }
  }
}
