import { inChildSessionContext, isChildSessionId } from "../child-context.ts";
import { describeScratchChange, setPreviousScratchDir } from "@choco-pi/shared/scratch-path";
import { ensureEnabledModels } from "../enabled-models.ts";
import { SUBAGENT_JOURNAL_ENTRY, reduceJournal } from "../revival-journal.ts";
import { compile, obj, arr, str } from "@earendil-works/pi-schema";
import { isDormantRunUnfinished } from "../result-read.ts";
import { installProgramStatusBridge } from "../program-status-bridge.ts";
import { registerSubagentPreferencesProvider } from "../preferences-section.ts";
import {
  parseSubagentMessageNotification,
  renderAgentMessageNotification,
} from "../ui/notification-render.ts";
import { registerRpcHandlers } from "../cross-extension-rpc.ts";
import { createMentionProvider, mentionRoster } from "../ui/agent-mention.ts";
import { getConfig } from "../agent-types.ts";
import {
  printWaitLimitMs,
  PRINT_WAIT_ENV,
  waitForBackgroundSettle,
} from "@choco-pi/shared/print-settle-wait";
import { readStopState } from "@choco-pi/shared/stop-control";
import { createMainCompactionActivity } from "../compaction-activity.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentsRuntime } from "./runtime.ts";

