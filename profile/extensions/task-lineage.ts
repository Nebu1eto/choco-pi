import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  InputEvent,
  MessageStartEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { isStaleContextError } from "./lib/lifecycle.ts";
import { isString } from "./lib/runtime-values.ts";
import {
  addFindingMarkers,
  appendSpawn,
  childClassification,
  currentActiveFromBranch,
  INDEX_DIRECTORY,
  indexFailureReason,
  readParentState,
  resourceClassification,
  resultSessionId,
  safeId,
  selectedInput,
  sessionNameAgentId,
  stopOutcome,
  TASK_INDEX_STATUS_CUSTOM_TYPE,
  TASK_RESOURCE_CUSTOM_TYPE,
  TASK_WORKFLOW_CUSTOM_TYPE,
  WORKFLOW_SKILL_COMMAND,
  WORKFLOW_SKILL_PATH,
  workflowMatch,
  type ActiveTask,
  type HostState,
  type IndexFailureReason,
  type ParentState,
  type StructuralObject,
} from "./task-lineage/branch-state.ts";
import {
  TASK_BOUNDARY_CUSTOM_TYPE,
  TASK_OUTCOME_CUSTOM_TYPE,
  TASK_PARTICIPANT_CUSTOM_TYPE,
  auditTaskLineage,
  createParticipantRetryRecord,
  createParticipantStartRecord,
  createTaskArchiveRecord,
  createTaskOutcomeRecord,
  createTaskStartRecord,
  snapshotProjectSessions,
  writeTaskSummary,
  type FindingCounts,
  type TaskLineageSummary,
  type TaskSessionSnapshot,
  type TerminalOutcome,
  type WorkflowKind,
} from "./task-lineage/store.ts";

export type { ParentState } from "./task-lineage/branch-state.ts";

export type TaskLineageDependencies = {
  now(): string;
  createTaskId(): string;
  snapshotProjectSessions(directory: string, capturedAt: string): Promise<TaskSessionSnapshot>;
  auditTaskLineage(options: {
    projectSessionDirectory: string;
    taskId: string;
    rootSessionId: string;
    updatedAt?: string;
  }): Promise<TaskLineageSummary>;
  writeTaskSummary(indexDirectory: string, summary: TaskLineageSummary): Promise<string>;
  readParentState(parentSessionFile: string): Promise<ParentState | undefined>;
};

const defaults: TaskLineageDependencies = {
  now: () => new Date().toISOString(),
  createTaskId: () => `task-${randomUUID()}`,
  snapshotProjectSessions,
  auditTaskLineage,
  writeTaskSummary,
  readParentState,
};

