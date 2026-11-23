/**
 * Shared runtime the extension modules receive from the composition root in ../index.ts.
 */
import type { FleetPanel } from "../ui/fleet-panel.ts";
import type { ShellSectionProvider } from "../ui/shell-section-contract.ts";
import type { ProgramStatusBridge } from "../program-status-bridge.ts";
import type { WorkflowManager } from "../workflow.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RpcHandle } from "../cross-extension-rpc.ts";
import type { WidgetMode, AgentMentionMode, JoinMode } from "../types.ts";
import type { SubagentsSettings } from "../settings.ts";
import type { AgentReloader } from "../agent-reload.ts";
import type { AgentActivity } from "../ui/agent-widget.ts";
import type { installNotifications } from "./notifications.ts";
import type { installAgentManager } from "./manager-setup.ts";
import type { installManagerRegistry } from "./registry.ts";
import type { installScheduler } from "./scheduler.ts";
import type { installRevival } from "./revival.ts";
import type { installMentionInput } from "./mention-input.ts";
import type { installSessionLifecycle } from "./session-lifecycle.ts";
import type { installFleetView } from "./fleet-view.ts";
import type { installWorkflowManager } from "./workflow-manager.ts";
import type { installStopIntegration } from "./stop-integration.ts";
import type { installPreferenceState } from "./settings-state.ts";
import type { installBackgroundResume } from "./background-resume.ts";
import type { installAgentTools } from "./agent-tool.ts";
import type { installAgentsMenu } from "./agents-menu.ts";
import type { installSettingsMenu } from "./settings-menu.ts";

/** Mutable activation state shared by the extension's modules (formerly closure `let` bindings). */
export interface SubagentsState {
  strictAgentFiles: boolean;
  // The process-global registry is initialized before FleetPanel construction.
  // Keep its optional UI capability behind a non-TDZ source that becomes live
  // only after the root FleetPanel exists.
  fleetSource: FleetPanel | undefined;
  shellSectionProvider: ShellSectionProvider | undefined;
  /** Root session this activation serves; set on session_start, cleared on shutdown. */
  activeRootSessionId: string | undefined;
  /** Completion notifications sent to the root; the print-mode settle wait watches it. */
  completionDeliveries: number;
  /** Keeps the root's terminal status `working` while its background agents run (TUI only). */
  programStatus: ProgramStatusBridge | undefined;
  // Assigned after the shared UI controllers are constructed. Agent completion
  // callbacks can still consult it because no child settles synchronously.
  workflows: WorkflowManager | undefined;
  // --- Cross-extension RPC via pi.events ---
  currentCtx: ExtensionContext | undefined;
  nextMentionCloneGeneration: number;
  activeMentionCloneGeneration: number | undefined;
  // RPC handlers + the `subagents:ready` broadcast are wired on `session_start`
  // (a bound lifecycle event), not at factory time. pi runs every extension
  // factory before the `extensions:` filter and only fires lifecycle events for
  // survivors, so a child session that filtered pi-subagents out never reaches
  // session_start — and must not advertise or answer RPC it can't service
  // (currentCtx would stay undefined → spawn always "No active session"). Gating
  // here makes a filtered session behave like an absent one (#142).
  rpcHandle: RpcHandle | undefined;
  messageNotificationUnsubscribe: (() => void) | undefined;
  unregisterPreferencesProvider: (() => void) | undefined;
  /** Whether the `@handle` autocomplete wrapper has been stacked on pi's provider. */
  mentionProviderRegistered: boolean;
  /** Bumped by every stop: a store load that finishes after a stop or restart never binds. */
  schedulerGeneration: number;
  /** The in-flight store load, so the schedule path can wait for it instead of refusing. */
  schedulerStarting: Promise<void> | undefined;
  /** Bumped on every session_start/session_shutdown; stale continuations compare it. */
  revivalGeneration: number;
  journalActive: boolean;
  revivalTimer: ReturnType<typeof setTimeout> | undefined;
  // Widget mode controls agent-row detail verbosity and is read live at render time.
  widgetMode: WidgetMode;
  fleetViewEnabled: boolean;
  unsubscribeRevoke: (() => void) | undefined;
  // Claude Code-style `@handle message` prompt mentions. Read live by both the
  // `input` hook and the stacked autocomplete provider, so the toggle applies
  // immediately — the provider itself can never be unregistered (pi's wrapper
  // list is append-only), it just delegates everything when this is off.
  agentMentionMode: AgentMentionMode;
  // Project/global default for writing the subagent .output transcript lives in
  // output-file.ts (both spawn paths read it). A custom agent's
  // `output_transcript` frontmatter overrides it per spawn; when the frontmatter
  // is silent, this default applies. Read live at spawn time.
  // ---- Join mode configuration ----
  defaultJoinMode: JoinMode;
  // Master switch for the schedule subagent feature. Defaults to enabled.
  // Read once at extension init (before tool registration) so the Agent tool's
  // param schema reflects the persisted setting. Runtime toggles via /agents
  // → Settings short-circuit the menu entry + the execute-time addJob path
  // immediately, but the schema-level removal only takes effect on next
  // extension load (next pi session). Documented in CHANGELOG/README.
  schedulingEnabled: boolean;
  // ---- Batch tracking for smart join mode ----
  // Collects background agent IDs spawned in the current turn for smart grouping.
  // Uses a debounced timer: each new agent resets the 100ms window so that all
  // parallel tool calls (which may be dispatched across multiple microtasks by the
  // framework) are captured in the same batch.
  currentBatchAgents: { id: string; joinMode: JoinMode }[];
  batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  batchCounter: number;
}

/** One activation's shared state, activation-scoped values, and each module's published bindings. */
export interface SubagentsRuntime {
  readonly state: SubagentsState;
  readonly initialSettings: SubagentsSettings;
  readonly agentReloader: AgentReloader;
  readonly reloadCustomAgents: (strict?: boolean) => Promise<void>;
  readonly refreshAgentsInBackground: () => void;
  readonly agentActivity: Map<string, AgentActivity>;
  readonly notifications: ReturnType<typeof installNotifications>;
  readonly core: ReturnType<typeof installAgentManager>;
  readonly registry: ReturnType<typeof installManagerRegistry>;
  readonly scheduling: ReturnType<typeof installScheduler>;
  readonly revival: ReturnType<typeof installRevival>;
  readonly mentions: ReturnType<typeof installMentionInput>;
  readonly sessionLifecycle: ReturnType<typeof installSessionLifecycle>;
  readonly views: ReturnType<typeof installFleetView>;
  readonly workflowRuntime: ReturnType<typeof installWorkflowManager>;
  readonly stopControl: ReturnType<typeof installStopIntegration>;
  readonly preferences: ReturnType<typeof installPreferenceState>;
  readonly background: ReturnType<typeof installBackgroundResume>;
  readonly agentTool: ReturnType<typeof installAgentTools>;
  readonly agentsMenu: ReturnType<typeof installAgentsMenu>;
  readonly settingsMenu: ReturnType<typeof installSettingsMenu>;
}
