import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { bool, int, nullable, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { RuntimeValue } from "../runtime-values.ts";
import { hostParams } from "../schema-bridge.ts";
import { SESSION_WAIT_LIMIT_MS } from "../session-communication.ts";
import { toSnakeCaseKeys } from "../tool-output-keys.ts";
import {
  listProjectSessions,
  readSessionTranscript,
  sendSessionMessage,
  waitForSession,
} from "./sessions.ts";
import {
  DEFAULT_READ_LIMIT,
  errorMessage,
  MAX_READ_LIMIT,
  THINKING_LEVELS,
  type SessionSnapshot,
} from "./types.ts";

export type CreateIndependentSessionFn = (
  ctx: ExtensionContext,
  input: { initialPrompt: string; model?: string; effort?: string; name?: string },
) => Promise<SessionSnapshot>;

function toolResult(value: RuntimeValue) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(toSnakeCaseKeys(value), null, 2) }],
    details: value,
  };
}

function commandError(ctx: ExtensionCommandContext, error: RuntimeValue): void {
  ctx.ui.notify(errorMessage(error), "error");
}

async function chooseModel(ctx: ExtensionCommandContext): Promise<string | undefined> {
  const candidates =
    ctx.scopedModels.length > 0
      ? ctx.scopedModels.map((entry) => entry.model)
      : ctx.modelRegistry.getAvailable();
  const labels = candidates.map((model) => `${model.provider}/${model.id}`);
  return ctx.ui.select("Model for the new session", labels);
}

export function installUserCommands(
  pi: ExtensionAPI,
  createIndependentSession: CreateIndependentSessionFn,
): void {
  pi.registerCommand("session-new", {
    description: "Create an independent choco-pi conversation",
    handler: async (_args, ctx) => {
      try {
        const model = await chooseModel(ctx);
        if (!model) return;
        const effort = await ctx.ui.select("Reasoning effort", THINKING_LEVELS);
        if (!effort) return;
        const name = await ctx.ui.input("Session name (optional)");
        const initialPrompt = await ctx.ui.editor("Initial user prompt");
        if (!initialPrompt?.trim()) return;
        const snapshot = await createIndependentSession(ctx, {
          initialPrompt,
          model,
          effort,
          name,
        });
        ctx.ui.notify(JSON.stringify(toSnakeCaseKeys(snapshot), null, 2), "info");
      } catch (error) {
        commandError(ctx, error);
      }
    },
  });

  pi.registerCommand("sessions", {
    description: "List choco-pi conversations for the current project",
    handler: async (args, ctx) => {
      try {
        const sessions = await listProjectSessions(ctx.cwd);
        const requestedLimit = args.trim() ? Number(args.trim()) : sessions.length;
        if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
          throw new Error("Usage: /sessions [positive-limit]");
        }
        ctx.ui.notify(
          JSON.stringify(toSnakeCaseKeys(sessions.slice(0, requestedLimit)), null, 2),
          "info",
        );
      } catch (error) {
        commandError(ctx, error);
      }
    },
  });

  pi.registerCommand("session-send", {
    description: "Steer a live conversation: /session-send <id> [queue|steer] <message>",
    handler: async (args, ctx) => {
      try {
        const match = args.trim().match(/^(\S+)\s+(?:(queue|steer)\s+)?([\s\S]+)$/);
        if (!match) throw new Error("Usage: /session-send <id> [queue|steer] <message>");
        const [, sessionId, mode, message] = match;
        const result = await sendSessionMessage(ctx, {
          sessionId,
          mode: mode === "queue" || mode === "steer" ? mode : undefined,
          message,
        });
        ctx.ui.notify(
          `Steering message submitted via ${result.accepted}; target is ${result.status}.`,
          "info",
        );
      } catch (error) {
        commandError(ctx, error);
      }
    },
  });

  pi.registerCommand("session-read", {
    description: "Read another conversation: /session-read <id> [limit] [include-tools]",
    handler: async (args, ctx) => {
      try {
        const [sessionId, limitValue, includeToolsValue] = args.trim().split(/\s+/, 3);
        if (!sessionId) throw new Error("Usage: /session-read <id> [limit] [include-tools]");
        const limit = limitValue ? Number(limitValue) : DEFAULT_READ_LIMIT;
        if (!Number.isFinite(limit)) throw new Error("Limit must be a number.");
        const includeTools = includeToolsValue === "true" || includeToolsValue === "include-tools";
        const result = await readSessionTranscript(ctx.cwd, sessionId, limit, includeTools);
        ctx.ui.notify(JSON.stringify(toSnakeCaseKeys(result), null, 2), "info");
      } catch (error) {
        commandError(ctx, error);
      }
    },
  });

  pi.registerCommand("session-wait", {
    description: "Wait for another conversation: /session-wait <id> [seconds] [after-cursor]",
    handler: async (args, ctx) => {
      try {
        const [sessionId, secondsValue, afterCursor] = args.trim().split(/\s+/, 3);
        if (!sessionId) throw new Error("Usage: /session-wait <id> [seconds] [after-cursor]");
        const seconds = secondsValue ? Number(secondsValue) : SESSION_WAIT_LIMIT_MS / 1_000;
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > SESSION_WAIT_LIMIT_MS / 1_000)
          throw new Error("Seconds must be between 0 and 5.");
        const result = await waitForSession(
          ctx.cwd,
          sessionId,
          afterCursor === "null" ? null : afterCursor,
          seconds * 1_000,
        );
        ctx.ui.notify(
          JSON.stringify(toSnakeCaseKeys(result), null, 2),
          result.timedOut ? "warning" : "info",
        );
      } catch (error) {
        commandError(ctx, error);
      }
    },
  });
}

