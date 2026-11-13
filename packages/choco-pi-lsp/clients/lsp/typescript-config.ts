export interface TypeScriptInitializationConfig {
  [key: string]: string | number | boolean | null | TypeScriptInitializationConfig;
}

export interface TypeAcquisitionConfig {
  typeAcquisition?: { enabled?: boolean };
}

export function typeAcquisitionEnabledFromConfig(
  config: TypeAcquisitionConfig | undefined,
): boolean {
  return config?.typeAcquisition?.enabled === true;
}

/** Settings understood by native tsgo and classic typescript-language-server. */
export function defaultTypeScriptInitialization(
  typeAcquisitionEnabled: boolean,
): TypeScriptInitializationConfig | undefined {
  if (typeAcquisitionEnabled) return undefined;
  return {
    "js/ts": {
      tsserver: { automaticTypeAcquisition: { enabled: false } },
    },
    typescript: { disableAutomaticTypeAcquisition: true },
    disableAutomaticTypingAcquisition: true,
  };
}
