import { propertiesWhen, type RuntimeValue } from "../../lib/runtime-values.ts";
import type { SlashCommand } from "@earendil-works/pi-tui";
import { REVIEW_CHAT_THINKING_LEVELS, type ReviewChatContext } from "../core/ask.ts";
import { refresh } from "./review-view-actions.ts";
import { hiddenPaths } from "./review-view-comments.ts";
import { leave } from "./review-view-lifecycle.ts";
import { notify, setFocus, type ReviewContext, type ReviewSession } from "./review-view-state.ts";

export function createChatCommands(ctx: ReviewSession): SlashCommand[] {
  return [
    {
      name: "model",
      description: "Switch the chat's model",
      argumentHint: "<provider/model>",
      getArgumentCompletions: async (argumentPrefix) => {
        const models = (await ctx.options.listChatModels?.().catch(() => [])) ?? [];
        const needle = argumentPrefix.trim().toLowerCase();
        const matches = models.filter((model) => model.toLowerCase().includes(needle));
        return matches.length === 0
          ? null
          : matches.map((model) => ({ value: model, label: model }));
      },
    },
    {
      name: "effort",
      description: "Switch the chat's thinking level",
      argumentHint: "<level>",
      getArgumentCompletions: (argumentPrefix) => {
        const needle = argumentPrefix.trim().toLowerCase();
        const matches = REVIEW_CHAT_THINKING_LEVELS.filter((level) => level.startsWith(needle));
        return matches.length === 0
          ? null
          : matches.map((level) => ({ value: level, label: level }));
      },
    },
    {
      name: "reload",
      description: "Reload the chat session's extensions, skills, prompts, and context files",
    },
    {
      name: "quit",
      description: "Save the review and leave, like q",
    },
    {
      name: "exit",
      description: "Save the review and leave, like q",
    },
  ];
}

export function refreshChatCommands(ctx: ReviewContext): void {
  if (!ctx.chat) return;
  const known = new Set(ctx.chatCommands.map((command) => command.name));
  for (const info of ctx.chat.commands()) {
    if (known.has(info.name)) continue;
    known.add(info.name);
    ctx.chatCommands.push({
      name: info.name,
      ...propertiesWhen(info.description, () => ({ description: info.description })),
    });
  }
  ctx.tui.requestRender();
}

export function watchToolCalls(ctx: ReviewContext): void {
  const current = ctx.chat;
  if (!current || ctx.closed) return;
  let finished = false;
  for (const message of current.messages) {
    if (message.role !== "tool" || !message.done || ctx.seenTools.has(message.toolCallId)) continue;
    ctx.seenTools.add(message.toolCallId);
    finished = true;
  }
  if (finished && ctx.store.canRefresh) void refresh(ctx, "tool");
}

export function openChat(ctx: ReviewContext): void {
  try {
    if (!ctx.chat) {
      ctx.chat = ctx.createChat({
        cwd: ctx.options.reviewRoot,
        hiddenPaths: () => hiddenPaths(ctx),
        ...propertiesWhen(ctx.options.chatModel, () => ({ model: ctx.options.chatModel })),
        ...propertiesWhen(ctx.options.chatThinkingLevel, () => ({
          thinkingLevel: ctx.options.chatThinkingLevel,
        })),
      });
      ctx.unsubscribeChat = ctx.chat.onUpdate(() => {
        watchToolCalls(ctx);
        ctx.tui.requestRender();
      });
      void ctx.chat
        .prepare(ctx.options.reviewRoot)
        .then(() => refreshChatCommands(ctx))
        .catch(() => undefined);
    }
    ctx.chatOpen = true;
    setFocus(ctx, "chat");
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "error");
  }
}

