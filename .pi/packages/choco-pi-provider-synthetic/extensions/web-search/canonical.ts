import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { registerSearchAdapter, type SearchScope } from "../../../choco-pi-web-search/index.ts";
import {
  SYNTHETIC_CONFIG_UPDATED_EVENT,
  SYNTHETIC_EXTENSIONS_REGISTER_EVENT,
  SYNTHETIC_EXTENSIONS_REQUEST_EVENT,
  SyntheticConfigUpdatedPayloadSchema,
} from "../../src/config-events.ts";
import { ensureSyntheticConfig, publishSyntheticConfig } from "../../src/config-state.ts";
import { createSyntheticSearchAdapter } from "./adapter.ts";

export default async function registerCanonicalSyntheticSearch(
  pi: ExtensionAPI,
  scope: SearchScope,
): Promise<void> {
  let config = await ensureSyntheticConfig();
  registerSearchAdapter(scope, createSyntheticSearchAdapter({ getConfig: () => config }));

  pi.events.on(SYNTHETIC_CONFIG_UPDATED_EVENT, (data) => {
    if (!Value.Check(SyntheticConfigUpdatedPayloadSchema, data)) return;
    config = data.config;
    publishSyntheticConfig(config);
  });

  pi.events.on(SYNTHETIC_EXTENSIONS_REQUEST_EVENT, () => {
    pi.events.emit(SYNTHETIC_EXTENSIONS_REGISTER_EVENT, {
      feature: "webSearch",
    });
  });
}
