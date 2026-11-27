import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  bindSearchSession,
  confirmCanonicalSearchRegistration,
  getSearchScope,
  invalidateSearchSession,
  requestCanonicalSearchIntegration,
} from "./index.ts";
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
  shutdownSessionState,
  toggleActivityWidget,
} from "./search-runtime.ts";
import { registerWebSearchTool } from "./tools/web-search-tool.ts";
import { registerSourceCheckTool } from "./tools/source-check-tool.ts";
import { registerFetchContentTool } from "./tools/fetch-content-tool.ts";
import { registerGetSearchContentTool } from "./tools/get-search-content-tool.ts";
import { registerWebAccessCommands } from "./commands.ts";
import { registerWebSearchPreferencesProvider } from "./preferences-section.ts";

export { getSummaryGenerationDeadlineMs, type ProviderAvailability } from "./extension-config.ts";
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

export default async function unifiedWebSearch(pi: ExtensionAPI): Promise<void> {
  const scope = getSearchScope(pi.events);
  requestCanonicalSearchIntegration(scope);
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
  const activityKey = initConfig.shortcuts?.activity || DEFAULT_SHORTCUTS.activity;

  const runtime = createSearchRuntime(pi, toolNames);
  let active = true;
  const unregisterPreferences = registerWebSearchPreferencesProvider(scope, () => active);

  pi.registerShortcut(activityKey, {
    description: "Toggle web search activity",
    handler: async (ctx) => {
      toggleActivityWidget(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    active = true;
    bindSearchSession(scope, ctx.sessionManager);
    runtime.clearPublishedReferences();
    handleSessionChange(ctx, "session_start");
  });
  pi.on("session_tree", async (_event, ctx) => {
    active = true;
    bindSearchSession(scope, ctx.sessionManager);
    runtime.clearPublishedReferences();
    handleSessionChange(ctx, "session_tree");
  });
  pi.on("session_shutdown", (_event, ctx) => {
    active = false;
    unregisterPreferences?.();
    invalidateSearchSession(scope, ctx.sessionManager);
    runtime.clearPublishedReferences();
    shutdownSessionState();
  });

  if (webSearchEnabled) registerWebSearchTool(pi, runtime, toolNames, getSearchContentEnabled);
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
  registerWebAccessCommands(pi, initConfig);

  if (webSearchEnabled) confirmCanonicalSearchRegistration(scope);
}
