import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  confirmCanonicalSearchRegistration,
  getSearchScope,
} from "../choco-pi-web-search/index.ts";
import { registerWebAccessSearchAdapters } from "./search-adapters.ts";
import {
  DEFAULT_SHORTCUTS,
  isToolEnabled,
  joinToolNames,
  loadConfigForExtensionInitAsync,
  resolveToolNames,
} from "./extension-config.ts";
import {
  createSearchRuntime,
  handleSessionChange,
  pendingCurates,
  shutdownSessionState,
  toggleActivityWidget,
} from "./curator-lifecycle.ts";
import { registerWebSearchTool } from "./tools/web-search-tool.ts";
import { registerSourceCheckTool } from "./tools/source-check-tool.ts";
import { registerFetchContentTool } from "./tools/fetch-content-tool.ts";
import { registerGetSearchContentTool } from "./tools/get-search-content-tool.ts";
import { registerWebAccessCommands } from "./commands.ts";

export {
  getSummaryGenerationDeadlineMs,
  resolveCuratorDefaultProvider,
  type CuratorProvider,
  type ProviderAvailability,
} from "./extension-config.ts";
export {
  createWebAccessScope,
  getWebAccessScope,
  registerContentExtractor,
  registerFetchTransport,
  WEB_ACCESS_SCOPE_SYMBOL,
  WebAccessScope,
  type ContentExtractor,
  type ContentExtractorContext,
  type ContentExtractorStage,
  type FetchTransport,
  type FetchTransportContext,
  type FetchTransportResult,
} from "./fetch-registry.ts";

export default async function (pi: ExtensionAPI) {
  registerWebAccessSearchAdapters(pi);
  const initConfig = await loadConfigForExtensionInitAsync();
  const toolNames = resolveToolNames(initConfig);
  const webSearchEnabled = isToolEnabled(initConfig, "webSearch");
  const sourceCheckEnabled = isToolEnabled(initConfig, "sourceCheck");
  const fetchContentEnabled = isToolEnabled(initConfig, "fetchContent");
  const getSearchContentEnabled = isToolEnabled(initConfig, "getSearchContent");
  const storedContentSources = joinToolNames([
    ...(webSearchEnabled ? [toolNames.webSearch] : []),
    ...(sourceCheckEnabled ? [toolNames.sourceCheck] : []),
    ...(fetchContentEnabled ? [toolNames.fetchContent] : []),
  ]);
  const searchQueryDescription = webSearchEnabled
    ? `Get content for this query (${toolNames.webSearch})`
    : "Get content for a stored search query";
  const curateKey = initConfig.shortcuts?.curate || DEFAULT_SHORTCUTS.curate;
  const activityKey = initConfig.shortcuts?.activity || DEFAULT_SHORTCUTS.activity;

  const runtime = createSearchRuntime(pi, toolNames, curateKey);

  pi.registerShortcut(curateKey, {
    description: "Review search results",
    handler: async (ctx) => {
      const entries = [...pendingCurates.entries()];
      if (entries.length === 0) return;
      const [callId, pc] = entries[entries.length - 1];
      if (pc.phase === "searching") {
        pc.browserPromise = runtime.openCuratorBrowser(callId, pc, ctx, false);
        ctx.ui.notify("Opening curator — remaining searches will stream in", "info");
      }
    },
  });

  pi.registerShortcut(activityKey, {
    description: "Toggle web search activity",
    handler: async (ctx) => {
      toggleActivityWidget(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    runtime.clearPublishedReferences();
    handleSessionChange(ctx, "session_start");
  });
  pi.on("session_tree", async (_event, ctx) => {
    runtime.clearPublishedReferences();
    handleSessionChange(ctx, "session_tree");
  });
  pi.on("session_shutdown", () => {
    runtime.clearPublishedReferences();
    shutdownSessionState();
  });

  if (webSearchEnabled) registerWebSearchTool(pi, runtime, toolNames, curateKey);
  if (sourceCheckEnabled) registerSourceCheckTool(pi, runtime, toolNames, getSearchContentEnabled);
  if (fetchContentEnabled) registerFetchContentTool(pi, toolNames, getSearchContentEnabled);
  if (getSearchContentEnabled) {
    registerGetSearchContentTool(
      pi,
      initConfig,
      toolNames,
      storedContentSources,
      searchQueryDescription,
    );
  }
  registerWebAccessCommands(pi, runtime, initConfig, toolNames);

  if (webSearchEnabled) confirmCanonicalSearchRegistration(getSearchScope(pi.events));
}