export function createTaskLineageExtension(
  overrides: Partial<TaskLineageDependencies> = {},
): ExtensionFactory {
  const dependencies = { ...defaults, ...overrides };
  return (pi: ExtensionAPI): void => {
    let generation = 0;
    let host: HostState | undefined;

    const isOwner = (candidate: HostState): boolean =>
      host === candidate && generation === candidate.generation;

    const recordWorkflowKind = (active: ActiveTask, kind: WorkflowKind): void => {
      if (active.workflowKind === undefined) {
        active.workflowKind = kind;
      } else if (active.workflowKind !== kind) {
        active.workflowKindChanges = (active.workflowKindChanges ?? 0) + 1;
      } else {
        return;
      }
      pi.appendEntry(TASK_WORKFLOW_CUSTOM_TYPE, {
        schemaVersion: 1,
        taskId: active.taskId,
        workflowKind: active.workflowKind,
        workflowKindChanges: active.workflowKindChanges ?? 0,
      });
    };

    const terminalize = (
      state: HostState,
      outcome: TerminalOutcome,
      findings: FindingCounts,
    ):
      | { taskId: string; rootSessionId: string; directory: string; updatedAt: string }
      | undefined => {
      const active = state.active;
      if (!active || active.terminalized) return undefined;
      active.terminalized = true;
      const finishedAt = dependencies.now();
      const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(active.startedAt));
      pi.appendEntry(
        TASK_OUTCOME_CUSTOM_TYPE,
        createTaskOutcomeRecord({
          taskId: active.taskId,
          participantKey: active.participantKey,
          outcome,
          finishedAt,
          durationMs: Number.isFinite(durationMs) ? durationMs : 0,
          retryCount: active.retryCount,
          findings,
        }),
      );
      if (!active.root) return undefined;
      pi.appendEntry(
        TASK_BOUNDARY_CUSTOM_TYPE,
        createTaskArchiveRecord(active.taskId, finishedAt, outcome, {
          workflowKind: active.workflowKind ?? "none",
          workflowKindChanges: active.workflowKindChanges,
        }),
      );
      return {
        taskId: active.taskId,
        rootSessionId: active.rootSessionId,
        directory: state.projectSessionDirectory,
        updatedAt: finishedAt,
      };
    };

    const auditAndWrite = async (
      request: {
        taskId: string;
        rootSessionId: string;
        directory: string;
        updatedAt: string;
      },
      owner?: HostState,
    ): Promise<void> => {
      const appendIndexState = (
        status: "available" | "stale" | "unavailable",
        reason?: IndexFailureReason,
      ): void => {
        if (!owner || !isOwner(owner)) return;
        const data = {
          schemaVersion: 1,
          taskId: request.taskId,
          resource: "summary-index",
          status,
          updatedAt: request.updatedAt,
        } satisfies StructuralObject;
        pi.appendEntry(
          TASK_INDEX_STATUS_CUSTOM_TYPE,
          reason === undefined ? data : { ...data, reason },
        );
      };
      let summary: TaskLineageSummary;
      try {
        summary = await dependencies.auditTaskLineage({
          projectSessionDirectory: request.directory,
          taskId: request.taskId,
          rootSessionId: request.rootSessionId,
          updatedAt: request.updatedAt,
        });
      } catch (error) {
        if (isStaleContextError(error)) return;
        const reason = indexFailureReason(error);
        if (!reason) throw error;
        appendIndexState("unavailable", reason);
        return;
      }
      try {
        await dependencies.writeTaskSummary(path.join(request.directory, INDEX_DIRECTORY), summary);
      } catch (error) {
        if (isStaleContextError(error)) return;
        const reason = indexFailureReason(error);
        if (!reason) throw error;
        appendIndexState(reason === "summary-lock-timeout" ? "stale" : "unavailable", reason);
        return;
      }
      appendIndexState("available");
    };

    pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
      generation += 1;
      const sessionId = safeId(ctx.sessionManager.getSessionId());
      const sessionFile = ctx.sessionManager.getSessionFile();
      const projectSessionDirectory = ctx.sessionManager.getSessionDir();
      const header = ctx.sessionManager.getHeader();
      const entries = ctx.sessionManager.getBranch();
      const sessionName = ctx.sessionManager.getSessionName();
      if (!sessionId || !sessionFile) {
        host = undefined;
        return;
      }
      const state: HostState = {
        generation,
        sessionId,
        projectSessionDirectory: path.resolve(projectSessionDirectory),
        sessionFile: path.resolve(sessionFile),
        parentSessionId: null,
        root: true,
        startupFallback: event.reason === "startup",
        pendingSessionCreates: new Map(),
        retryCount: 0,
      };
      const reconstructed = currentActiveFromBranch(entries, sessionId);
      if (reconstructed) {
        state.active = reconstructed;
        state.root = reconstructed.root;
        state.retryCount = reconstructed.retryCount;
      }
      host = state;
      if (state.active || !header?.parentSession) return;
      const owner = state;
      const parentPath = path.resolve(header.parentSession);
      const parent = await dependencies.readParentState(parentPath);
      if (!isOwner(owner)) return;
      if (!parent) return;
      owner.parentSessionId = parent.parentSessionId;
      const inherited = parent.activeTask;
      if (!inherited) {
        owner.root = true;
        return;
      }
      const agentId = sessionNameAgentId(sessionName);
      const linkedParticipant = parent.participants?.find(
        (participant) =>
          participant.linkedSessionId === sessionId || participant.linkedSessionId === agentId,
      );
      const classification = linkedParticipant ?? childClassification(sessionName);
      const active: ActiveTask = {
        ...inherited,
        toolCallId: linkedParticipant?.toolCallId ?? sessionId,
        role: classification.role,
        purpose: classification.purpose,
        auditWorker: linkedParticipant?.auditWorker ?? false,
        participantKey: sessionId,
        retryCount: 0,
        outcome: "partial",
        terminalized: false,
        root: false,
      };
      const participant = {
        taskId: inherited.taskId,
        toolCallId: linkedParticipant?.toolCallId ?? sessionId,
        role: classification.role,
        purpose: classification.purpose,
        auditWorker: linkedParticipant?.auditWorker ?? false,
      };
      const reviewRevision = linkedParticipant?.reviewRevision;
      const participantRecord = reviewRevision ? { ...participant, reviewRevision } : participant;
      pi.appendEntry(TASK_PARTICIPANT_CUSTOM_TYPE, createParticipantStartRecord(participantRecord));
      if (!isOwner(owner)) return;
      owner.active = active;
      owner.root = false;
    });

    pi.on("input", (event: InputEvent) => {
      if (!host) return;
      host.inputSource = event.source;
      host.inputWorkflowKind = workflowMatch(event.text, WORKFLOW_SKILL_COMMAND);
      if (event.source === "extension") host.startupFallback = false;
    });

    pi.on("message_start", async (event: MessageStartEvent, _ctx: ExtensionContext) => {
      const message = event.message;
      if (message.role !== "user") return;
      const state = host;
      if (!state || !state.root || state.active) {
        if (state) state.inputSource = undefined;
        return;
      }
      const permitted =
        state.inputSource === "interactive" ||
        state.inputSource === "rpc" ||
        (state.inputSource === undefined && state.startupFallback);
      state.inputSource = undefined;
      const inputKind = state.inputWorkflowKind;
      state.inputWorkflowKind = undefined;
      state.startupFallback = false;
      if (!permitted) return;
      const sessionId = state.sessionId;
      const projectSessionDirectory = state.projectSessionDirectory;
      const parentSessionId = state.parentSessionId;
      const taskId = safeId(dependencies.createTaskId());
      const startedAt = dependencies.now();
      const owner = state;
      if (!taskId) throw new TypeError("task ID generator returned an unsafe identifier");
      const snapshot = await dependencies.snapshotProjectSessions(
        projectSessionDirectory,
        startedAt,
      );
      if (!isOwner(owner)) return;
      pi.appendEntry(
        TASK_BOUNDARY_CUSTOM_TYPE,
        createTaskStartRecord({
          taskId,
          rootSessionId: sessionId,
          parentSessionId,
          role: "root",
          purpose: "coordination",
          workflowKind: inputKind,
          startedAt,
          snapshot,
        }),
      );
      if (!isOwner(owner)) return;
      owner.retryCount = 0;
      owner.active = {
        taskId,
        rootSessionId: sessionId,
        toolCallId: sessionId,
        participantKey: sessionId,
        role: "root",
        purpose: "coordination",
        auditWorker: false,
        startedAt,
        retryCount: 0,
        outcome: "partial",
        terminalized: false,
        root: true,
        workflowKind: inputKind,
      };
    });

    pi.on("tool_call", (event: ToolCallEvent) => {
      const state = host;
      const active = state?.active;
      if (!state || !active || active.terminalized) return;
      if (active.root && event.toolName.toLowerCase() === "read") {
        const skillPath = selectedInput(event, "path");
        const kind = workflowMatch(
          isString(skillPath) ? skillPath : undefined,
          WORKFLOW_SKILL_PATH,
        );
        if (kind) {
          recordWorkflowKind(active, kind);
          return;
        }
      }
      const resume = selectedInput(event, "resume");
      if (event.toolName === "Agent" && safeId(resume)) {
        state.retryCount += 1;
        active.retryCount = state.retryCount;
        pi.appendEntry(
          TASK_PARTICIPANT_CUSTOM_TYPE,
          createParticipantRetryRecord({
            taskId: active.taskId,
            toolCallId: active.participantKey,
            retryCount: state.retryCount,
          }),
        );
        return;
      }
      if (event.toolName === "TaskCreate" || event.toolName === "TaskUpdate") {
        const toolCallId = safeId(event.toolCallId);
        if (!toolCallId) return;
        pi.appendEntry(TASK_RESOURCE_CUSTOM_TYPE, {
          schemaVersion: 1,
          taskId: active.taskId,
          toolCallId,
          kind: event.toolName === "TaskCreate" ? "create" : "update",
        });
        return;
      }
      if (
        event.toolName !== "Agent" &&
        event.toolName !== "session_create" &&
        event.toolName !== "session_send"
      )
        return;
      const resource = resourceClassification(event);
      if (!resource) return;
      if (event.toolName === "Agent" || event.toolName === "session_create") {
        state.pendingSessionCreates.set(event.toolCallId, resource);
        return;
      }
      const linkedValue = selectedInput(event, "session_id") ?? selectedInput(event, "sessionId");
      const linked = event.toolName === "session_send" ? safeId(linkedValue) : undefined;
      appendSpawn(pi.appendEntry, active, resource, linked);
    });

    pi.on("tool_result", (event: ToolResultEvent) => {
      const state = host;
      const active = state?.active;
      if (
        !state ||
        !active ||
        active.terminalized ||
        (event.toolName !== "Agent" && event.toolName !== "session_create")
      )
        return;
      const pending = state.pendingSessionCreates.get(event.toolCallId);
      if (!pending) return;
      state.pendingSessionCreates.delete(event.toolCallId);
      appendSpawn(
        pi.appendEntry,
        active,
        pending,
        event.isError ? undefined : resultSessionId(event),
      );
    });

    pi.on("agent_end", (event: AgentEndEvent) => {
      if (host?.active && !host.active.terminalized) host.active.outcome = stopOutcome(event);
    });

    pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
      const state = host;
      if (!state || !state.active || state.active.terminalized) return;
      const findings = addFindingMarkers(ctx.sessionManager.getBranch(), state.active);
      const request = terminalize(state, state.active.outcome, findings);
      state.active = undefined;
      state.pendingSessionCreates.clear();
      if (!request) return;
      const owner = state;
      await auditAndWrite(request, owner);
      if (!isOwner(owner)) return;
    });

    pi.on("session_shutdown", async (event: SessionShutdownEvent, ctx: ExtensionContext) => {
      const state = host;
      let request: ReturnType<typeof terminalize>;
      if (state && event.reason !== "reload" && state.active && !state.active.terminalized) {
        const findings = addFindingMarkers(ctx.sessionManager.getBranch(), state.active);
        request = terminalize(state, "partial", findings);
      }
      generation += 1;
      host = undefined;
      state?.pendingSessionCreates.clear();
      if (request) await auditAndWrite(request);
    });
  };
}

export default createTaskLineageExtension();
