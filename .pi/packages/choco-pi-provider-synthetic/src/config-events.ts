import { Type } from "typebox";

export const SYNTHETIC_EXTENSIONS_REQUEST_EVENT = "synthetic:extensions:request" as const;
export const SYNTHETIC_EXTENSIONS_REGISTER_EVENT = "synthetic:extensions:register" as const;
export const SYNTHETIC_CONFIG_UPDATED_EVENT = "synthetic:config:updated" as const;

const SyntheticFeatureIdSchema = Type.Union([
  Type.Literal("webSearch"),
  Type.Literal("quotasCommand"),
  Type.Literal("subBarIntegration"),
  Type.Literal("usageStatus"),
  Type.Literal("quotaWarnings"),
]);

const ResolvedSyntheticConfigSchema = Type.Object({
  configVersion: Type.String(),
  webSearch: Type.Boolean(),
  quotasCommand: Type.Boolean(),
  usageStatus: Type.Boolean(),
  quotaWarnings: Type.Boolean(),
  subBarIntegration: Type.Boolean(),
  proxyUrl: Type.String(),
  proxyRequiresAuth: Type.Boolean(),
});

export const SyntheticConfigUpdatedPayloadSchema = Type.Object({
  config: ResolvedSyntheticConfigSchema,
});

export const SyntheticExtensionsRegisterPayloadSchema = Type.Object({
  feature: SyntheticFeatureIdSchema,
});
