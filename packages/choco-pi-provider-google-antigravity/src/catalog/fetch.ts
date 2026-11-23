import { arr, bool, compile, map, num, obj, opt, str } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";
import { postV1Internal, type FetchLike } from "../client/http.ts";

const ModelDetailsSchema = obj(
  {
    displayName: opt(str()),
    supportsImages: opt(bool()),
    supportsThinking: opt(bool()),
    thinkingBudget: opt(num()),
    minThinkingBudget: opt(num()),
    recommended: opt(bool()),
    maxTokens: opt(num({ minimum: 0 })),
    maxOutputTokens: opt(num({ minimum: 0 })),
    model: opt(str()),
    apiProvider: opt(str()),
    modelProvider: opt(str()),
    thinkingLevel: opt(num()),
    isInternal: opt(bool()),
    disabled: opt(bool()),
    quotaInfo: opt(obj({ remainingFraction: opt(num()), resetTime: opt(str()) }, { open: true })),
  },
  { open: true },
);

const ThinkingLevelEntrySchema = obj(
  { thinkingSuffix: opt(str()), thinkingDisplayName: opt(str()) },
  { open: true },
);

export const FetchAvailableModelsResponseSchema = obj(
  {
    models: map(ModelDetailsSchema),
    defaultAgentModelId: opt(str()),
    agentModelSorts: opt(
      arr(
        obj(
          {
            displayName: opt(str()),
            groups: opt(arr(obj({ modelIds: opt(arr(str())) }, { open: true }))),
          },
          { open: true },
        ),
      ),
    ),
    commandModelIds: opt(arr(str())),
    imageGenerationModelIds: opt(arr(str())),
    mqueryModelIds: opt(arr(str())),
    webSearchModelIds: opt(arr(str())),
    commitMessageModelIds: opt(arr(str())),
    tieredModelIds: opt(map(arr(str()))),
    groupedModels: opt(
      map(
        obj(
          {
            displayName: opt(str()),
            supportedThinkingLevels: opt(arr(ThinkingLevelEntrySchema)),
            defaultThinkingSuffix: opt(str()),
          },
          { open: true },
        ),
      ),
    ),
  },
  { open: true },
);
export type FetchAvailableModelsResponse = Static<typeof FetchAvailableModelsResponseSchema>;
export type AntigravityModelDetails = Static<typeof ModelDetailsSchema>;
export const fetchAvailableModelsValidator = compile(FetchAvailableModelsResponseSchema);

export interface FetchAvailableModelsOptions {
  token: string;
  projectId: string;
  signal?: AbortSignal | undefined;
  fetch?: FetchLike | undefined;
  endpoints?: readonly string[] | undefined;
  timeoutMs?: number | undefined;
}

export function fetchAvailableModels(
  options: FetchAvailableModelsOptions,
): Promise<FetchAvailableModelsResponse> {
  return postV1Internal(
    "fetchAvailableModels",
    { project: options.projectId },
    {
      token: options.token,
      validator: fetchAvailableModelsValidator,
      signal: options.signal,
      fetch: options.fetch,
      endpoints: options.endpoints,
      timeoutMs: options.timeoutMs,
    },
  );
}
