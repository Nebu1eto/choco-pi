import assert from "node:assert/strict";
import test from "node:test";
import {
  applySubagentSetting,
  buildSubagentSettingItems,
  getSubagentNumericSettingRange,
  SUBAGENT_SETTING_DEFINITIONS,
  type SubagentSettingsController,
} from "../src/preferences-section.ts";

interface ControllerFixture {
  controller: SubagentSettingsController;
  calls: string[];
}

interface ControllerState {
  maxConcurrent: number;
  defaultMaxTurns: number;
  graceTurns: number;
  maxSubagentDepth: number;
  joinMode: "smart" | "async" | "group";
  schedulingEnabled: boolean;
  scopeModels: boolean;
  strictAgentFiles: boolean;
  defaultsDisabled: boolean;
  fallbackSubagent: string | undefined;
  outputTranscript: boolean;
  worktreeIsolation: boolean;
  fleetView: boolean;
  agentMentionMode: "model" | "direct" | "off";
  rememberAgents: boolean;
  widgetMode: "off" | "background" | "all";
  toolDescriptionMode: "full" | "compact" | "custom";
}

function createController(): ControllerFixture {
  const calls: string[] = [];
  const state: ControllerState = {
    maxConcurrent: 8,
    defaultMaxTurns: 0,
    graceTurns: 2,
    maxSubagentDepth: 2,
    joinMode: "smart",
    schedulingEnabled: true,
    scopeModels: false,
    strictAgentFiles: true,
    defaultsDisabled: false,
    fallbackSubagent: undefined,
    outputTranscript: true,
    worktreeIsolation: true,
    fleetView: true,
    agentMentionMode: "model",
    rememberAgents: true,
    widgetMode: "background",
    toolDescriptionMode: "full",
  };

  const controller: SubagentSettingsController = {
    getMaxConcurrent: () => state.maxConcurrent,
    setMaxConcurrent: (value) => {
      state.maxConcurrent = value;
      calls.push(`maxConcurrent:${value}`);
    },
    getDefaultMaxTurns: () => state.defaultMaxTurns,
    setDefaultMaxTurns: (value) => calls.push(`defaultMaxTurns:${String(value)}`),
    getGraceTurns: () => state.graceTurns,
    setGraceTurns: (value) => calls.push(`graceTurns:${value}`),
    getMaxSubagentDepth: () => state.maxSubagentDepth,
    setMaxSubagentDepth: (value) => calls.push(`maxSubagentDepth:${value}`),
    getDefaultJoinMode: () => state.joinMode,
    setDefaultJoinMode: (value) => calls.push(`joinMode:${value}`),
    isSchedulingEnabled: () => state.schedulingEnabled,
    setSchedulingEnabled: (value) => {
      state.schedulingEnabled = value;
      calls.push(`scheduling:${value}`);
    },
    stopScheduler: () => calls.push("scheduler:stop"),
    isScopeModelsEnabled: () => state.scopeModels,
    setScopeModelsEnabled: (value) => calls.push(`scopeModels:${value}`),
    isStrictAgentFiles: () => state.strictAgentFiles,
    setStrictAgentFiles: (value) => calls.push(`strictAgentFiles:${value}`),
    isDefaultsDisabled: () => state.defaultsDisabled,
    setDisableDefaultAgents: (value) => calls.push(`defaultsDisabled:${value}`),
    getFallbackSubagent: () => state.fallbackSubagent,
    getAvailableTypes: () => ["general-purpose", "Explore"],
    noFallbackValue: "none",
    setFallbackSubagent: (value) => calls.push(`fallback:${value}`),
    getOutputTranscriptDefault: () => state.outputTranscript,
    setOutputTranscriptDefault: (value) => calls.push(`outputTranscript:${value}`),
    isWorktreeIsolationEnabled: () => state.worktreeIsolation,
    setWorktreeIsolationEnabled: (value) => calls.push(`worktreeIsolation:${value}`),
    isFleetViewEnabled: () => state.fleetView,
    setFleetViewEnabled: (value) => calls.push(`fleetView:${value}`),
    getAgentMentionMode: () => state.agentMentionMode,
    setAgentMentionMode: (value) => calls.push(`agentMentions:${value}`),
    getRememberAgents: () => state.rememberAgents,
    setRememberAgents: (value) => calls.push(`rememberAgents:${value}`),
    getWidgetMode: () => state.widgetMode,
    setWidgetMode: (value) => calls.push(`widget:${value}`),
    getToolDescriptionMode: () => state.toolDescriptionMode,
    setToolDescriptionMode: (value) => calls.push(`toolDescription:${value}`),
    notifyApplied: (message) => calls.push(`applied:${message}`),
    notifyInfo: (message) => calls.push(`info:${message}`),
  };
  return { controller, calls };
}

