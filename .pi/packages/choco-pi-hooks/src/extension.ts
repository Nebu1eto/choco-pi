/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-known-value-widening, anti-slop/no-conditional-empty-object-spread, anti-slop/require-safety-comment-for-type-assertion -- The adapter converts Pi's typed event unions to the Claude-compatible JSON boundary. */
import crypto from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { loadHookSources } from "./config.ts";
import { HookEngine } from "./engine.ts";
import type { HookEventName, HookInput, JsonObject } from "./types.ts";

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

export default function chocoPiHooks(pi: ExtensionAPI): void {
  let engine = new HookEngine([]);
  let sessionId: string = crypto.randomUUID();
  let transcriptPath = "";

  function reload(ctx: ExtensionContext): void {
    const loaded = loadHookSources({ cwd: ctx.cwd });
    engine = new HookEngine(loaded.sources);
    sessionId = ctx.sessionManager.getSessionId() || sessionId;
    transcriptPath = ctx.sessionManager.getSessionFile() ?? "";
  }
  function input(event: HookEventName, ctx: ExtensionContext, extra: JsonObject = {}): HookInput {
    const hookInput = {
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: ctx.cwd,
      hook_event_name: event,
      permission_mode: "default",
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

  pi.on("session_start", async (event, ctx) => {
    reload(ctx);
    const result = await engine.run(
      input("SessionStart", ctx, { source: sourceForStart(event.reason), model: ctx.model?.id }),
    );
    notify(ctx, result.systemMessages);
    if (result.additionalContext.length)
      pi.sendMessage({
        customType: "choco-pi-hooks",
        content: result.additionalContext.join("\n"),
        display: false,
      });
  });
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    const result = await engine.run(input("UserPromptSubmit", ctx, { prompt: event.text }));
    notify(ctx, result.systemMessages);
    if (result.blocked || !result.continue) {
      if (result.reason && ctx.hasUI) ctx.ui.notify(result.reason, "warning");
      return { action: "handled" } as const;
    }
    if (result.additionalContext.length)
      return {
        action: "transform",
        text: `${event.text}\n\n<hook_context>\n${result.additionalContext.join("\n")}\n</hook_context>`,
        images: event.images,
      } as const;
    return { action: "continue" } as const;
  });
  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    const result = await engine.run(
      input("PreToolUse", ctx, {
        tool_name: claudeToolName(event.toolName),
        tool_input: event.input as JsonObject,
        tool_use_id: event.toolCallId,
      }),
    );
    notify(ctx, result.systemMessages);
    if (result.updatedInput) Object.assign(event.input, result.updatedInput);
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
      tool_input: event.input as JsonObject,
      tool_use_id: event.toolCallId,
    };
    if (event.isError)
      extra.error = event.content
        .flatMap((item) => (item.type === "text" ? [item.text] : []))
        .join("\n");
    else extra.tool_response = { content: event.content as never, details: event.details as never };
    const result = await engine.run(input(name, ctx, extra));
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
            text:
              typeof result.updatedToolOutput === "string"
                ? result.updatedToolOutput
                : JSON.stringify(result.updatedToolOutput),
          },
          ...appended,
        ],
      };
    if (appended.length) return { content: [...event.content, ...appended] };
  });
  pi.on("session_before_compact", async (event, ctx) => {
    const result = await engine.run(
      input("PreCompact", ctx, {
        trigger: event.reason === "manual" ? "manual" : "auto",
        custom_instructions: event.customInstructions ?? "",
      }),
    );
    if (result.blocked || !result.continue) return { cancel: true };
  });
  pi.on("session_compact", async (event, ctx) => {
    await engine.run(
      input("PostCompact", ctx, {
        trigger: event.reason === "manual" ? "manual" : "auto",
        compact_summary: event.compactionEntry.summary,
      }),
    );
  });
  pi.on("agent_end", async (event, ctx) => {
    const last = event.messages.findLast((message) => message.role === "assistant");
    const result = await engine.run(
      input("Stop", ctx, {
        stop_hook_active: false,
        last_assistant_message: textOf(last),
        background_tasks: [],
        session_crons: [],
      }),
    );
    notify(ctx, result.systemMessages);
    if (result.blocked && result.reason)
      pi.sendUserMessage(result.reason, { deliverAs: "followUp" });
    else if (result.additionalContext.length)
      pi.sendUserMessage(result.additionalContext.join("\n"), { deliverAs: "followUp" });
  });
  pi.on("session_shutdown", async (event, ctx) => {
    await engine.run(input("SessionEnd", ctx, { reason: endReason(event.reason) }));
    await engine.waitForBackground();
  });
}
