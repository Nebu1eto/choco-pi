import { lazyStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { antigravityOAuth } from "../../src/auth/oauth.ts";
import { FALLBACK_CATALOG, catalogToProviderModels } from "../../src/catalog/group.ts";
import { createAntigravityRefreshModels } from "../../src/catalog/refresh.ts";
import { registerAntigravityCompactionTokenCounter } from "../../src/compaction/token-counter.ts";
import { bindCompactionTokenCounter } from "@choco-pi/shared/compaction-token-counter-slot";
import { DEFAULT_ANTIGRAVITY_ENDPOINT, PROVIDER_ID, PROVIDER_NAME } from "../../src/config.ts";

export function googleAntigravityProviderConfig(): ProviderConfig {
  return {
    name: PROVIDER_NAME,
    baseUrl: DEFAULT_ANTIGRAVITY_ENDPOINT,
    api: "google-generative-ai",
    oauth: antigravityOAuth,
    models: catalogToProviderModels(FALLBACK_CATALOG),
    refreshModels: createAntigravityRefreshModels(),
    streamSimple: (model, context, options) =>
      lazyStream(
        model,
        async () => {
          const { streamGoogleAntigravity } = await import("../../src/stream/index.ts");
          return streamGoogleAntigravity(model, context, options);
        },
        undefined,
        options?.signal,
      ),
  };
}

export type RegisterProvider = (name: string, config: ProviderConfig) => void;

export function registerGoogleAntigravityProvider(register: RegisterProvider): void {
  register(PROVIDER_ID, googleAntigravityProviderConfig());
}

export default function googleAntigravityProvider(pi: ExtensionAPI): void {
  registerGoogleAntigravityProvider((name, config) => pi.registerProvider(name, config));
  bindCompactionTokenCounter(pi, registerAntigravityCompactionTokenCounter);
}
