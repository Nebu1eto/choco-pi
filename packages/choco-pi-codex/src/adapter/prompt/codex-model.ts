// Model and context detection lives in @choco-pi/shared so profile extensions
// and this package share one implementation. ModelContextLike is structurally
// assignable from Pick<ExtensionContext, "model">.
export {
  canonicalCodexAliasModelKey,
  isCanonicalCodexAliasModel,
  isCanonicalCodexBaseUrl,
  isCanonicalCodexSubscriptionContext,
  isCanonicalCodexSubscriptionModel,
  isCodexLikeModel,
  isCodexTransportContext,
  isCodexTransportModel,
  isOpenAICodexContext,
  isOpenAICodexModel,
  isOpenAIResponsesContext,
  isResponsesContext,
  isResponsesModel,
} from "@choco-pi/shared/codex-model";
export type { CodexLikeModelDescriptor, ModelContextLike } from "@choco-pi/shared/codex-model";
