/**
 * Adapter-owned builtin slash commands: their advertised catalog entries and the local
 * handlers that answer them without a model turn.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AvailableCommand, PromptResponse } from "@agentclientprotocol/sdk";
import { type BoundaryValue, errorMessage } from "../boundary.ts";
import { findPiChangelog, pathExists } from "./agent-pi-version.ts";
import { missingPiCapability } from "./agent-rpc.ts";
import { parseCommandArgs } from "./slash-commands.ts";
import type { SlashInvocation } from "./pi-commands.ts";
import type { PiAcpSession } from "./session.ts";

/** The builtin commands the adapter advertises; Pi-discovered commands of the same name win. */
export function builtinAvailableCommands(): AvailableCommand[] {
  return [
    {
      name: "compact",
      description: "Manually compact the session context",
      input: { hint: "optional custom instructions" },
    },
    {
      name: "autocompact",
      description: "Toggle automatic context compaction",
      input: { hint: "on|off|toggle" },
    },
    {
      name: "export",
      description: "Export session to an HTML file in the session cwd",
    },
    {
      name: "session",
      description: "Show session stats (messages, tokens, cost, session file)",
    },
    {
      name: "name",
      description: "Set session display name",
      input: { hint: "<name>" },
    },
    {
      name: "steering",
      description:
        "Get/set pi steering message delivery mode (how queued steering messages are delivered)",
      input: { hint: "(no args to show) all | one-at-a-time" },
    },
    {
      name: "follow-up",
      description:
        "Get/set pi follow-up message delivery mode (how queued follow-up messages are delivered)",
      input: { hint: "(no args to show) all | one-at-a-time" },
    },
    {
      name: "changelog",
      description: "Show pi changelog",
    },
  ];
}

/** What a builtin command needs from the agent beyond its session. */
export type BuiltinCommandContext = {
  /** The Pi command whose installation `/changelog` describes. */
  readonly piCommand: string | undefined;
  /** Throws when the agent was disposed or replaced since the prompt began. */
  assertCurrent(): void;
};

/**
 * Answer an adapter-owned builtin slash command. Returns the prompt response when the
 * command was handled here, or undefined so the text goes to Pi as an ordinary prompt.
 */
