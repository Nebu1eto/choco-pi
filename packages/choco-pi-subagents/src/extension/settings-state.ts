/**
 * Runtime preference state.
 */
import type { AgentMentionMode, JoinMode } from "../types.ts";
import { setDefaultsDisabled, setFallbackSubagent } from "../agent-types.ts";
import { applyAndEmitLoaded } from "../settings.ts";
import { setDefaultMaxTurns, setGraceTurns, setRememberAgents } from "../agent-runner.ts";
import { setScopeModelsEnabled } from "../model-scope.ts";
import { setRequireExplicitModel } from "../invocation-config.ts";
import { setOutputTranscriptDefault } from "../output-file.ts";
import { setWorktreeIsolationEnabled } from "../worktree.ts";
import { setMaxSubagentDepth } from "../nested-tools.ts";
import type { SubagentsRuntime } from "./runtime.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Runtime preference getters and setters (mentions, join mode, scheduling, defaults). */
export function installPreferenceState(rt: SubagentsRuntime) {
  function getAgentMentionMode(): AgentMentionMode {
    return rt.state.agentMentionMode;
  }
  function setAgentMentionMode(mode: AgentMentionMode): void {
    rt.state.agentMentionMode = mode;
  }
  // `model` and `direct` differ only in who starts a not-yet-running agent, so
  // everything that just asks "are mentions live at all" — the suggestion list,
  // the steer and resume branches — reads this instead of the mode.
  function isAgentMentionsEnabled(): boolean {
    return rt.state.agentMentionMode !== "off";
  }
  function getDefaultJoinMode(): JoinMode {
    return rt.state.defaultJoinMode;
  }
  function setDefaultJoinMode(mode: JoinMode) {
    rt.state.defaultJoinMode = mode;
  }
  function isSchedulingEnabled(): boolean {
    return rt.state.schedulingEnabled;
  }
  function setSchedulingEnabled(b: boolean) {
    rt.state.schedulingEnabled = b;
  }

  // ---- Disable default agents configuration ----
  // When enabled, the three hardcoded default agents (general-purpose, Explore,
  // Plan) are not registered. User-defined agents from project/global custom
  // agent dirs are completely unaffected — only DEFAULT_AGENTS are suppressed.
  // Defaults to false; opt-in via `/agents → Settings` or subagents.json.
  // State lives in agent-types.ts (isDefaultsDisabled) because registerAgents
  // needs it; this wrapper just re-registers after flipping it.
  function setDisableDefaultAgents(b: boolean): void {
    setDefaultsDisabled(b);
    // Re-register with the new setting from the last load: no filesystem read,
    // so this synchronous settings applier leaves the registry current at once.
    rt.agentReloader.reregister();
  }

  return {
    isSchedulingEnabled,
    isAgentMentionsEnabled,
    getAgentMentionMode,
    setDefaultJoinMode,
    setSchedulingEnabled,
    setDisableDefaultAgents,
    setAgentMentionMode,
    getDefaultJoinMode,
  };
}

/** Applies the persisted settings loaded at activation. */
export function installLoadedSettings(pi: ExtensionAPI, rt: SubagentsRuntime) {
  // Apply persisted settings on startup and emit `subagents:settings_loaded`.
  // Global + project merged; missing → defaults; corrupt file emits a warning
  // to stderr and falls back to defaults. Loaded once at activation (above).
  applyAndEmitLoaded(
    rt.initialSettings,
    {
      setMaxConcurrent: (n) => rt.core.manager.setMaxConcurrent(n),
      setDefaultMaxTurns,
      setGraceTurns,
      setDefaultJoinMode: rt.preferences.setDefaultJoinMode,
      setSchedulingEnabled: rt.preferences.setSchedulingEnabled,
      setScopeModels: setScopeModelsEnabled,
      setStrictAgentFiles: (b) => {
        rt.state.strictAgentFiles = b;
      },
      setRequireExplicitModel,
      setDisableDefaultAgents: rt.preferences.setDisableDefaultAgents,
      setFleetView: rt.views.setFleetViewEnabled,
      setAgentMentions: rt.preferences.setAgentMentionMode,
      setRememberAgents,
      setWidgetMode: rt.views.setWidgetMode,
      setOutputTranscript: setOutputTranscriptDefault,
      setWorktreeIsolation: setWorktreeIsolationEnabled,
      setMaxSubagentDepth: setMaxSubagentDepth,
      setFallbackSubagent: setFallbackSubagent,
    },
    (event, payload) => pi.events.emit(event, payload),
  );
}
