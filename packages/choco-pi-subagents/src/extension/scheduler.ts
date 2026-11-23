import { SubagentScheduler } from "../schedule.ts";
import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveStorePath, ScheduleStore } from "../schedule-store.ts";
import type { SubagentsRuntime } from "./runtime.ts";

export function installScheduler(pi: ExtensionAPI, rt: SubagentsRuntime) {
  const scheduler = new SubagentScheduler();

  function stopScheduler(): void {
    rt.state.schedulerGeneration++;
    rt.state.schedulerStarting = undefined;
    scheduler.stop();
  }

  function startScheduler(ctx: ExtensionContext): void {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (!sessionId) return;
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
        console.warn("[choco-pi-subagents] Failed to start scheduler:", err);
      } finally {
        if (owner === rt.state.schedulerGeneration) rt.state.schedulerStarting = undefined;
      }
    })();
  }

  return { scheduler, startScheduler, stopScheduler };
}
