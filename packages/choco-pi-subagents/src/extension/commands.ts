/**
 * Slash command registrations.
 */
import type {
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { resolveBtwType } from "../ui/side-conversation.ts";
import { type RoundClass, stateUnavailableMessage, continueUsage } from "../review-rounds.ts";
import type { SubagentsRuntime } from "./runtime.ts";

/** Registers /btw, /review-continue, /verify-continue, and /agents. */
export function installCommands(pi: ExtensionAPI, rt: SubagentsRuntime) {
  async function handleBtwCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const question = args.trim();
    if (question) {
      if (!(await rt.revival.refreshAgentsForSession())) return;
      const dispatch = resolveBtwType();
      if (!dispatch.ok) {
        ctx.ui.notify(`Could not start BTW conversation: ${dispatch.message}`, "error");
        return;
      }

      try {
        const id = rt.views.sideConversations.launch(pi, ctx, dispatch.type, question);
        const record = rt.core.manager.getRecord(id);
        rt.views.fleet.ensureTimer();
        rt.views.fleet.update();
        rt.notifications.emitLifecycle("subagents:created", {
          id,
          type: dispatch.type,
          description: record?.description ?? question,
          isBackground: true,
          sideConversation: true,
        });
        const handle = record?.alias ?? record?.handle ?? id;
        ctx.ui.notify(
          `${record?.status === "queued" ? "Queued" : "Started"} BTW @${handle}. ${
            ctx.mode === "tui"
              ? "Esc dismisses without stopping it."
              : "Its answer will be posted here when it finishes."
          }`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `Could not start BTW conversation: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
      return;
    }

    const records = rt.core.manager
      .listAgents()
      .filter((record) => record.sideConversation && !record.parentAgentId);
    if (records.length === 0) {
      ctx.ui.notify("No BTW conversations. Start one with /btw <question>.", "info");
      return;
    }

    let selected = records[0];
    if (records.length > 1) {
      const choices = records.map((record) => {
        const handle = record.alias ?? record.handle ?? record.id;
        return `@${handle} · ${record.status} · ${record.description} · ${record.id.slice(0, 8)}`;
      });
      const choice = await ctx.ui.select("BTW conversations", choices);
      if (!choice) return;
      selected = records[choices.indexOf(choice)] ?? selected;
    }

    if (!selected.session) {
      ctx.ui.notify(
        `BTW conversation is ${selected.status}; its session is not available yet.`,
        "info",
      );
      return;
    }
    rt.views.sideConversations.open(selected);
  }

  pi.registerCommand("btw", {
    description: "Ask a parallel read-only side conversation, or reopen one",
    handler: async (args, ctx) => {
      await handleBtwCommand(args, ctx);
    },
  });

  // User-typed only: no tool can call a command, and no tool parameter approves a round.
  const continueRounds = async (
    roundClass: RoundClass,
    args: string,
    ctx: ExtensionContext,
  ): Promise<void> => {
    let rootSessionId: string;
    try {
      rootSessionId = ctx.sessionManager.getSessionId();
    } catch {
      ctx.ui.notify(stateUnavailableMessage("session unavailable", roundClass), "error");
      return;
    }
    const parts = args
      .trim()
      .split(/\s+/)
      .filter((part) => part !== "");
    if (parts.length === 0) {
      const message = await rt.registry.reviewRounds.summary(rootSessionId, roundClass);
      ctx.ui.notify(message, "info");
      return;
    }
    const roundsText = parts[1];
    const rounds =
      roundsText === undefined ? 1 : /^[0-9]{1,3}$/.test(roundsText) ? Number(roundsText) : 0;
    if (parts.length > 2 || rounds === 0) {
      ctx.ui.notify(continueUsage(roundClass), "warning");
      return;
    }
    const result = await rt.registry.reviewRounds.grant(
      rootSessionId,
      parts[0],
      rounds,
      roundClass,
    );
    ctx.ui.notify(result.message, result.ok ? "info" : "warning");
  };
  pi.registerCommand("review-continue", {
    description:
      "Review rounds per work task, or authorize more: /review-continue [<work_task> [rounds 1-3]]",
    handler: async (args, ctx) => {
      await continueRounds("review", args, ctx);
    },
  });
  pi.registerCommand("verify-continue", {
    description:
      "Verification rounds per work task, or authorize more: /verify-continue [<work_task> [rounds 1-3]]",
    handler: async (args, ctx) => {
      await continueRounds("verification", args, ctx);
    },
  });

  pi.registerCommand("agents", {
    description: "Manage agents",
    handler: async (_args, ctx) => {
      await rt.agentsMenu.showAgentsMenu(ctx);
    },
  });
}
