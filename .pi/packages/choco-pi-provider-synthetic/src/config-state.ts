import type { ResolvedSyntheticConfig } from "./config.ts";

const SYNTHETIC_CONFIG_STATE_KEY = Symbol.for("choco-pi.provider-synthetic.config-state");

type SyntheticConfigRegistry = {
  [key: symbol]: ResolvedSyntheticConfig | undefined;
};

// SAFETY: This module exclusively owns the fixed symbol slot and writes only ResolvedSyntheticConfig values.
const registry = globalThis as SyntheticConfigRegistry;
let loadingPromise: Promise<ResolvedSyntheticConfig> | undefined;

export function getSyntheticConfigState(): ResolvedSyntheticConfig | undefined {
  return registry[SYNTHETIC_CONFIG_STATE_KEY];
}

export function publishSyntheticConfig(config: ResolvedSyntheticConfig): void {
  registry[SYNTHETIC_CONFIG_STATE_KEY] = config;
}

export async function ensureSyntheticConfig(): Promise<ResolvedSyntheticConfig> {
  const current = getSyntheticConfigState();
  if (current) return current;

  loadingPromise ??= (async () => {
    const { configLoader } = await import("./config.ts");
    await configLoader.load();
    const config = configLoader.getConfig();
    publishSyntheticConfig(config);
    return config;
  })();

  return loadingPromise;
}
