import { bool, compile, obj, oneOf, str } from "@earendil-works/pi-schema";

export const SYNTHETIC_EXTENSIONS_REQUEST_EVENT = "synthetic:extensions:request" as const;
export const SYNTHETIC_EXTENSIONS_REGISTER_EVENT = "synthetic:extensions:register" as const;
export const SYNTHETIC_CONFIG_UPDATED_EVENT = "synthetic:config:updated" as const;

const SyntheticFeatureIdSchema = oneOf([
  "webSearch",
  "quotasCommand",
  "subBarIntegration",
  "usageStatus",
  "quotaWarnings",
]);

const ResolvedSyntheticConfigSchema = obj(
  {
    configVersion: str(),
    webSearch: bool(),
    quotasCommand: bool(),
    usageStatus: bool(),
    quotaWarnings: bool(),
    subBarIntegration: bool(),
    proxyUrl: str(),
    proxyRequiresAuth: bool(),
  },
  { open: true },
);

export const SyntheticConfigUpdatedPayloadSchema = obj(
  { config: ResolvedSyntheticConfigSchema },
  { open: true },
);

export const SyntheticExtensionsRegisterPayloadSchema = obj(
  { feature: SyntheticFeatureIdSchema },
  { open: true },
);

export const isSyntheticConfigUpdatedPayload = compile(SyntheticConfigUpdatedPayloadSchema).check;

export const isSyntheticExtensionsRegisterPayload = compile(
  SyntheticExtensionsRegisterPayloadSchema,
).check;
