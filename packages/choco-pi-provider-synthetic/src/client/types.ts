import { arr, compile, nullable, obj, opt, str, union, unknown } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";
import { finiteNum } from "../schema.ts";
import type { QuotasResponse } from "../types/quotas.ts";

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

export const SyntheticSearchResponseSchema = obj(
  {
    results: arr(obj({ url: str(), title: str(), text: str(), published: str() }, { open: true })),
  },
  { open: true },
);

export type SyntheticSearchResponse = Static<typeof SyntheticSearchResponseSchema>;
export type SyntheticSearchResult = SyntheticSearchResponse["results"][number];

export const SyntheticApiModelSchema = obj(
  {
    id: str(),
    name: str(),
    provider: opt(unknown()),
    hugging_face_id: opt(unknown()),
    input_modalities: arr(str()),
    output_modalities: arr(str()),
    context_length: finiteNum(),
    max_output_length: finiteNum(),
    pricing: obj(
      {
        prompt: str(),
        completion: str(),
        input_cache_reads: str(),
        input_cache_writes: str(),
      },
      { open: true },
    ),
    supported_features: opt(union([str(), arr(str())])),
    reasoning_parameters: opt(nullable(obj({ efforts: arr(unknown()) }, { open: true }))),
  },
  { open: true },
);

export type SyntheticApiModel = Static<typeof SyntheticApiModelSchema>;

export const SyntheticModelsResponseSchema = obj(
  { data: opt(nullable(arr(SyntheticApiModelSchema))) },
  { open: true },
);

export type SyntheticModelsResponse = Static<typeof SyntheticModelsResponseSchema>;

export const isSyntheticSearchResponse = compile(SyntheticSearchResponseSchema).check;
export const isSyntheticApiModel = compile(SyntheticApiModelSchema).check;
export const isSyntheticModelsResponse = compile(SyntheticModelsResponseSchema).check;

export interface SyntheticQuotasResponse {
  quotas: QuotasResponse;
}
