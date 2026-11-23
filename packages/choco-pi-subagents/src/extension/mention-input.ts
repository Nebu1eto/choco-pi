import type { TypeInfo } from "../ui/agent-mention.ts";
import { getAvailableTypes, getAgentConfig, resolveSpawnType } from "../agent-types.ts";
import {
  parseMention,
  isReservedHandle,
  stripAgentPrefix,
  resolveHandleToType,
  handleBase,
  describeMention,
} from "../mention.ts";
import type { AgentRecord } from "../types.ts";
import { issueExemptTicket } from "../review-rounds.ts";
import { getOutputTranscriptDefault } from "../output-file.ts";
import { normalizeMaxTurns, getDefaultMaxTurns } from "../agent-runner.ts";
import { ResumeModelError } from "../agent-manager.ts";
import { pathExists } from "../fs-async.ts";
import { runMentionClone, shouldHandleMentionCloneCompletion } from "../mention-clone.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentsRuntime } from "./runtime.ts";

export function installMentionInput(pi: ExtensionAPI, rt: SubagentsRuntime) {
  const mentionTypes = (): TypeInfo[] =>
    getAvailableTypes().map((name) => ({
      name,
      description: getAgentConfig(name)?.description ?? name,
    }));

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || !rt.preferences.isAgentMentionsEnabled())
      return { action: "continue" };
    const canDispatchDirectly = ctx.mode === "tui";
    if (!canDispatchDirectly && rt.preferences.getAgentMentionMode() !== "model")
      return { action: "continue" };

    const mention = parseMention(event.text);
    if (!mention) return { action: "continue" };

    if (isReservedHandle(mention.handle)) {
      return {
        action: "transform",
        text: mention.message,
        ...(event.images && { images: event.images }),
      };
    }

    const alias = stripAgentPrefix(mention.handle);
    const resolved =
      rt.core.manager.resolveMention(mention.handle) ??
      (alias ? rt.core.manager.resolveMention(alias) : undefined);

    const dormant =
      resolved?.kind === "live"
        ? undefined
        : (rt.core.manager.findDormantByHandle(mention.handle) ??
          (alias ? rt.core.manager.findDormantByHandle(alias) : undefined));
    if ((resolved || dormant) && !canDispatchDirectly) return { action: "continue" };

    if (resolved?.kind === "live") {
      const record = resolved.record;
      const target = `@${record.alias ?? record.handle ?? mention.handle}`;

      if (record.status === "running" || record.status === "queued") {
        record.resultConsumed = false;
        rt.core.manager.journalRecord(record.id);
        rt.core.manager.steer(record.id, mention.message);
        rt.notifications.emitLifecycle("subagents:steered", {
          id: record.id,
          message: mention.message,
        });
        ctx.ui.notify(`Sent to ${target}`, "info");
        return { action: "handled" };
      }

      if (record.session) {
        const config = getAgentConfig(record.type);
        let resumedRecord: AgentRecord | undefined;
        try {
          resumedRecord = await rt.background.startBackgroundResume(ctx, record, mention.message, {
            reviewTicket: issueExemptTicket("user-mention"),
            outputTranscript: config?.outputTranscript ?? getOutputTranscriptDefault(),
            maxTurns: normalizeMaxTurns(config?.maxTurns ?? getDefaultMaxTurns()),
          });
        } catch (error) {
          if (!(error instanceof ResumeModelError)) throw error;
          ctx.ui.notify(`Could not resume ${target}: ${error.message}`, "warning");
          return { action: "handled" };
        }
        ctx.ui.notify(
          resumedRecord
            ? `Resuming ${target}`
            : `Could not resume ${target} — it is still running.`,
          resumedRecord ? "info" : "warning",
        );
        return { action: "handled" };
      }
    }

    if (dormant !== undefined) {
      const target = `@${dormant.alias ?? dormant.handle ?? mention.handle}`;
      if (rt.core.manager.isRevivalPending(dormant.id)) {
        ctx.ui.notify(`${target} is being revived right now; try again in a moment.`, "warning");
        return { action: "handled" };
      }
      if (!rt.core.manager.canResumeDormant(dormant.id)) {
        ctx.ui.notify(`Could not resume ${target} \u2014 it has no saved session.`, "warning");
        return { action: "handled" };
      }
      const generation = rt.state.revivalGeneration;
      rt.core.manager
        .resumeDormant(dormant.id, mention.message, rt.revival.revivalContext(ctx, generation), {
          reviewTicket: issueExemptTicket("user-mention"),
        })
        .then(
          () => {
            if (generation === rt.state.revivalGeneration)
              ctx.ui.notify(`Resumed ${target}`, "info");
          },
          (error) => {
            if (generation !== rt.state.revivalGeneration) return;
            ctx.ui.notify(
              `Could not resume ${target}: ${error instanceof Error ? error.message : String(error)}`,
              "warning",
            );
          },
        );
      ctx.ui.notify(`Resuming ${target}\u2026`, "info");
      return { action: "handled" };
    }

    if (resolved?.kind === "tombstone") {
      const entry = resolved.entry;
      const target = `@${entry.alias ?? entry.handle}`;

      const sessionGeneration = rt.state.revivalGeneration;
      const sessionFileExists = await pathExists(entry.sessionFile);
      if (sessionGeneration !== rt.state.revivalGeneration) return { action: "continue" };
      if (!sessionFileExists) {
        rt.core.manager.dropTombstone(entry.handle);
        ctx.ui.notify(`Could not resume ${target} — its session is gone.`, "warning");
        return { action: "handled" };
      }

      if (!(await rt.revival.refreshAgentsForSession())) return { action: "continue" };
      const dispatch = resolveSpawnType(entry.type);
      if (!dispatch.ok || dispatch.fellBackFrom !== undefined) {
        ctx.ui.notify(
          `Could not resume ${target} — the ${entry.type} agent is no longer available.`,
          "warning",
        );
        return { action: "handled" };
      }

      try {
        rt.registry.spawnResolved(pi, ctx, dispatch.type, mention.message, {
          description: entry.description,
          reclaim: { handle: entry.handle, alias: entry.alias },
          resumeSessionFile: entry.sessionFile,
          isBackground: true,
          reviewTicket: issueExemptTicket("user-mention"),
        });
        ctx.ui.notify(`Resuming ${target}`, "info");
      } catch (err) {
        ctx.ui.notify(
          `Could not resume ${target}: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
      return { action: "handled" };
    }

    if (!(await rt.revival.refreshAgentsForSession())) return { action: "continue" };
    const typeHandle = mention.handle;
    const type =
      resolveHandleToType(typeHandle, getAvailableTypes()) ??
      (alias ? resolveHandleToType(alias, getAvailableTypes()) : undefined);
    if (!type) return { action: "continue" };

    if (rt.preferences.getAgentMentionMode() === "model") {
      const label = `@${handleBase(type)}`;
      ctx.ui.notify(`Prompting ${label}…`, "info");
      const mentionCloneGeneration = rt.state.activeMentionCloneGeneration;
      void runMentionClone({
        ctx,
        type,
        message: mention.message,
        agentTool: rt.agentTool.agentTool,
      }).then((result) => {
        if (
          !shouldHandleMentionCloneCompletion(
            mentionCloneGeneration,
            rt.state.activeMentionCloneGeneration,
          ) ||
          result.spawned
        )
          return;
        try {
          rt.registry.spawnTopLevel(pi, ctx, type, mention.message, {
            description: describeMention(mention.message),
            isBackground: true,
            reviewTicket: issueExemptTicket("user-mention"),
          });
          ctx.ui.notify(`Started ${label} directly — ${result.error}`, "warning");
        } catch (err) {
          ctx.ui.notify(
            `Could not start ${label}: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
        }
      });
      return { action: "handled" };
    }

    try {
      rt.registry.spawnTopLevel(pi, ctx, type, mention.message, {
        description: describeMention(mention.message),
        isBackground: true,
        reviewTicket: issueExemptTicket("user-mention"),
      });
      ctx.ui.notify(`Started @${handleBase(type)}`, "info");
    } catch (err) {
      ctx.ui.notify(
        `Could not start @${handleBase(type)}: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
    return { action: "handled" };
  });

  return { mentionTypes };
}
