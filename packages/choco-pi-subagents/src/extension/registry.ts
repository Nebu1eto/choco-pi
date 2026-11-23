import {
  ReviewRoundStore,
  defaultReviewRoundsDir,
  type ReviewTicket,
  type ReviewEntry,
  roundClassOf,
  stateUnavailableMessage,
} from "../review-rounds.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isAdmissionOpen, ADMISSION_CLOSED_MESSAGE } from "@choco-pi/shared/stop-control";
import { resolveSpawnType, resolveInternalSpawnType } from "../agent-types.ts";
import type { AgentRecord } from "../types.ts";
import type {
  ShellSectionProvider,
  ShellSectionRegistration,
} from "../ui/shell-section-contract.ts";
import { inChildSessionContext, isChildSessionId } from "../child-context.ts";
import type { AgentManager } from "../agent-manager.ts";
import type { SubagentsRuntime } from "./runtime.ts";

type ManagerSpawnArgs = Parameters<AgentManager["spawn"]>;

export function installManagerRegistry(rt: SubagentsRuntime) {
  const MANAGER_KEY = Symbol.for("pi-subagents:manager");
  const reviewRounds = new ReviewRoundStore(defaultReviewRoundsDir());
  type ReviewAdmission =
    | { kind: "none" }
    | { kind: "admitted"; ticket: ReviewTicket; notice: string }
    | { kind: "refused"; message: string };
  const admitReviewRound = async (
    ctxRef: ExtensionContext,
    type: string,
    workTask: string | undefined,
    entry: ReviewEntry,
    expectedRoot?: string,
  ): Promise<ReviewAdmission> => {
    const roundClass = roundClassOf(type);
    if (roundClass === undefined) return { kind: "none" };
    let rootSessionId: string;
    try {
      rootSessionId = ctxRef.sessionManager.getSessionId();
    } catch {
      return {
        kind: "refused",
        message: stateUnavailableMessage("session unavailable", roundClass),
      };
    }
    const stale = "Session changed while the review round was being admitted; nothing was started.";
    if (expectedRoot !== undefined && expectedRoot !== rootSessionId) {
      return { kind: "refused", message: stale };
    }
    if (!isAdmissionOpen(rootSessionId))
      return { kind: "refused", message: ADMISSION_CLOSED_MESSAGE };
    const result = await reviewRounds.admit({
      rootSessionId,
      workTask: workTask ?? "",
      agentType: type,
      entry,
    });
    if (!result.ok) return { kind: "refused", message: result.message };
    let unchanged = false;
    try {
      unchanged = ctxRef.sessionManager.getSessionId() === rootSessionId;
    } catch {
      unchanged = false;
    }
    if (!unchanged) {
      await reviewRounds.release(result.ticket);
      return { kind: "refused", message: stale };
    }
    if (!isAdmissionOpen(rootSessionId)) {
      await reviewRounds.release(result.ticket);
      return { kind: "refused", message: ADMISSION_CLOSED_MESSAGE };
    }
    return { kind: "admitted", ticket: result.ticket, notice: `${result.notice}\n` };
  };
  const ticketOf = (admission: ReviewAdmission): ReviewTicket | undefined =>
    admission.kind === "admitted" ? admission.ticket : undefined;
  const noticeOf = (admission: ReviewAdmission): string =>
    admission.kind === "admitted" ? admission.notice : "";
  const spawnResolved = (
    piRef: ManagerSpawnArgs[0],
    ctxRef: ManagerSpawnArgs[1],
    type: string,
    prompt: string,
    options: ManagerSpawnArgs[4],
  ) => {
    const dispatch = resolveSpawnType(type);
    if (!dispatch.ok) throw new Error(dispatch.message);
    return rt.core.manager.spawn(piRef, ctxRef, dispatch.type, prompt, options);
  };
  type SpawnArgs = Parameters<typeof spawnResolved>;

  const callerSafeOptions = (options: Parameters<typeof spawnResolved>[4]) => {
    const safeOptions = { ...options };
    delete safeOptions.parentAgentId;
    delete safeOptions.depth;
    delete safeOptions.maxSubagentDepth;
    delete safeOptions.configCwd;
    delete safeOptions.rootSessionId;
    delete safeOptions.resumeSessionFile;
    delete safeOptions.reclaim;
    delete safeOptions.sideConversation;
    delete safeOptions.readOnly;
    delete safeOptions.mainSessionFork;
    delete safeOptions.workflowId;
    delete safeOptions.workflowStepId;
    return safeOptions;
  };

  const spawnTopLevel = (...[piRef, ctxRef, type, prompt, options]: SpawnArgs) =>
    spawnResolved(piRef, ctxRef, type, prompt, callerSafeOptions(options));

  const spawnInternalTopLevel = (...[piRef, ctxRef, type, prompt, options]: SpawnArgs) => {
    const dispatch = resolveInternalSpawnType(type);
    if (!dispatch.ok) throw new Error(dispatch.message);
    return rt.core.manager.spawn(piRef, ctxRef, dispatch.type, prompt, callerSafeOptions(options));
  };

  const resolveAgentRef = (ref: string): AgentRecord | undefined => {
    const byId = rt.core.manager.getRecord(ref);
    if (byId) return byId;
    const resolved = rt.core.manager.resolveMention(ref);
    return resolved?.kind === "live" ? resolved.record : undefined;
  };

  const registryEntry = {
    waitForAll: () => rt.core.manager.waitForAll(),
    hasRunning: () => rt.core.manager.hasRunning(),
    getAllRecords: () => rt.core.manager.listAgents(),
    stop: (id: string) => {
      const record = rt.core.manager.getRecord(id);
      if (!record || !rt.core.manager.abort(id)) return false;
      rt.notifications.emitLifecycle("subagents:stopped", rt.notifications.buildEventData(record));
      return true;
    },
    registerShellSection: (provider: ShellSectionProvider): ShellSectionRegistration => {
      rt.state.shellSectionProvider = provider;
      rt.state.fleetSource?.setShellSection(provider);
      let registered = true;
      return {
        unregister: () => {
          if (!registered) return;
          registered = false;
          if (rt.state.shellSectionProvider !== provider) return;
          rt.state.shellSectionProvider = undefined;
          rt.state.fleetSource?.setShellSection(undefined);
        },
      };
    },
    spawn: (...args: Parameters<typeof spawnTopLevel>) => {
      rt.refreshAgentsInBackground();
      return spawnTopLevel(...args);
    },
    spawnInternal: (...args: Parameters<typeof spawnInternalTopLevel>) => {
      rt.refreshAgentsInBackground();
      return spawnInternalTopLevel(...args);
    },
    getRecord: (id: string) => {
      const record = rt.core.manager.getRecord(id);
      return record?.parentAgentId ? undefined : record;
    },
    disposeSettledRecord: (id: string) => rt.core.manager.disposeSettledRecord(id),
    isChildSessionContext: () => inChildSessionContext(),
    isChildSessionId: (id: string) => isChildSessionId(id),
  };
  interface GlobalManagerRegistry {
    [key: symbol]: typeof registryEntry | undefined;
  }
  // SAFETY: This process-global symbol slot is owned by the registry protocol documented above.
  const globalManagerRegistry = globalThis as typeof globalThis & GlobalManagerRegistry;
  const ownsManagerRegistry = globalManagerRegistry[MANAGER_KEY] === undefined;
  if (ownsManagerRegistry) {
    globalManagerRegistry[MANAGER_KEY] = registryEntry;
  }

  return {
    ownsManagerRegistry,
    admitReviewRound,
    ticketOf,
    reviewRounds,
    noticeOf,
    spawnTopLevel,
    spawnResolved,
    globalManagerRegistry,
    MANAGER_KEY,
    registryEntry,
    resolveAgentRef,
  };
}
