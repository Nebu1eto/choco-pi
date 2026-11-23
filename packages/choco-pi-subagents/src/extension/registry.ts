/**
 * Review admission, spawn entry points, and the cross-extension manager registry.
 */
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

/** The manager's spawn parameters; the spawn entry points forward them unchanged. */
type ManagerSpawnArgs = Parameters<AgentManager["spawn"]>;

/** Review-round admission, spawn entry points, and the process-global manager registry. */
export function installManagerRegistry(rt: SubagentsRuntime) {
  // Expose manager via Symbol.for() global registry for cross-package access.
  // Standard Node.js pattern for cross-package singletons (used by OpenTelemetry, etc.).
  //
  // Claim the slot only if it's free: subagent sessions re-activate this
  // extension in the same process (session.bindExtensions in agent-runner.ts),
  // and unconditionally overwriting would point the registry at a short-lived
  // child manager — and the child's shutdown would then delete the root
  // session's entry. The first activation (the root session) wins; child
  // activations leave it alone.
  //
  // choco-pi fork note: the registry key and every `subagents:*` event name are
  // deliberately left at their upstream spelling. They are a cross-extension
  // interface other packages resolve by literal string; renaming them with the
  // package would silently disconnect any consumer without a compile error.
  const MANAGER_KEY = Symbol.for("pi-subagents:manager");
  // Review-round ledger. Caps and the grant command live here; every review-role
  // launch the Agent/workflow tools make is admitted through it first, and the
  // manager refuses review-role launches that carry no ticket (fail closed).
  const reviewRounds = new ReviewRoundStore(defaultReviewRoundsDir());
  type ReviewAdmission =
    | { kind: "none" }
    | { kind: "admitted"; ticket: ReviewTicket; notice: string }
    | { kind: "refused"; message: string };
  /**
   * Reserve a review round for a review-role launch ("none" for other roles).
   * Snapshots the root session before the first await and rechecks it after;
   * on a mismatch the reservation is released and nothing starts.
   */
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
    // A stopped session reserves no review round: the launch would be refused anyway.
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
    // A /stop that landed while the round was being reserved gives the reservation back.
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
  // Process-external callers may supply arbitrary options. Nested ownership and
  // config-root metadata are internal capabilities issued only by scoped tools.
  /**
   * Resolve the agent type and spawn. Trusts its options — every caller must
   * either be in-process or have gone through `spawnTopLevel` first.
   */
  const spawnResolved = (
    piRef: ManagerSpawnArgs[0],
    ctxRef: ManagerSpawnArgs[1],
    type: string,
    prompt: string,
    options: ManagerSpawnArgs[4],
  ) => {
    // Cross-extension callers get the same dispatch contract as the LLM (#183).
    // The RPC layer already throws for an unresolvable model rather than falling
    // back silently; a bad agent type should not be quieter. Throws become error
    // envelopes at the RPC boundary. Resolves against the registry as last
    // loaded: callers that can await reload first (RPC, mentions), so an agent
    // file added mid session is spawnable there too, not only through the Agent tool.
    const dispatch = resolveSpawnType(type);
    if (!dispatch.ok) throw new Error(dispatch.message);
    return rt.core.manager.spawn(piRef, ctxRef, dispatch.type, prompt, options);
  };
  type SpawnArgs = Parameters<typeof spawnResolved>;

  /** Drop the internal capabilities a process-external caller must never set. */
  const callerSafeOptions = (options: Parameters<typeof spawnResolved>[4]) => {
    const safeOptions = { ...options };
    delete safeOptions.parentAgentId;
    delete safeOptions.depth;
    delete safeOptions.maxSubagentDepth;
    delete safeOptions.configCwd;
    // Also internal: it names a transcript directory, so a forged value would
    // be a path-traversal primitive.
    delete safeOptions.rootSessionId;
    // Worse than rootSessionId: this one names a file to OPEN and replay as a
    // conversation. Only the mention dispatcher may set it, and only from a
    // path this extension itself recorded — never from anything a caller sent.
    delete safeOptions.resumeSessionFile;
    // Bypasses handle allocation, so a forged value would duplicate a live
    // agent's name and make `@handle` ambiguous. Same rule: dispatcher only.
    delete safeOptions.reclaim;
    // Side-conversation identity and its notification/read-only behavior are an
    // internal capability issued only by the /btw controller. RPC and registry
    // callers cannot forge it to suppress ordinary result delivery.
    delete safeOptions.sideConversation;
    delete safeOptions.readOnly;
    delete safeOptions.mainSessionFork;
    delete safeOptions.workflowId;
    delete safeOptions.workflowStepId;
    return safeOptions;
  };

  const spawnTopLevel = (...[piRef, ctxRef, type, prompt, options]: SpawnArgs) =>
    spawnResolved(piRef, ctxRef, type, prompt, callerSafeOptions(options));

  /**
   * First-party spawn of an `internal` agent by its exact registry name (the
   * advisor tool). Same option stripping as `spawnTopLevel`, but the type must
   * name an enabled internal agent exactly: no case folding and no
   * `fallbackSubagent`, so a typo errors instead of running another agent.
   * Exposed only on the in-process registry entry, never through RPC.
   */
  const spawnInternalTopLevel = (...[piRef, ctxRef, type, prompt, options]: SpawnArgs) => {
    const dispatch = resolveInternalSpawnType(type);
    if (!dispatch.ok) throw new Error(dispatch.message);
    return rt.core.manager.spawn(piRef, ctxRef, dispatch.type, prompt, callerSafeOptions(options));
  };

  /**
   * Resolve a tool's `agent_id` as an id OR a handle, so the model addresses
   * agents by the same names the user types. Ids are tried first, keeping the
   * existing behaviour exact — a handle is only consulted when the string is
   * not an id at all. Only live records: a tombstone has nothing to steer and
   * no result to read. Callers still enforce the nested-ownership rejection.
   */
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
    // Synchronous cross-extension contract (returns the id), so it cannot await
    // a reload: it resolves against the last-loaded registry and refreshes it
    // in the background for the next call.
    spawn: (...args: Parameters<typeof spawnTopLevel>) => {
      rt.refreshAgentsInBackground();
      return spawnTopLevel(...args);
    },
    // In-process first-party callers only (the advisor tool): spawns an
    // `internal` agent by exact name. `spawn` above keeps rejecting internal
    // types like every other caller-supplied path.
    spawnInternal: (...args: Parameters<typeof spawnInternalTopLevel>) => {
      rt.refreshAgentsInBackground();
      return spawnInternalTopLevel(...args);
    },
    getRecord: (id: string) => {
      const record = rt.core.manager.getRecord(id);
      return record?.parentAgentId ? undefined : record;
    },
    disposeSettledRecord: (id: string) => rt.core.manager.disposeSettledRecord(id),
    // Child-session probes for root extensions (usage-limit policy): a child is
    // registered by id before its extensions bind, and the async context covers
    // session construction and resource loading.
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
