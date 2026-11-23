/**
 * Subagent scheduler lifecycle.
 */
import { SubagentScheduler } from "../schedule.ts";
import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveStorePath, ScheduleStore } from "../schedule-store.ts";
import type { SubagentsRuntime } from "./runtime.ts";

/** Session-scoped subagent scheduler start and stop. */
export function installScheduler(pi: ExtensionAPI, rt: SubagentsRuntime) {
  // ---- Subagent scheduler ----
  // Session-scoped: store is constructed inside session_start once sessionId
  // is available. Mirrors pi-chonky-tasks's session-scoped task store —
  // schedules reset on /new, restore on /resume.
  const scheduler = new SubagentScheduler();

  function stopScheduler(): void {
    rt.state.schedulerGeneration++;
    rt.state.schedulerStarting = undefined;
    scheduler.stop();
  }

  /**
   * Load the session's store asynchronously, then bind the scheduler — only
   * if no stop/restart happened meanwhile and nothing else bound it. The
   * load is not awaited by session_start; `schedulerStarting` exposes it.
   */
  function startScheduler(ctx: ExtensionContext): void {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (!sessionId) return; // sessionId not yet available — try again on next event
    const path = resolveStorePath(ctx.cwd, sessionId);
    const owner = ++rt.state.schedulerGeneration;
    rt.state.schedulerStarting = (async () => {
      try {
        const store = await ScheduleStore.open(path);
        if (
          owner !== rt.state.schedulerGeneration ||
          scheduler.isActive() ||
          !rt.preferences.isSchedulingEnabled()
        ) {
          return;
        }
        scheduler.start(pi, ctx, rt.core.manager, store);
        pi.events.emit("subagents:scheduler_ready", { sessionId, jobCount: store.list().length });
      } catch (err) {
        // Scheduling is non-essential — log and move on so the rest of the
        // extension keeps working if e.g. .pi/ is unwritable.
        console.warn("[choco-pi-subagents] Failed to start scheduler:", err);
      } finally {
        if (owner === rt.state.schedulerGeneration) rt.state.schedulerStarting = undefined;
      }
    })();
  }

  return { scheduler, startScheduler, stopScheduler };
}