export function installAgentTools(
  pi: ExtensionAPI,
  createIndependentSession: CreateIndependentSessionFn,
): void {
  pi.registerTool({
    name: "session_create",
    label: "Create conversation",
    description: "Create and start an independent project conversation.",
    promptSnippet: "Start an independent project conversation.",
    parameters: hostParams(
      obj(
        {
          initial_prompt: str({ description: "Initial user prompt for the new conversation" }),
          model: opt(
            str({ description: "Model as provider/model; defaults to the current model" }),
          ),
          effort: opt(
            oneOf(THINKING_LEVELS, {
              description: "Reasoning effort; defaults to the current effort",
            }),
          ),
          name: opt(str({ description: "Optional session display name" })),
        },
        { open: true },
      ),
    ),
    executionMode: "sequential",
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
      toolResult(
        await createIndependentSession(ctx, {
          initialPrompt: params.initial_prompt,
          model: params.model,
          effort: params.effort,
          name: params.name,
        }),
      ),
  });

  pi.registerTool({
    name: "session_send",
    label: "Send conversation message",
    description:
      "Steer and resume a live conversation. Legacy mode 'queue' is accepted as a deprecated alias for 'steer'.",
    promptSnippet: "Steer another live project conversation.",
    parameters: hostParams(
      obj(
        {
          session_id: str({ description: "Target session ID" }),
          mode: opt(oneOf(["queue", "steer"])),
          message: str({ description: "Message to deliver" }),
        },
        { open: true },
      ),
    ),
    executionMode: "sequential",
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
      toolResult(
        await sendSessionMessage(ctx, {
          sessionId: params.session_id,
          mode: params.mode,
          message: params.message,
        }),
      ),
  });

  pi.registerTool({
    name: "session_list",
    label: "List conversations",
    description: "List persisted conversations for the current project.",
    promptSnippet: "List persisted project conversations.",
    parameters: hostParams(obj({}, { open: true })),
    executionMode: "parallel",
    execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) =>
      toolResult(await listProjectSessions(ctx.cwd)),
  });

  pi.registerTool({
    name: "session_read",
    label: "Read conversation",
    description: "Read recent messages from another persisted conversation.",
    promptSnippet: "Read another conversation's recent messages.",
    parameters: hostParams(
      obj(
        {
          session_id: str({ description: "Session ID to read" }),
          limit: opt(
            int({
              minimum: 1,
              maximum: MAX_READ_LIMIT,
              description: "Maximum transcript items; defaults to 50",
            }),
          ),
          include_tools: opt(
            bool({ description: "Include tool calls and tool results; defaults to false" }),
          ),
        },
        { open: true },
      ),
    ),
    executionMode: "parallel",
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
      toolResult(
        await readSessionTranscript(ctx.cwd, params.session_id, params.limit, params.include_tools),
      ),
  });

  pi.registerTool({
    name: "session_wait",
    label: "Wait for conversation",
    description: "Wait briefly for conversation progress and idle state.",
    promptSnippet: "Wait briefly for another conversation's progress.",
    parameters: hostParams(
      obj(
        {
          session_id: str({ description: "Session ID to wait for" }),
          after_cursor: opt(
            nullable(
              str({
                description: "Cursor returned by session_create, session_read, or session_list",
              }),
            ),
          ),
          timeout_ms: opt(
            int({
              minimum: 0,
              maximum: SESSION_WAIT_LIMIT_MS,
              description: "Wait milliseconds; defaults to and cannot exceed 5000.",
            }),
          ),
        },
        { open: true },
      ),
    ),
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) =>
      toolResult(
        await waitForSession(
          ctx.cwd,
          params.session_id,
          params.after_cursor,
          params.timeout_ms ?? SESSION_WAIT_LIMIT_MS,
          signal,
        ),
      ),
  });
}
