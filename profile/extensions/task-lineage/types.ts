export const TASK_LINEAGE_SCHEMA_VERSION = 1;
export const TASK_BOUNDARY_CUSTOM_TYPE = "choco-pi:task-lineage:boundary";
export const TASK_PARTICIPANT_CUSTOM_TYPE = "choco-pi:task-lineage:participant";
export const TASK_OUTCOME_CUSTOM_TYPE = "choco-pi:task-lineage:outcome";

export const MAX_JSONL_LINE_BYTES = 1024 * 1024;
export const MAX_HEADER_BYTES = 64 * 1024;
export const MAX_SESSIONS = 20_000;
export const MAX_TEXT_LENGTH = 240;
export const MAX_PAGE_SIZE = 100;
export const SUMMARY_SUFFIX = ".summary.json";
export const LOCK_STALE_MS = 30_000;
export const LOCK_RETRY_MS = 10;
export const LOCK_ATTEMPTS = 500;

export type TaskLineageOperationalErrorCode =
  | "audit-listing-truncated"
  | "root-session-unavailable"
  | "task-start-unavailable"
  | "summary-lock-timeout";

export const TaskLineageOperationalError = class TaskLineageOperationalError extends Error {
  readonly code: TaskLineageOperationalErrorCode;

  constructor(code: TaskLineageOperationalErrorCode, message: string) {
    super(message);
    this.name = "TaskLineageOperationalError";
    this.code = code;
  }
};

export type LineageRole = "root" | "implementation" | "review" | "e2e" | "independent";
export type LineagePurpose = "implementation" | "review" | "e2e" | "audit" | "coordination";

export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = boolean | number | string | null | JsonObject | JsonValue[];

export type SessionCursor = {
  sessionId: string;
  cursor: number;
};

export type TaskSessionSnapshot = {
  capturedAt: string;
  sessions: SessionCursor[];
  truncated: boolean;
};

export type SessionJsonlHeader = {
  sessionId: string;
  timestamp: string;
  parentSession?: string;
  filePath: string;
  cursor: number;
};

export const WORKFLOW_KINDS = ["task", "task-inline", "task-hotfix", "task-dynamic"] as const;
export type WorkflowKind = (typeof WORKFLOW_KINDS)[number] | "none";

export type FindingCounts = {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
};

export type TerminalOutcome = "completed" | "failed" | "cancelled" | "partial" | "archived";

export type TaskBoundaryRecord =
  | {
      schemaVersion: 1;
      event: "start";
      taskId: string;
      rootSessionId: string;
      parentSessionId: string | null;
      role: LineageRole;
      purpose: LineagePurpose;
      reviewRevision?: string;
      workflowKind?: WorkflowKind;
      startedAt: string;
      snapshot: TaskSessionSnapshot;
    }
  | {
      schemaVersion: 1;
      event: "archive";
      taskId: string;
      archivedAt: string;
      outcome: TerminalOutcome;
      workflowKind?: WorkflowKind;
      workflowKindChanges?: number;
    };

export type ParticipantSpawnRecord = {
  schemaVersion: 1;
  event: "spawn";
  taskId: string;
  toolCallId: string;
  role: LineageRole;
  purpose: LineagePurpose;
  reviewRevision?: string;
  linkedSessionId?: string;
  auditWorker: boolean;
};

export type ParticipantStartRecord = {
  schemaVersion: 1;
  event: "start";
  taskId: string;
  toolCallId: string;
  role: LineageRole;
  purpose: LineagePurpose;
  reviewRevision?: string;
  auditWorker: boolean;
};

export type ParticipantRetryRecord = {
  schemaVersion: 1;
  event: "retry";
  taskId: string;
  toolCallId: string;
  retryCount?: number;
};

export type TaskParticipantRecord =
  | ParticipantSpawnRecord
  | ParticipantStartRecord
  | ParticipantRetryRecord;

export type TaskOutcomeRecord = {
  schemaVersion: 1;
  event: "terminal";
  taskId: string;
  participantKey: string;
  outcome: TerminalOutcome;
  finishedAt: string;
  durationMs: number;
  retryCount: number;
  findings: FindingCounts;
};

export type LineageCustomRecord = {
  type: "custom";
  customType:
    | typeof TASK_BOUNDARY_CUSTOM_TYPE
    | typeof TASK_PARTICIPANT_CUSTOM_TYPE
    | typeof TASK_OUTCOME_CUSTOM_TYPE;
  data: TaskBoundaryRecord | TaskParticipantRecord | TaskOutcomeRecord;
  id?: string;
  timestamp?: string;
};

export type ParticipantSummary = {
  sessionId: string;
  role: LineageRole;
  purpose: LineagePurpose;
  toolCallId?: string;
  reviewRevision?: string;
  outcome?: TerminalOutcome;
};

export type CoverageEntry = {
  toolCallId: string;
  role: LineageRole;
  status: "available" | "unavailable";
  sessionId?: string;
  reviewRevision?: string;
  reason?: "session-header-unavailable" | "session-jsonl-unavailable";
};

export type UnavailableSessionHeader = {
  filePath: string;
  sessionId?: string;
  reason: "session-header-unavailable";
};

export type TaskMetrics = {
  participantDurationMs: number;
  usageCost: number;
  toolResultFailures: number;
  retries: number;
  findings: FindingCounts;
};

export type TaskLineageSummary = {
  schemaVersion: 1;
  taskId: string;
  rootSessionId: string;
  parentSessionId: string | null;
  role: LineageRole;
  purpose: LineagePurpose;
  reviewRevision?: string;
  startedAt: string;
  completedAt?: string;
  updatedAt: string;
  terminalOutcome?: TerminalOutcome;
  roles: LineageRole[];
  participants: ParticipantSummary[];
  metrics: TaskMetrics;
  coverage: {
    expected: number;
    available: number;
    unavailable: number;
    entries: CoverageEntry[];
  };
};

export type AuditTaskOptions = {
  projectSessionDirectory: string;
  taskId: string;
  rootSessionId: string;
  updatedAt?: string;
};

export type SummaryPageFilters = {
  from?: string;
  to?: string;
  taskId?: string;
  role?: string;
  cursor?: string;
  limit?: number;
};

export type SummaryPage = {
  items: TaskLineageSummary[];
  nextCursor?: string;
};

export type RuntimeRecord = JsonObject;
export type ParsedLine = { value: RuntimeRecord; start: number; end: number };
export type ExpectedSpawn = ParticipantSpawnRecord & { occurrence: number };
export type DiscoveredParticipant = {
  toolCallId: string;
  role: LineageRole;
  purpose: LineagePurpose;
  reviewRevision?: string;
  auditWorker: boolean;
};
export type OutcomeCandidate = TaskOutcomeRecord & { recordKey: string; timestamp: string };
export type RetryCandidate = { participantKey: string; recordKey: string; retryCount?: number };
export type SessionAssignment = { spawn?: ExpectedSpawn };
export type SessionScan = {
  auditWorker: boolean;
  participant?: DiscoveredParticipant;
  expected: ExpectedSpawn[];
  outcomes: OutcomeCandidate[];
  retries: RetryCandidate[];
  usageCost: number;
  toolResultFailures: number;
  archiveAt?: string;
  archiveOutcome?: TerminalOutcome;
};
