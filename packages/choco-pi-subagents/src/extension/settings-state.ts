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

export function installPreferenceState(rt: SubagentsRuntime) {
  function getAgentMentionMode(): AgentMentionMode {
    return rt.state.agentMentionMode;
  }
  function setAgentMentionMode(mode: AgentMentionMode): void {
    rt.state.agentMentionMode = mode;
  }
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

  function setDisableDefaultAgents(b: boolean): void {
    setDefaultsDisabled(b);
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

export function installLoadedSettings(pi: ExtensionAPI, rt: SubagentsRuntime) {
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