export function chatContext(ctx: ReviewContext): ReviewChatContext | undefined {
  const position = ctx.changes.commentPosition();
  const current = ctx.changes.currentDisplayHunk();
  const focused = current?.hunk.lines[ctx.changes.cursorLine ?? -1];
  if (!position || !current || !focused) return undefined;
  const hidden = hiddenPaths(ctx);
  return {
    path: position.path,
    side: position.side,
    line: position.line,
    focusedLineText: focused.text,
    hunkHeader: current.hunk.header,
    reviewRoot: ctx.options.reviewRoot,
    ...propertiesWhen(hidden.length, () => ({ hiddenPaths: hidden })),
  };
}

export function closeChat(ctx: ReviewContext): void {
  ctx.chatOpen = false;
  setFocus(ctx, "review");
}

export async function handleChatCommand(
  ctx: ReviewContext,
  kind: "model" | "effort" | "reload",
  argument: string,
): Promise<void> {
  if (!ctx.chat) return;
  try {
    if (kind === "reload") {
      await ctx.chat.reload();
      if (ctx.closed) return;
      notify(
        ctx,
        "Chat session resources reloaded: extensions, skills, prompts, and context files.",
        "info",
      );
      return;
    }
    if (kind === "model") {
      if (!argument) {
        notify(
          ctx,
          `Chat model: ${ctx.chat.status.model ?? "Pi default"} · effort ${ctx.chat.status.thinkingLevel ?? "default"}`,
          "info",
        );
        return;
      }
      const applied = await ctx.chat.setModel(argument);
      if (ctx.closed) return;
      notify(ctx, `Chat model set to ${applied}.`, "info");
      return;
    }
    if (!argument) {
      notify(
        ctx,
        `Chat effort: ${ctx.chat.status.thinkingLevel ?? "default"} · levels: off, minimal, low, medium, high, xhigh, max`,
        "info",
      );
      return;
    }
    const applied = await ctx.chat.setThinkingLevel(argument);
    if (ctx.closed) return;
    notify(ctx, `Chat effort set to ${applied}.`, "info");
  } catch (error) {
    if (ctx.closed) return;
    notify(ctx, error instanceof Error ? error.message : String(error), "error");
  } finally {
    ctx.tui.requestRender();
  }
}

export function submitChat(ctx: ReviewContext, question: string): void {
  const prompt = question.trim();
  ctx.chatInput.remember(question);
  if (!ctx.chat || prompt.length === 0) return;
  const command = prompt.match(/^\/(model|effort|reload|quit|exit)(?:\s+(.*))?$/);
  if (command) {
    ctx.chatInput.setText("");
    if (command[1] === "quit" || command[1] === "exit") {
      leave(ctx);
      return;
    }
    const kind = command[1] === "model" ? "model" : command[1] === "effort" ? "effort" : "reload";
    void handleChatCommand(ctx, kind, command[2]?.trim() ?? "");
    return;
  }
  const sessionCommand = prompt.match(/^\/(\S+)(?:\s|$)/);
  if (sessionCommand) {
    const name = sessionCommand[1]!;
    if (!ctx.chat.commands().some((info) => info.name === name)) {
      ctx.chatInput.setText(prompt);
      notify(ctx, `/${name} is not available in the review chat.`, "warning");
      ctx.tui.requestRender();
      return;
    }
    ctx.chatInput.setText("");
    ctx.tui.requestRender();
    void ctx.chat.runCommand(prompt, ctx.options.reviewRoot).catch((error: RuntimeValue) => {
      notify(ctx, error instanceof Error ? error.message : String(error), "error");
      ctx.tui.requestRender();
    });
    return;
  }
  if (ctx.chat.pending) return;
  const context = chatContext(ctx);
  if (!context) {
    notify(ctx, "Select an expanded diff line before asking the agent.", "warning");
    return;
  }
  ctx.chatScrollOffset = 0;
  ctx.chatInput.setText("");
  ctx.tui.requestRender();
  try {
    void ctx.chat.ask(prompt, context).catch((error: RuntimeValue) => {
      notify(ctx, error instanceof Error ? error.message : String(error), "error");
      ctx.tui.requestRender();
    });
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "error");
  }
}
