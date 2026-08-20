import { type Static, Type } from "typebox";
import type { QuotasResponse } from "../types/quotas";

export interface SyntheticUtilityApiConfig {
  proxyUrl?: string;
  proxyRequiresAuth?: boolean;
}

export interface SyntheticClientOptions {
  apiKey?: string;
  proxyUrl?: string;
  requiresAuth?: boolean;
}

export interface SyntheticClientRequestOptions {
  signal?: AbortSignal;
}

export const SyntheticSearchResponseSchema = Type.Object({
  results: Type.Array(
    Type.Object({
      url: Type.String(),
      title: Type.String(),
      text: Type.String(),
      published: Type.String(),
    }),
  ),
});

export type SyntheticSearchResponse = Static<typeof SyntheticSearchResponseSchema>;
export type SyntheticSearchResult = SyntheticSearchResponse["results"][number];

export const SyntheticApiModelSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  provider: Type.Optional(Type.Unknown()),
  hugging_face_id: Type.Optional(Type.Unknown()),
  input_modalities: Type.Array(Type.String()),
  output_modalities: Type.Array(Type.String()),
  context_length: Type.Number(),
  max_output_length: Type.Number(),
  pricing: Type.Object({
    prompt: Type.String(),
    completion: Type.String(),
    input_cache_reads: Type.String(),
    input_cache_writes: Type.String(),
  }),
  supported_features: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
  reasoning_parameters: Type.Optional(
    Type.Union([
      Type.Null(),
      Type.Object({
        efforts: Type.Array(Type.Unknown()),
      }),
    ]),
  ),
});

export type SyntheticApiModel = Static<typeof SyntheticApiModelSchema>;

export const SyntheticModelsResponseSchema = Type.Object({
  data: Type.Optional(Type.Union([Type.Array(SyntheticApiModelSchema), Type.Null()])),
});

export type SyntheticModelsResponse = Static<typeof SyntheticModelsResponseSchema>;

export interface SyntheticQuotasResponse {
  quotas: QuotasResponse;
}
