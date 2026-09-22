import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  SYNTHETIC_CONFIG_UPDATED_EVENT,
  SYNTHETIC_EXTENSIONS_REGISTER_EVENT,
  SYNTHETIC_EXTENSIONS_REQUEST_EVENT,
  SyntheticConfigUpdatedPayloadSchema,
} from "../../src/config-events.ts";
import { ensureSyntheticConfig, publishSyntheticConfig } from "../../src/config-state.ts";
import { detectBillingMode } from "../../src/utils/quotas.ts";
import {
  shouldActivateWebSearch,
  syncToolActivation,
  type WebSearchEntitlement,
} from "./activation.ts";
import { registerSyntheticWebSearchTool } from "./tool.ts";
import { hasCanonicalSearch } from "../../../choco-pi-web-search/index.ts";

export default async function (pi: ExtensionAPI) {
  let config = await ensureSyntheticConfig();
  let entitlement: WebSearchEntitlement = "unknown";
  let getApiKey: (() => Promise<string | undefined>) | undefined;
  let quotaCheckId = 0;
  let quotaCheckController: AbortController | undefined;

  registerSyntheticWebSearchTool(pi);

  function syncActivation(): void {
    syncToolActivation(pi, shouldActivateWebSearch(config.webSearch, entitlement));
  }

  function cancelQuotaCheck(): void {
    quotaCheckId++;
    quotaCheckController?.abort();
    quotaCheckController = undefined;
  }

  function refreshEntitlement(): void {
    cancelQuotaCheck();
    const checkId = quotaCheckId;
    const controller = new AbortController();
    quotaCheckController = controller;

    void (async () => {
      try {
        const [{ resolveSyntheticClientOptions }, { SyntheticClient }] = await Promise.all([
          import("../../src/client/utility-api.ts"),
          import("../../src/client/synthetic-client.ts"),
        ]);
        const options = await resolveSyntheticClientOptions(config, () =>
          getApiKey ? getApiKey() : Promise.resolve(undefined),
        );
        if (!options || checkId !== quotaCheckId) return;

        const result = await new SyntheticClient(options).quotas({
          signal: controller.signal,
        });
        if (checkId !== quotaCheckId || !result.success) return;

        entitlement =
          detectBillingMode(result.data.quotas) === "subscription"
            ? "subscription"
            : "pay-as-you-go";
        syncActivation();
      } catch (error) {
        // Keep the tool inactive until a successful quota response proves
        // subscription eligibility.
        void error;
      }
    })();
  }

  pi.on("session_start", async (_event, ctx) => {
    cancelQuotaCheck();
    entitlement = "unknown";
    if (hasCanonicalSearch(pi.events)) {
      getApiKey = undefined;
      syncActivation();
      return;
    }
    getApiKey = () => ctx.modelRegistry.getApiKeyForProvider("synthetic");
    syncActivation();
    refreshEntitlement();
  });

  pi.events.on(SYNTHETIC_CONFIG_UPDATED_EVENT, (data) => {
    if (!Value.Check(SyntheticConfigUpdatedPayloadSchema, data)) return;
    const nextConfig = data.config;
    const connectionChanged =
      nextConfig.proxyUrl !== config.proxyUrl ||
      nextConfig.proxyRequiresAuth !== config.proxyRequiresAuth;
    const becameEnabled = !config.webSearch && nextConfig.webSearch;

    config = nextConfig;
    publishSyntheticConfig(nextConfig);

    if (hasCanonicalSearch(pi.events)) {
      cancelQuotaCheck();
      entitlement = "unknown";
      getApiKey = undefined;
      syncActivation();
      return;
    }

    if (connectionChanged || (becameEnabled && entitlement === "unknown")) {
      entitlement = "unknown";
      syncActivation();
      refreshEntitlement();
      return;
    }

    syncActivation();
  });

  pi.on("session_before_switch", () => {
    cancelQuotaCheck();
    getApiKey = undefined;
  });

  pi.on("session_shutdown", () => {
    cancelQuotaCheck();
    getApiKey = undefined;
  });

  pi.events.on(SYNTHETIC_EXTENSIONS_REQUEST_EVENT, () => {
    pi.events.emit(SYNTHETIC_EXTENSIONS_REGISTER_EVENT, {
      feature: "webSearch",
    });
  });
}
