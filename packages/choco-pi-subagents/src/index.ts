import { inChildSessionContext } from "./child-context.ts";
import { registerMentionCloneParentPromptObserver } from "./mention-clone.ts";
import { ensureEnabledModels } from "./enabled-models.ts";
import { loadSettings } from "./settings.ts";
import { createAgentReloader } from "./agent-reload.ts";
import { loadCustomAgents } from "./custom-agents.ts";
import { registerAgents } from "./agent-types.ts";
import type { AgentActivity } from "./ui/agent-widget.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentsRuntime, SubagentsState } from "./extension/runtime.ts";
import { installMessageRenderers, installNotifications } from "./extension/notifications.ts";
import { installAgentManager } from "./extension/manager-setup.ts";
import { installManagerRegistry } from "./extension/registry.ts";
import { installScheduler } from "./extension/scheduler.ts";
import { installRevival } from "./extension/revival.ts";
import { installSessionStart, installSessionLifecycle } from "./extension/session-lifecycle.ts";
import { installMentionInput } from "./extension/mention-input.ts";
import { installFleetView } from "./extension/fleet-view.ts";
import { installWorkflowManager } from "./extension/workflow-manager.ts";
import { installStopIntegration } from "./extension/stop-integration.ts";
import { installPreferenceState, installLoadedSettings } from "./extension/settings-state.ts";
import { installBackgroundResume } from "./extension/background-resume.ts";
import { installAgentTools } from "./extension/agent-tool.ts";
import { installWorkflowTools } from "./extension/workflow-tools.ts";
import { installAgentControlTools } from "./extension/agent-control-tools.ts";
import { installAgentsMenu } from "./extension/agents-menu.ts";
import { installSettingsMenu } from "./extension/settings-menu.ts";
import { installCommands } from "./extension/commands.ts";

export { formatToolsSuffix } from "./extension/helpers.ts";

export {
  buildRecordDetails,
  delegationRenderers,
  renderRunningAgentStatus,
} from "./delegation-render.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
  if (inChildSessionContext()) return;
  registerMentionCloneParentPromptObserver(pi);

  installMessageRenderers(pi);

  const activationCwd = process.cwd();
  void ensureEnabledModels(activationCwd);
  const initialSettings = await loadSettings(activationCwd);

  const state: SubagentsState = {
    strictAgentFiles: initialSettings.strictAgentFiles === true,
    fleetSource: undefined,
    shellSectionProvider: undefined,
    activeRootSessionId: undefined,
    completionDeliveries: 0,
    programStatus: undefined,
    workflows: undefined,
    currentCtx: undefined,
    nextMentionCloneGeneration: 0,
    activeMentionCloneGeneration: undefined,
    rpcHandle: undefined,
    messageNotificationUnsubscribe: undefined,
    unregisterPreferencesProvider: undefined,
    mentionProviderRegistered: false,
    schedulerGeneration: 0,
    schedulerStarting: undefined,
    revivalGeneration: 0,
    journalActive: false,
    revivalTimer: undefined,
    widgetMode: "background",
    fleetViewEnabled: true,
    unsubscribeRevoke: undefined,
    agentMentionMode: "model",
    defaultJoinMode: "smart",
    schedulingEnabled: true,
    currentBatchAgents: [],
    batchFinalizeTimer: undefined,
    batchCounter: 0,
  };

  const agentReloader = createAgentReloader({
    load: loadCustomAgents,
    register: registerAgents,
    cwd: () => process.cwd(),
  });
  const reloadCustomAgents = (strict = false): Promise<void> => agentReloader.reload(strict);
  const refreshAgentsInBackground = (): void => {
    void reloadCustomAgents().catch((error) => {
      console.warn("[choco-pi-subagents] Agent reload failed:", error);
    });
  };

  await reloadCustomAgents(state.strictAgentFiles);

  const agentActivity = new Map<string, AgentActivity>();

  const rt: SubagentsRuntime = {
    state,
    initialSettings,
    agentReloader,
    reloadCustomAgents,
    refreshAgentsInBackground,
    agentActivity,
    get notifications() {
      return notifications;
    },
    get core() {
      return core;
    },
    get registry() {
      return registry;
    },
    get scheduling() {
      return scheduling;
    },
    get revival() {
      return revival;
    },
    get mentions() {
      return mentions;
    },
    get sessionLifecycle() {
      return sessionLifecycle;
    },
    get views() {
      return views;
    },
    get workflowRuntime() {
      return workflowRuntime;
    },
    get stopControl() {
      return stopControl;
    },
    get preferences() {
      return preferences;
    },
    get background() {
      return background;
    },
    get agentTool() {
      return agentTool;
    },
    get agentsMenu() {
      return agentsMenu;
    },
    get settingsMenu() {
      return settingsMenu;
    },
  };

  const notifications = installNotifications(pi, rt);

  const core = installAgentManager(pi, rt);

  const registry = installManagerRegistry(rt);

  const scheduling = installScheduler(pi, rt);

  const revival = installRevival(pi, rt);

  installSessionStart(pi, rt);

  const mentions = installMentionInput(pi, rt);

  const sessionLifecycle = installSessionLifecycle(pi, rt);

  const views = installFleetView(pi, rt);

  const workflowRuntime = installWorkflowManager(pi, rt);

  const stopControl = installStopIntegration(pi, rt);

  const preferences = installPreferenceState(rt);

  const background = installBackgroundResume(pi, rt);

  installLoadedSettings(pi, rt);

  const agentTool = installAgentTools(pi, rt);

  installWorkflowTools(pi, rt);

  installAgentControlTools(pi, rt);

  const agentsMenu = installAgentsMenu(pi, rt);

  const settingsMenu = installSettingsMenu(pi, rt);

  installCommands(pi, rt);
}
