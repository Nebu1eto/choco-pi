/**
 * Session lifecycle hooks.
 */
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

/** Binds the activation to a root session on session_start. */
export function installSessionStart(pi: ExtensionAPI, rt: SubagentsRuntime) {
  // Capture ctx from session_start for RPC spawn handler + start the scheduler.
  // This also wires the RPC handlers and broadcasts readiness — on the first
  // bound session_start, so a filtered-out activation never advertises (#142).
  pi.on("session_start", async (event, ctx) => {
    rt.state.activeMentionCloneGeneration = ++rt.state.nextMentionCloneGeneration;
    const generation = ++rt.state.revivalGeneration;
    rt.state.currentCtx = ctx;
    // Forked or resumed root: the scratch directory follows the session id, so name the old one once.
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
    // Background preload for this session's cwd (never rejects); the spawn
    // entry points still await it before their first Model Scope check.
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
      // Dormant fallback for anything the in-memory map no longer holds.
      rt.core.manager.setJournalLookup(
        (id) => reduceJournal(sessionManager.getEntries(), rootSessionId).get(id)?.agent,
      );
      // Every journaled agent is addressable (id, @handle) right away, also
      // before the deferred revival pass; live records always take precedence.
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
        // After a restart the record is dormant; its unread result still counts.
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
            // A replaced session's context is stale; its successor owns the status.
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
    // A new/resumed/forked session never inherits a parked usage-limit wait;
    // the no-op case is the first start of this activation. A journaling
    // session keeps its records: they are suspended at shutdown and revived
    // or kept dormant from the journal instead.
    if (!rt.state.journalActive) {
      rt.core.manager.cancelUsageLimitWaits("Session switched; usage-limit wait cancelled.");
      rt.core.manager.clearCompleted(true);
    }
    // Guard mirrors the `!scheduler.isActive()` pattern below: session_start
    // fires once per activation, but a double-bind must not leak listeners.
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
      // Broadcast readiness so extensions loaded alongside us can discover us.
      // Emitting after all factories have run (rather than at factory time)
      // also avoids the race where a consumer loaded after us misses the event.
      pi.events.emit("subagents:ready", {});
    }
    if (rt.preferences.isSchedulingEnabled() && !rt.scheduling.scheduler.isActive())
      rt.scheduling.startScheduler(ctx);
    // Stack `@handle` suggestions on pi's built-in autocomplete. Registered at
    // most once per activation: pi appends wrappers to a list it never prunes,
    // so a second call would layer a duplicate provider on the first. TUI only
    // — print mode has no such method, and RPC mode's is a no-op.
    if (ctx.mode === "tui" && !rt.state.mentionProviderRegistered) {
      rt.state.mentionProviderRegistered = true;
      ctx.ui.addAutocompleteProvider((current) =>
        createMentionProvider(
          current,
          // Plain text, not renderAgentName: the same label FleetView and the
          // widget show, but the autocomplete description cannot carry ANSI.
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

/** Session switch, turn, settle, compaction, and shutdown handlers. */
export function installSessionLifecycle(pi: ExtensionAPI, rt: SubagentsRuntime) {
  pi.on("session_before_switch", () => {
    // Another extension can still cancel this switch, so nothing here may
    // suspend agents or cancel usage waits: session_shutdown (emitted for
    // new/resume/fork before the old session is disposed) suspends them, and
    // a non-journaling session aborts them there as before.
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

  // Print and JSON mode exit when the last prompt settles; hold the settle until background
  // agents and workflows deliver their completion so the announced follow-up turn can run.
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

  // Main-session compaction for the fleet view's main row and status line.
  // An earlier handler's cancel skips this one, but the failed event still ends it.
  const mainCompaction = createMainCompactionActivity();
  pi.on("session_before_compact", () => {
    mainCompaction.hostStarted();
  });
  pi.on("session_compact", () => mainCompaction.hostEnded());
  pi.on("session_compact_failed", () => mainCompaction.hostEnded());

  // On shutdown, abort all agents immediately and clean up.
  // If the session is going down, there's nothing left to consume agent results.
  pi.on("session_shutdown", async () => {
    // Invalidate detached clone continuations before clearing their captured
    // context and before any future cleanup step can introduce an await.
    rt.state.activeMentionCloneGeneration = undefined;
    mainCompaction.bind(undefined);
    // Before agents are aborted: a held `done` is written only once nothing is pending.
    rt.state.programStatus?.dispose();
    rt.state.programStatus = undefined;
    // Likewise for a revival that has not started or is still preparing.
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
    // Invalidated before any await: a stale settle must not report into a successor session.
    rt.stopControl.unsubscribeStopControl();
    rt.state.activeRootSessionId = undefined;
    // Only release the global slot if this activation claimed it — a child
    // session's shutdown must not delete the root session's registry entry.
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
      // Journal every live run as interrupted (or still waiting) before it is
      // aborted, then wait (bounded by the manager, 10 s) for the runs to
      // settle and release their session files for the next runtime.
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
