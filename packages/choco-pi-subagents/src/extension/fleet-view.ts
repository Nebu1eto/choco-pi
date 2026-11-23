import type { WidgetMode } from "../types.ts";
import { FocusedAgentController } from "../ui/focus-mode.ts";
import { resolveModel } from "../model-resolver.ts";
import { SideConversationController } from "../ui/side-conversation.ts";
import { FleetPanel } from "../ui/fleet-panel.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentsRuntime } from "./runtime.ts";

export function installFleetView(pi: ExtensionAPI, rt: SubagentsRuntime) {
  function getWidgetMode(): WidgetMode {
    return rt.state.widgetMode;
  }
  function setWidgetMode(m: WidgetMode): void {
    rt.state.widgetMode = m;
    fleet.update();
  }

  const focus = new FocusedAgentController(rt.core.manager, {
    getHideThinkingBlock: () => pi.getSettings().hideThinkingBlock === true,
    getActivity: (id) => rt.agentActivity.get(id),
    onSteered: (id, message) =>
      rt.notifications.emitLifecycle("subagents:steered", { id, message }),
    hasSwitcher: () => isFleetViewEnabled() && fleet.hasAgentRows(),
    resolveModel: (query) => {
      if (!rt.state.currentCtx) return undefined;
      const resolution = resolveModel(query, rt.state.currentCtx.modelRegistry);
      return resolution.tag === "resolved" ? resolution.model : undefined;
    },
  });

  const sideConversations = new SideConversationController(rt.core.manager, {
    getActivity: (id) => rt.agentActivity.get(id),
    onSteered: (id, message) =>
      rt.notifications.emitLifecycle("subagents:steered", { id, message }),
    focusAgent: (record, tui, theme) => focus.focus(record, tui, theme),
  });

  const fleet = new FleetPanel(
    rt.core.manager,
    rt.agentActivity,
    {
      focusAgent: (record, tui, theme) => focus.focus(record, tui, theme),
      focusedAgentId: () => focus.getFocusedAgentId(),
      unfocusAgent: () => focus.unfocus(),
      openSideConversation: (record) => sideConversations.open(record),
    },
    {
      widgetMode: getWidgetMode,
      isMainCompacting: () => rt.sessionLifecycle.mainCompaction.isCompacting(),
    },
  );
  rt.state.fleetSource = fleet;
  function isFleetViewEnabled(): boolean {
    return rt.state.fleetViewEnabled;
  }
  fleet.setAgentSectionEnabled(isFleetViewEnabled());
  if (rt.state.shellSectionProvider) fleet.setShellSection(rt.state.shellSectionProvider);
  function setFleetViewEnabled(b: boolean): void {
    rt.state.fleetViewEnabled = b;
    fleet.setAgentSectionEnabled(b);
  }

  return {
    fleet,
    sideConversations,
    focus,
    setFleetViewEnabled,
    setWidgetMode,
    isFleetViewEnabled,
    getWidgetMode,
  };
}