test("the shared definitions preserve the /agents item set and labels", () => {
  assert.deepEqual(
    SUBAGENT_SETTING_DEFINITIONS.map(({ id, label }) => [id, label]),
    [
      ["maxConcurrent", "Max concurrency"],
      ["defaultMaxTurns", "Default max turns"],
      ["graceTurns", "Grace turns"],
      ["maxSubagentDepth", "Nested depth"],
      ["joinMode", "Join mode"],
      ["schedulingEnabled", "Scheduling"],
      ["scopeModels", "Scope models"],
      ["strictAgentFiles", "Strict agent files"],
      ["disableDefaultAgents", "Disable defaults"],
      ["fallbackSubagent", "Fallback agent"],
      ["outputTranscript", "Output transcript"],
      ["worktreeIsolation", "Worktree isolation"],
      ["fleetView", "Fleet view"],
      ["agentMentions", "Agent mentions"],
      ["rememberAgents", "Remember agents"],
      ["widgetMode", "Widget"],
      ["toolDescriptionMode", "Tool description"],
    ],
  );
});

test("numeric definitions expose the persisted ranges", () => {
  assert.deepEqual(getSubagentNumericSettingRange("maxConcurrent"), {
    min: 0,
    max: 1024,
    inputLabel: "Max concurrency (0 = unlimited)",
  });
  assert.deepEqual(getSubagentNumericSettingRange("maxSubagentDepth"), {
    min: 0,
    max: 16,
    inputLabel: "Nested depth (0/1 = nesting off)",
  });
});

test("maxConcurrent renders zero as unlimited while retaining zero as a selectable value", () => {
  const { controller } = createController();
  controller.setMaxConcurrent(0);
  const menuItem = buildSubagentSettingItems(controller).find(
    (item) => item.id === "maxConcurrent",
  );
  const preferencesItem = buildSubagentSettingItems(controller, { numericRanges: true }).find(
    (item) => item.id === "maxConcurrent",
  );
  assert.equal(menuItem?.currentValue, "unlimited");
  assert.deepEqual(menuItem?.values, ["0"]);
  assert.equal(preferencesItem?.values?.[0], "0");
  assert.equal(preferencesItem?.values.at(-1), "1024");
});

test("shared apply plumbing invokes live setters and the persistence callback", () => {
  const { controller, calls } = createController();
  applySubagentSetting("maxConcurrent", "0", controller);
  applySubagentSetting("maxSubagentDepth", "16", controller);
  applySubagentSetting("fleetView", "off", controller);
  applySubagentSetting("schedulingEnabled", "off", controller);

  assert.deepEqual(calls, [
    "maxConcurrent:0",
    "applied:Max concurrency set to unlimited",
    "maxSubagentDepth:16",
    "applied:Nested depth set to 16. Applies to agents started from now on.",
    "fleetView:false",
    "applied:Fleet view disabled",
    "scheduling:false",
    "scheduler:stop",
    "applied:Scheduling disabled. Tool spec change takes effect on next pi session.",
  ]);
});
