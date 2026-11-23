import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { canRegisterWebSearchTool, loadAgentBrowserConfigSync } from "./config.ts";
import { AGENT_BROWSER_HOST_PARAMS } from "./input-modes/params.ts";
import type { AgentBrowserToolResult } from "./orchestration/browser-run/index.ts";
import {
  AgentBrowserResultComponent,
  formatAgentBrowserRenderCall,
  formatAgentBrowserRenderResult,
} from "./pi-tool-rendering.ts";
import { buildToolPromptGuidelines } from "./playbook.ts";
import { registerExtensionLifecycleHandlers } from "./extension/lifecycle.ts";
import {
  createExtensionRuntimeState,
  registerWebSearchToolIfAvailable,
} from "./extension/state.ts";
import { executeAgentBrowserTool } from "./extension/tool-execution.ts";

export {
  getRequestedAgentBrowserCapabilities,
  getUnsupportedCapabilityError,
  probeAgentBrowserCompatibility,
} from "./extension/compatibility.ts";
export {
  getArtifactPreflightValidationError,
  mergeBrowserRunArtifactManifest,
} from "./extension/artifacts.ts";
export { runBranchRestoreForGeneration } from "./extension/branch-restore.ts";
export { KeyedAsyncExecutionQueue } from "./extension/managed-resources.ts";

interface InstalledDocsPaths {
  readmePath: string;
}

export function resolveInstalledDocsPaths(
  runtimeModuleUrl: string = import.meta.url,
): InstalledDocsPaths {
  return { readmePath: fileURLToPath(new URL("../../../README.md", runtimeModuleUrl)) };
}

export default function agentBrowserExtension(pi: ExtensionAPI) {
  const agentBrowserConfig = loadAgentBrowserConfigSync({
    cwd: process.cwd(),
    includeProjectConfig: false,
  });
  const webSearchToolAvailable = canRegisterWebSearchTool(agentBrowserConfig);
  const toolPromptGuidelines = buildToolPromptGuidelines({
    browserDefaultProfile: agentBrowserConfig.trustedBrowserDefaultProfile,
    browserExecutablePath: agentBrowserConfig.trustedBrowserExecutablePath,
    includeWebSearch: webSearchToolAvailable,
    docs: resolveInstalledDocsPaths(),
  });
  const state = createExtensionRuntimeState(pi);

  registerExtensionLifecycleHandlers(pi, state);

  const agentBrowserTool: ToolDefinition<typeof AGENT_BROWSER_HOST_PARAMS> = {
    name: "agent_browser",
    label: "Agent Browser",
    description:
      "Automate browser navigation, interaction, extraction, screenshots, QA, and supported Electron apps.",
    promptSnippet: "Automate browser navigation, interaction, extraction, and screenshots.",
    promptGuidelines: toolPromptGuidelines,
    parameters: AGENT_BROWSER_HOST_PARAMS,
    renderCall(args, theme, context) {
      const text =
        context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      text.setText(formatAgentBrowserRenderCall(args, theme, context.expanded));
      return text;
    },
    renderResult(result, options, theme, context) {
      const component =
        context.lastComponent instanceof AgentBrowserResultComponent
          ? context.lastComponent
          : new AgentBrowserResultComponent();
      component.setState(
        formatAgentBrowserRenderResult(result, options, theme, context.isError),
        options.expanded,
        theme,
      );
      return component;
    },
    execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentBrowserToolResult> {
      return executeAgentBrowserTool(
        state,
        agentBrowserTool.execute,
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      );
    },
  } satisfies ToolDefinition<typeof AGENT_BROWSER_HOST_PARAMS>;
  pi.registerTool(agentBrowserTool);

  registerWebSearchToolIfAvailable(state, agentBrowserConfig);
}