export function installSessionStart(pi: ExtensionAPI, rt: SubagentsRuntime) {
  pi.on("session_start", async (event, ctx) => {
    rt.state.activeMentionCloneGeneration = ++rt.state.nextMentionCloneGeneration;
    const generation = ++rt.state.revivalGeneration;
    rt.state.currentCtx = ctx;
    const startedSessionId = ctx.sessionManager.getSessionId();
    if (rt.registry.ownsManagerRegistry) {
      rt.state.activeRootSessionId = startedSessionId;
      rt.stopControl.subscribeStopControl();
    }
    if (!inChildSessionContext() && !isChildSessionId(startedSessionId)) {
      const change = describeScratchChange({
        reason: event.reason,
        previousSessionFile: event.previousSessionFile,
        currentSessionId: startedSessionId,
      });
      if (change) {
        setPreviousScratchDir(startedSessionId, change.previousScratchDir);
        pi.sendMessage(
          { customType: "choco-pi-scratch", content: change.notice, display: true },
          { deliverAs: "nextTurn" },
        );
      }
    }
    void ensureEnabledModels(ctx.cwd);
    rt.sessionLifecycle.mainCompaction.bind(ctx.sessionManager.getSessionId());
    rt.state.journalActive = rt.revival.journalEligible(ctx);
    const rootSessionId = ctx.sessionManager.getSessionId();
    if (rt.state.journalActive) {
      const sessionManager = ctx.sessionManager;
      rt.core.manager.setJournalSink({
        rootSessionId,
        append: (data) => pi.appendEntry(SUBAGENT_JOURNAL_ENTRY, data),
        reportError: (agentId, error) =>
          console.error(
            `[choco-pi-subagents] Subagent journal write failed for ${agentId}: ${error.message}`,
          ),
      });
      rt.core.manager.setJournalLookup(
        (id) => reduceJournal(sessionManager.getEntries(), rootSessionId).get(id)?.agent,
      );
      rt.core.manager.hydrateDormant(
        [...reduceJournal(sessionManager.getEntries(), rootSessionId).values()].map(
          (snapshot) => snapshot.agent,
        ),
      );
    } else {
      rt.core.manager.setJournalSink(undefined);
    }
    const pendingEntry = ctx.sessionManager
      .getEntries()
      .findLast(
        (entry) => entry.type === "custom" && entry.customType === "subagent-notification-pending",
      );
    const pendingData = pendingEntry?.type === "custom" ? pendingEntry.data : undefined;
    const isPendingNotifications = compile(obj({ keys: arr(str()) }, { open: true })).check;
    const pendingKeys = isPendingNotifications(pendingData) ? pendingData.keys : [];
    rt.notifications.notificationGate.start(
      ctx.sessionManager.getSessionId(),
      pendingKeys.filter((key) => {
        const record = rt.core.manager.getRecord(key);
        if (record !== undefined) return !record.resultConsumed;
        const dormant = rt.core.manager.getDormant(key);
        return (
          dormant !== undefined &&
          dormant.parentAgentId === undefined &&
          !dormant.resultConsumed &&
          !isDormantRunUnfinished(dormant.status)
        );
      }),
    );
    if (pendingKeys.length > 0) pi.appendEntry("subagent-notification-pending", { keys: [] });
    if (ctx.hasUI) {
      rt.views.fleet.setUICtx(ctx.ui);
      rt.views.focus.setUICtx(ctx.ui);
      rt.views.sideConversations.setUICtx(ctx.ui, ctx.mode === "tui");
    }
    rt.state.programStatus?.dispose();
    rt.state.programStatus = undefined;
    if (rt.registry.ownsManagerRegistry && ctx.mode === "tui" && ctx.hasUI) {
      const statusCtx = ctx;
      rt.state.programStatus = installProgramStatusBridge(ctx.ui, {
        isBackgroundBusy: () =>
          rt.core.manager.hasRunning() ||
          rt.notifications.notificationGate.hasPending() ||
          rt.notifications.workflowNudges.size > 0,
        isRootIdle: () => {
          try {
            return statusCtx.isIdle() && !statusCtx.hasPendingMessages();
          } catch {
            return false;
          }
        },
      });
    }
    if (rt.registry.ownsManagerRegistry && !rt.state.unregisterPreferencesProvider) {
      rt.state.unregisterPreferencesProvider = registerSubagentPreferencesProvider((providerCtx) =>
        rt.settingsMenu.createSettingsController(providerCtx),
      );
    }
    if (!rt.state.messageNotificationUnsubscribe) {
      rt.state.messageNotificationUnsubscribe = pi.events.on("subagents:message", (payload) => {
        const message = parseSubagentMessageNotification(payload);
        if (!message) return;
        const notificationCtx = rt.state.currentCtx;
        if (!notificationCtx?.hasUI) return;
        notificationCtx.ui.notify(
          renderAgentMessageNotification(message, notificationCtx.ui.theme),
          "info",
        );
      });
    }
    if (!rt.state.journalActive) {
      rt.core.manager.cancelUsageLimitWaits("Session switched; usage-limit wait cancelled.");
      rt.core.manager.clearCompleted(true);
    }
    if (!rt.state.rpcHandle) {
      rt.state.rpcHandle = registerRpcHandlers({
        events: pi.events,
        pi,
        getCtx: () => rt.state.currentCtx,
        manager: {
          spawn: rt.registry.spawnTopLevel,
          abort: (id) => {
            const record = rt.core.manager.getRecord(id);
            return !record?.parentAgentId && rt.core.manager.abort(id);
          },
        },
        refreshAgents: () => rt.reloadCustomAgents(),
      });
      pi.events.emit("subagents:ready", {});
    }
    if (rt.preferences.isSchedulingEnabled() && !rt.scheduling.scheduler.isActive())
      rt.scheduling.startScheduler(ctx);
    if (ctx.mode === "tui" && !rt.state.mentionProviderRegistered) {
      rt.state.mentionProviderRegistered = true;
      ctx.ui.addAutocompleteProvider((current) =>
        createMentionProvider(
          current,
          () =>
            mentionRoster(
              rt.core.manager,
              rt.mentions.mentionTypes(),
              (type) => getConfig(type).displayName,
            ),
          rt.preferences.isAgentMentionsEnabled,
        ),
      );
    }
    if (rt.state.journalActive) rt.revival.scheduleRevival(ctx, rootSessionId, generation);
  });
}