export async function runBuiltinCommand(
  session: PiAcpSession,
  invocation: SlashInvocation,
  context: BuiltinCommandContext,
): Promise<PromptResponse | undefined> {
  const trimmed = invocation.text;
  const space = trimmed.indexOf(" ");
  const cmd = invocation.name;
  const argsString = space === -1 ? "" : trimmed.slice(space + 1);
  const args = parseCommandArgs(argsString);

  if (cmd === "compact") {
    const customInstructions = args.join(" ").trim() || undefined;
    const compact = session.proc.compact;
    if (!compact) throw missingPiCapability("compact");
    const result = await compact.call(session.proc, customInstructions);

    const tokensBefore = result.tokensBefore ?? null;
    const summary = result.summary ?? null;

    const headerLines = [
      `Compaction completed.${customInstructions ? " (custom instructions applied)" : ""}`,
      tokensBefore !== null ? `Tokens before: ${tokensBefore}` : null,
    ].filter(Boolean);

    const text = headerLines.join("\n") + (summary ? `\n\n${summary}` : "");

    await session.sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    });

    return { stopReason: "end_turn" };
  }

  if (cmd === "session") {
    const getSessionStats = session.proc.getSessionStats;
    if (!getSessionStats) throw missingPiCapability("get_session_stats");
    const stats = await getSessionStats.call(session.proc);

    const lines: string[] = [];
    if (stats.sessionId) lines.push(`Session: ${stats.sessionId}`);
    if (stats.sessionFile) lines.push(`Session file: ${stats.sessionFile}`);
    if (stats.totalMessages !== undefined) lines.push(`Messages: ${stats.totalMessages}`);

    if (stats.cost !== undefined) lines.push(`Cost: ${stats.cost}`);

    const t = stats.tokens;
    if (t) {
      const parts: string[] = [];
      if (t.input !== undefined) parts.push(`in ${t.input}`);
      if (t.output !== undefined) parts.push(`out ${t.output}`);
      if (t.cacheRead !== undefined) parts.push(`cache read ${t.cacheRead}`);
      if (t.cacheWrite !== undefined) parts.push(`cache write ${t.cacheWrite}`);
      if (t.total !== undefined) parts.push(`total ${t.total}`);
      if (parts.length) lines.push(`Tokens: ${parts.join(", ")}`);
    }

    // Fallback if stats shape changes.
    const text = lines.length
      ? lines.join("\n")
      : `Session stats:\n${JSON.stringify(stats, null, 2)}`;

    await session.sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    });

    return { stopReason: "end_turn" };
  }

  if (cmd === "name") {
    const name = args.join(" ").trim();
    if (!name) {
      await session.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Usage: /name <name>" },
      });
      return { stopReason: "end_turn" };
    }

    try {
      const setSessionName = session.proc.setSessionName;
      if (!setSessionName) throw missingPiCapability("set_session_name");
      await setSessionName.call(session.proc, name);
    } catch (error) {
      // SAFETY: catch bindings may contain any thrown JavaScript value; `errorMessage`
      // handles Error instances and stringifies every other boundary value.
      const msg = errorMessage(error as BoundaryValue);
      const hint = /set_session_name/i.test(msg)
        ? " This requires a newer pi version that supports `set_session_name` in RPC mode."
        : "";

      await session.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `Failed to set session name: ${msg}${hint}` },
      });
      return { stopReason: "end_turn" };
    }

    await session.sendUpdate({
      sessionUpdate: "session_info_update",
      title: name,
      updatedAt: new Date().toISOString(),
    });

    await session.sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `Session name set: ${name}` },
    });

    return { stopReason: "end_turn" };
  }

  if (cmd === "steering") {
    const modeRaw = String(args[0] ?? "").toLowerCase();
    const getState = session.proc.getState;
    if (!getState) throw missingPiCapability("get_state");
    const state = await getState.call(session.proc);
    const current = String(state.steeringMode ?? "");

    // If no arg, just report current.
    if (!modeRaw) {
      await session.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `Steering mode: ${current || "unknown"}`,
        },
      });
      return { stopReason: "end_turn" };
    }

    if (modeRaw !== "all" && modeRaw !== "one-at-a-time") {
      await session.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Usage: /steering all | /steering one-at-a-time",
        },
      });
      return { stopReason: "end_turn" };
    }

    const setSteeringMode = session.proc.setSteeringMode;
    if (!setSteeringMode) throw missingPiCapability("set_steering_mode");
    await setSteeringMode.call(session.proc, modeRaw);

    await session.sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `Steering mode set to: ${modeRaw}` },
    });

    return { stopReason: "end_turn" };
  }

  if (cmd === "follow-up") {
    const modeRaw = String(args[0] ?? "").toLowerCase();
    const getState = session.proc.getState;
    if (!getState) throw missingPiCapability("get_state");
    const state = await getState.call(session.proc);
    const current = String(state.followUpMode ?? "");

    // If no arg, just report current.
    if (!modeRaw) {
      await session.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `Follow-up mode: ${current || "unknown"}`,
        },
      });
      return { stopReason: "end_turn" };
    }

    if (modeRaw !== "all" && modeRaw !== "one-at-a-time") {
      await session.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Usage: /follow-up all | /follow-up one-at-a-time",
        },
      });
      return { stopReason: "end_turn" };
    }

    const setFollowUpMode = session.proc.setFollowUpMode;
    if (!setFollowUpMode) throw missingPiCapability("set_follow_up_mode");
    await setFollowUpMode.call(session.proc, modeRaw);

    await session.sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `Follow-up mode set to: ${modeRaw}` },
    });

    return { stopReason: "end_turn" };
  }

  if (cmd === "changelog") {
    // Read pi's installed CHANGELOG.md. Adapter-side, no model call.
    const changelogPath = await findPiChangelog(context.piCommand);
    context.assertCurrent();
    if (!changelogPath) {
      await session.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Changelog not found (couldn't locate pi installation).",
        },
      });
      return { stopReason: "end_turn" };
    }

    let text = "";
    try {
      text = await readFile(changelogPath, "utf-8");
    } catch (error) {
      context.assertCurrent();
      // SAFETY: catch bindings may contain any thrown JavaScript value; `errorMessage`
      // handles Error instances and stringifies every other boundary value.
      const message = errorMessage(error as BoundaryValue);
      await session.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `Failed to read changelog: ${message}`,
        },
      });
      return { stopReason: "end_turn" };
    }
    context.assertCurrent();

    // Keep it reasonably sized in chat.
    const maxChars = 20_000;
    if (text.length > maxChars) text = text.slice(0, maxChars) + "\n\n...(truncated)...";

    await session.sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    });

    return { stopReason: "end_turn" };
  }

  if (cmd === "export") {
    // For now we always export into the session cwd and do not accept a user-provided path.
    // IMPORTANT: pi's export_html reads the session JSONL file. If it doesn't exist yet
    // (no messages) or is empty, pi throws and RPC mode emits an uncorrelated parse error
    // (no id), which would otherwise hang our request. So we guard here.
    const getState = session.proc.getState;
    if (!getState) throw missingPiCapability("get_state");
    const state = await getState.call(session.proc);
    const sessionFile = state.sessionFile ?? null;
    const messageCount = state.messageCount ?? 0;

    if (!sessionFile || messageCount === 0 || !(await pathExists(sessionFile))) {
      await session.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Nothing to export yet (no session messages). Send a prompt first.",
        },
      });
      return { stopReason: "end_turn" };
    }

    try {
      const raw = await readFile(sessionFile, "utf-8");
      if (raw.trim().length === 0) {
        await session.sendUpdate({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Nothing to export yet (empty session file). Send a prompt first.",
          },
        });
        return { stopReason: "end_turn" };
      }
    } catch {
      await session.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Couldn't read session file for export. Try sending a prompt first.",
        },
      });
      return { stopReason: "end_turn" };
    }

    const safeSessionId = session.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const outputPath = join(session.cwd, `pi-session-${safeSessionId}.html`);

    let resultPath = "";
    try {
      const exportHtml = session.proc.exportHtml;
      if (!exportHtml) throw missingPiCapability("export_html");
      const result = await exportHtml.call(session.proc, outputPath);
      resultPath = result.path;
    } catch (error) {
      // SAFETY: catch bindings may contain any thrown JavaScript value; `errorMessage`
      // handles Error instances and stringifies every other boundary value.
      const message = errorMessage(error as BoundaryValue);
      await session.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `Export failed: ${message}`,
        },
      });
      return { stopReason: "end_turn" };
    }

    if (!resultPath) {
      await session.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Export failed: no output path returned by pi.",
        },
      });
      return { stopReason: "end_turn" };
    }

    const uri = `file://${resultPath}`;

    // Emit a short prefix + a resource link. Many clients concatenate chunks into a single
    // assistant message, so this avoids the "link + duplicate plain text" look.
    await session.sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "Session exported: ",
      },
    });

    await session.sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "resource_link",
        name: `pi-session-${safeSessionId}.html`,
        uri,
        mimeType: "text/html",
        title: "Session exported",
      },
    });

    return { stopReason: "end_turn" };
  }

  if (cmd === "autocompact") {
    const mode = (args[0] ?? "toggle").toLowerCase();
    let enabled: boolean | null = null;
    if (mode === "on" || mode === "true" || mode === "enable" || mode === "enabled") enabled = true;
    else if (mode === "off" || mode === "false" || mode === "disable" || mode === "disabled")
      enabled = false;

    if (enabled === null) {
      // toggle: read current state and invert.
      const getState = session.proc.getState;
      if (!getState) throw missingPiCapability("get_state");
      const state = await getState.call(session.proc);
      const current = Boolean(state.autoCompactionEnabled);
      enabled = !current;
    }

    const setAutoCompaction = session.proc.setAutoCompaction;
    if (!setAutoCompaction) throw missingPiCapability("set_auto_compaction");
    await setAutoCompaction.call(session.proc, enabled);

    await session.sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `Auto-compaction ${enabled ? "enabled" : "disabled"}.`,
      },
    });

    return { stopReason: "end_turn" };
  }
  return undefined;
}
