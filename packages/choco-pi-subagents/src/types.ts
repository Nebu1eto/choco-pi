import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { JournalRunOptions } from "./revival-journal.ts";
import type { SubagentUsageLimit } from "./usage-limit-seam.ts";
import type { LifetimeUsage } from "./usage.ts";

export type { SubagentUsageLimit, ThinkingLevel };

export type SubagentType = string;

export const DEFAULT_AGENT_NAMES = ["general-purpose", "Explore", "Plan"] as const;

export type MemoryScope = "user" | "project" | "local";

export type IsolationMode = "worktree" | "off";

export interface AgentConfig {
  name: string;
  displayName?: string;
  color?: string;
  description: string;
  builtinToolNames?: string[];
  extSelectors?: string[];
  disallowedTools?: string[];
  extensions: true | string[] | false;
  excludeExtensions?: string[];
  skills: true | string[] | false;
  model?: string;
  thinking?: ThinkingLevel;
  modelLocked?: boolean;
  maxTurns?: number;
  persistSession?: boolean;
  outputTranscript?: boolean;
  sessionDir?: string;
  allowedSubagents?: "all" | string[];
  systemPrompt: string;
  promptMode: "replace" | "append";
  inheritContext?: boolean;
  runInBackground?: boolean;
  isolated?: boolean;
  fastMode?: boolean;
  daybreak?: boolean;
  memory?: MemoryScope;
  isolation?: IsolationMode;
  isDefault?: boolean;
  enabled?: boolean;
  internal?: boolean;
  source?: "default" | "project" | "global";
  sourcePath?: string;
}

export type JoinMode = "async" | "group" | "smart";

export type WidgetMode = "all" | "background" | "off";

export type AgentMentionMode = "model" | "direct" | "off";

export interface AgentTombstone {
  handle: string;
  alias?: string;
  id: string;
  type: SubagentType;
  description: string;
  sessionFile: string;
  completedAt: number;
}

export type MentionResolution =
  | { kind: "live"; record: AgentRecord }
  | { kind: "tombstone"; entry: AgentTombstone };

export type ModelSource = "pin" | "caller" | "default" | "inherit";

export interface ModelProvenance {
  model?: string;
  source: ModelSource;
  thinking?: string;
  definition?: string;
}

export interface AgentRecord {
  id: string;
  type: SubagentType;
  handle?: string;
  alias?: string;
  description: string;
  modelProvenance?: ModelProvenance;
  status:
    | "queued"
    | "running"
    | "completed"
    | "steered"
    | "aborted"
    | "stopped"
    | "budget_exceeded"
    | "watchdog_stopped"
    | "error"
    | "waiting_for_reset"
    | "interrupted";
  result?: string;
  pendingDependents?: {
    id: string;
    handle?: string;
    status: "running" | "queued" | "waiting_for_reset";
  }[];
  error?: string;
  usageLimit?: SubagentUsageLimit;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  session?: AgentSession;
  sessionCostBaseline?: { sessionId: string; cost: number };
  abortController?: AbortController;
  promise?: Promise<string>;
  groupId?: string;
  joinMode?: JoinMode;
  resultGeneration?: number;
  cancellation?: {
    generation: number;
    cause: "budget" | "watchdog" | "user_stop" | "parent_signal" | "shutdown" | "suspend";
    reason: string;
    requestedAt: number;
  };
  terminalResultGeneration?: number;
  verdictTask?: { workTask: string; rootSessionId: string };
  verdictRecordedGeneration?: number;
  verdictRecord?: string;
  activeResultReadGeneration?: number;
  consumedResultGeneration?: number;
  resultConsumed?: boolean;
  pendingSteers?: string[];
  worktree?: {
    path: string;
    branch: string;
    baseSha: string;
    workPath: string;
    hookManaged?: boolean;
  };
  worktreeRepo?: string;
  revivals?: number;
  stoppedByUser?: boolean;
  spawnPrompt?: string;
  runOptions?: JournalRunOptions;
  spawnCwd?: string;
  spawnModel?: { provider: string; id: string };
  inMemorySession?: boolean;
  worktreeResult?: { hasChanges: boolean; branch?: string; path?: string; retained?: true };
  toolCallId?: string;
  outputFile?: string;
  sessionFile?: string;
  outputCleanup?: () => void;
  lifetimeUsage: LifetimeUsage;
  compactionCount: number;
  isBackground?: boolean;
  invocation?: AgentInvocation;
  sideConversation?: boolean;
  transcriptStartAt?: number;
  workflowId?: string;
  workflowStepId?: string;
  admissionEpoch?: number;
  admissionRoot?: string;
  depth?: number;
  parentAgentId?: string;
  maxSubagentDepth?: number;
  rootSessionId?: string;
  fastModeRequested?: boolean;
  fastModeSource?: "default" | "explicit" | "inherited";
  fastModeRevision?: number;
  fastModeInitialization?: {
    requested: boolean;
    source: "default" | "explicit" | "inherited";
    revision: number;
  };
  daybreakRequested?: boolean | "auto";
  daybreakSource?: "default" | "explicit" | "inherited";
  daybreakRevision?: number;
  daybreakInitialization?: {
    requested: boolean | "auto";
    source: "default" | "explicit" | "inherited";
    revision: number;
  };
}

export interface AgentInvocation {
  modelName?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  timeoutMs?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  idleTimeoutMs?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  runInBackground?: boolean;
  isolation?: IsolationMode;
  fastMode?: boolean;
  daybreak?: boolean;
}

export interface NotificationDetails {
  id: string;
  description: string;
  type?: string;
  status: string;
  toolUses: number;
  turnCount: number;
  maxTurns?: number;
  totalTokens: number;
  durationMs: number;
  outputFile?: string;
  error?: string;
  resultPreview: string;
  usageLimit?: SubagentUsageLimit;
  others?: NotificationDetails[];
}

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string;
  platform: string;
}

export interface ScheduledSubagent {
  id: string;
  name: string;
  description: string;
  schedule: string;
  scheduleType: "cron" | "once" | "interval";
  intervalMs?: number;

  subagent_type: SubagentType;
  prompt: string;
  model?: string;
  thinking?: ThinkingLevel;
  max_turns?: number;
  timeout_ms?: number;
  max_tool_calls?: number;
  max_tokens?: number;
  idle_timeout_ms?: number;
  isolated?: boolean;
  isolation?: IsolationMode;
  fast_mode?: boolean;
  daybreak?: boolean;

  enabled: boolean;
  createdAt: string;
  lastRun?: string;
  lastStatus?: "success" | "error" | "running";
  nextRun?: string;
  runCount: number;
}

export interface ScheduleStoreData {
  version: 1;
  jobs: ScheduledSubagent[];
}

export interface StopWorkflowPort {
  runningFor(rootSessionId: string): string[];
  cancel(workflowId: string): boolean;
}

export interface UserStopResult {
  agents: number;
  workflows: number;
  ownerSessionIds: string[];
  records: AgentRecord[];
  settled: Promise<string[]>;
}