export function installSessionLifecycle(pi: ExtensionAPI, rt: SubagentsRuntime) {
  pi.on("session_before_switch", () => {
    rt.views.sideConversations.dismiss();
    rt.views.focus.unfocus();
    rt.scheduling.stopScheduler();
  });

  pi.on("agent_start", () => {
    rt.notifications.notificationGate.agentStart();
    rt.state.programStatus?.hold.rootRunStarted();
  });
  pi.on("agent_end", () => rt.notifications.notificationGate.agentEnd());
  pi.on("turn_end", () => rt.notifications.notificationGate.turnEnd());

  pi.on("agent_before_settle", async (_event, ctx) => {
    if (!rt.registry.ownsManagerRegistry || (ctx.mode !== "print" && ctx.mode !== "json")) return;
    const rootSessionId = rt.state.activeRootSessionId;
    if (rootSessionId === undefined) return;
    const generation = rt.state.revivalGeneration;
    const maxWaitMs = printWaitLimitMs(process.env[PRINT_WAIT_ENV]);
    const outcome = await waitForBackgroundSettle({
      isBusy: () =>
        rt.core.manager.hasRunning() ||
        rt.notifications.notificationGate.hasPending() ||
        rt.notifications.workflowNudges.size > 0,
      deliveries: () => rt.state.completionDeliveries,
      isCancelled: () =>
        generation !== rt.state.revivalGeneration ||
        rt.state.activeRootSessionId !== rootSessionId ||
        readStopState(rootSessionId).closed,
      maxWaitMs,
    });
    if (outcome === "timeout") {
      console.error(
        `[choco-pi-subagents] Background agents still running after ${maxWaitMs} ms; exiting without their completion. Set ${PRINT_WAIT_ENV} to change the limit.`,
      );
    }
  });

  const mainCompaction = createMainCompactionActivity();
  pi.on("session_before_compact", () => {
    mainCompaction.hostStarted();
  });
  pi.on("session_compact", () => mainCompaction.hostEnded());
  pi.on("session_compact_failed", () => mainCompaction.hostEnded());

  pi.on("session_shutdown", async () => {
    rt.state.activeMentionCloneGeneration = undefined;
    mainCompaction.bind(undefined);
    rt.state.programStatus?.dispose();
    rt.state.programStatus = undefined;
    rt.state.revivalGeneration++;
    rt.agentReloader.invalidate();
    if (rt.state.revivalTimer !== undefined) clearTimeout(rt.state.revivalTimer);
    rt.state.revivalTimer = undefined;
    rt.revival.revivalTrackers.clear();
    const suspend = rt.state.journalActive;
    rt.state.journalActive = false;
    const pendingKeys = rt.notifications.notificationGate.shutdown();
    if (pendingKeys.length > 0) {
      pi.appendEntry("subagent-notification-pending", { keys: pendingKeys });
    }
    rt.background.removeHookContinuationListener();
    rt.state.unregisterPreferencesProvider?.();
    rt.state.unregisterPreferencesProvider = undefined;
    rt.state.messageNotificationUnsubscribe?.();
    rt.state.messageNotificationUnsubscribe = undefined;
    rt.state.rpcHandle?.unsubSpawn();
    rt.state.rpcHandle?.unsubStop();
    rt.state.rpcHandle?.unsubPing();
    rt.state.rpcHandle = undefined;
    rt.state.currentCtx = undefined;
    rt.stopControl.unsubscribeStopControl();
    rt.state.activeRootSessionId = undefined;
    if (
      rt.registry.ownsManagerRegistry &&
      rt.registry.globalManagerRegistry[rt.registry.MANAGER_KEY] === rt.registry.registryEntry
    ) {
      delete rt.registry.globalManagerRegistry[rt.registry.MANAGER_KEY];
    }
    rt.scheduling.stopScheduler();
    rt.workflowRuntime.workflowManager.dispose();
    rt.workflowRuntime.workflowAdmissions.clear();
    if (suspend) {
      rt.core.manager.flushJournal();
      await rt.core.manager.suspendAll();
    } else {
      rt.core.manager.abortAll();
    }
    rt.notifications.groupJoin.dispose();
    for (const timer of rt.notifications.workflowNudges.values()) clearTimeout(timer);
    rt.notifications.workflowNudges.clear();
    rt.views.sideConversations.dispose();
    rt.views.focus.dispose();
    rt.views.fleet.dispose();
    rt.core.manager.dispose(suspend ? { suspend: true } : undefined);
  });

  return { mainCompaction };
}
