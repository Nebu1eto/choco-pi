/**
 * Stop-control integration.
 */
import type { StopWorkflowPort, UserStopResult } from "../types.ts";
import {
  type StopReport,
  STOP_CONTROL_REPORT_CHANNEL,
  STOP_CONTROL_REVOKE_CHANNEL,
  isRevokeRequest,
} from "@choco-pi/shared/stop-control";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentsRuntime } from "./runtime.ts";

/** Shared stop-control integration: user stops, revocation, and stop reports. */
export function installStopIntegration(pi: ExtensionAPI, rt: SubagentsRuntime) {
  // ---- /stop participant (choco-pi:stop-control/v1) ----
  const stopWorkflowPort: StopWorkflowPort = {
    runningFor: (rootSessionId) =>
      [...rt.workflowRuntime.workflowAdmissions]
        .filter(([id, admission]) => {
          const status = rt.workflowRuntime.workflowManager.get(id)?.status;
          return admission.root === rootSessionId && (status === "running" || status === "waiting");
        })
        .map(([id]) => id),
    cancel: (workflowId) => {
      const status = rt.workflowRuntime.workflowManager.get(workflowId)?.status;
      if (status !== "running" && status !== "waiting") return false;
      rt.workflowRuntime.workflowManager.cancel(workflowId);
      return true;
    },
  };

  function emitStopReport(report: StopReport): void {
    pi.events.emit(STOP_CONTROL_REPORT_CHANNEL, report);
  }

  /**
   * Stop everything a user `/stop` targets. All revocation and the `acknowledged` report happen
   * synchronously inside the handler; exactly one `settled` or `failed` report follows later,
   * and only while the session that received the request is still the active one.
   */
  function applyStop(requestId: string, rootSessionId: string, stop: UserStopResult): void {
    const generation = rt.state.revivalGeneration;
    for (const record of stop.records)
      rt.notifications.emitLifecycle("subagents:stopped", rt.notifications.buildEventData(record));
    rt.views.fleet.update();
    emitStopReport({
      requestId,
      participant: "subagents",
      phase: "acknowledged",
      counts: { agents: stop.agents, workflows: stop.workflows },
      ownerSessionIds: stop.ownerSessionIds,
    });
    const report = (partial: Pick<StopReport, "phase"> & Partial<StopReport>): void => {
      // A shut-down or replaced session has no coordinator left to hear this.
      if (
        generation !== rt.state.revivalGeneration ||
        rt.state.activeRootSessionId !== rootSessionId
      )
        return;
      emitStopReport({ requestId, participant: "subagents", ...partial });
    };
    void stop.settled.then(
      (retainedWorktrees) => {
        const settled: Pick<StopReport, "phase"> & Partial<StopReport> = {
          phase: "settled",
          counts: { agents: stop.agents, workflows: stop.workflows },
        };
        if (retainedWorktrees.length > 0) settled.retainedWorktrees = retainedWorktrees;
        report(settled);
      },
      (error) =>
        report({ phase: "failed", detail: error instanceof Error ? error.message : String(error) }),
    );
  }

  function subscribeStopControl(): void {
    if (rt.state.unsubscribeRevoke !== undefined) return;
    rt.state.unsubscribeRevoke = pi.events.on(STOP_CONTROL_REVOKE_CHANNEL, (payload) => {
      if (!isRevokeRequest(payload)) return;
      const rootSessionId = rt.state.activeRootSessionId;
      if (rootSessionId === undefined || payload.rootSessionId !== rootSessionId) return;
      if (payload.scope === "all") {
        applyStop(
          payload.requestId,
          rootSessionId,
          rt.core.manager.stopAllForRoot(rootSessionId, stopWorkflowPort),
        );
        return;
      }
      const ref = payload.agentRef ?? "";
      const record = ref === "" ? undefined : rt.core.manager.findRecordForStop(ref);
      const owned =
        record !== undefined &&
        (record.admissionRoot === undefined || record.admissionRoot === rootSessionId);
      if (owned) {
        applyStop(
          payload.requestId,
          rootSessionId,
          rt.core.manager.stopTreeForUser(record, stopWorkflowPort),
        );
        return;
      }
      // A dormant or evicted agent is known but has nothing running: acknowledge and settle.
      const known =
        ref !== "" &&
        (rt.core.manager.getDormant(ref) !== undefined ||
          rt.core.manager.resolveMention(ref) !== undefined);
      if (known) {
        applyStop(payload.requestId, rootSessionId, {
          agents: 0,
          workflows: 0,
          ownerSessionIds: [],
          records: [],
          settled: Promise.resolve([]),
        });
        return;
      }
      emitStopReport({
        requestId: payload.requestId,
        participant: "subagents",
        phase: "failed",
        detail: `No agent matches "${ref}" in this session; nothing was stopped.`,
      });
    });
  }

  function unsubscribeStopControl(): void {
    rt.state.unsubscribeRevoke?.();
    rt.state.unsubscribeRevoke = undefined;
  }

  return { subscribeStopControl, unsubscribeStopControl };
}
