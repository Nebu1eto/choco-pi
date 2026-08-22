import { getApiProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
  buildSyntheticProviderModels,
  buildSyntheticProviderModelsFromApi,
  buildSyntheticProviderModelsFromStore,
} from "./models.ts";
import { createSyntheticRefreshModels } from "./refresh-models.ts";

interface ProviderRuntime {
  activateSyntheticProvider(
    pi: ExtensionAPI,
    registerProvider: (pi: ExtensionAPI) => void,
  ): Promise<void>;
}

let runtimePromise: Promise<ProviderRuntime> | undefined;

function loadRuntime(): Promise<ProviderRuntime> {
  runtimePromise ??= import("./runtime.ts");
  return runtimePromise;
}

export function registerSyntheticProvider(pi: ExtensionAPI): void {
  const staticModels = buildSyntheticProviderModels();
  const config: ProviderConfig = {
    baseUrl: "https://api.synthetic.new/openai/v1",
    apiKey: "$SYNTHETIC_API_KEY",
    api: "openai-completions",
    headers: {
      Referer: "https://pi.dev",
      "X-Title": "@choco-pi/provider-synthetic",
    },
    models: staticModels,
    refreshModels: createSyntheticRefreshModels(
      staticModels,
      async (apiKey, signal) => {
        const { SyntheticClient } = await import("../../src/client/synthetic-client.ts");
        const client = new SyntheticClient({ apiKey });
        const result = await client.models({ signal });
        return result.data ?? [];
      },
      buildSyntheticProviderModelsFromApi,
      buildSyntheticProviderModelsFromStore,
    ),
  };

  const provider = getApiProvider("openai-completions");
  if (provider?.streamSimple) {
    config.streamSimple = provider.streamSimple;
  }

  pi.registerProvider("synthetic", config);
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const runtime = await loadRuntime();
  await runtime.activateSyntheticProvider(pi, registerSyntheticProvider);
}
