import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  createModelSummarizer,
  createTextBackend,
  TEXT_BACKEND_ID,
} from "../../../.pi/packages/choco-pi-compaction/src/background/text-backend.ts";
import {
  getRegistry,
  registerBackendFactory,
} from "../../../.pi/packages/choco-pi-compaction/src/background/registry.ts";
import { digest, type Recorder } from "./artifacts.ts";
export interface SummaryOwner {
  ownerKey: string;
  ownerGeneration: number;
}
export const summaryOwner = new AsyncLocalStorage<SummaryOwner>();
/** Inject ownership/observation around the production summarizer, not a prepared result. */
export function installTextFakeFactory(
  recorder: Recorder,
  modelRegistry: ModelRegistry,
): () => void {
  const registry = getRegistry();
  if (registry.backendFactories.has(TEXT_BACKEND_ID))
    throw new Error("Text factory already registered before harness injection");
  const factory = registerBackendFactory(TEXT_BACKEND_ID, (context) =>
    observedTextBackend(recorder, modelRegistry, context),
  );
  return () => {
    if (registry.backendFactories.get(TEXT_BACKEND_ID) === factory)
      registry.backendFactories.delete(TEXT_BACKEND_ID);
  };
}

type BackendFactoryContext = Parameters<Parameters<typeof registerBackendFactory>[1]>[0];
type ModelSummarizer = ReturnType<typeof createModelSummarizer>;

/** The production text backend over the production summarizer, run under its owner. */
function observedTextBackend(
  recorder: Recorder,
  modelRegistry: ModelRegistry,
  context: BackendFactoryContext,
) {
  const model = modelRegistry.find(context.providerScope.provider, context.providerScope.model);
  if (!model) throw new Error("Text factory's session model unavailable");
  const delegate = createModelSummarizer({
    modelRegistry,
    model,
    thinkingLevel: "off",
    retry: undefined,
  });
  const owner = { ownerKey: context.ownerKey, ownerGeneration: context.ownerGeneration };
  return createTextBackend({
    summarize: ownedSummarizer(delegate, owner),
    budget: { contextWindow: model.contextWindow, maxTokens: model.maxTokens },
    onPromptInput(input) {
      recorder.record("text-prompt-input", {
        ...owner,
        pass: input.pass,
        entryIds: [...input.entryIds],
        systemDigest: digest(input.systemPrompt),
        promptDigest: digest(input.promptText),
      });
    },
  });
}

/** Runs each summary inside `summaryOwner` so the provider can attribute it. */
function ownedSummarizer(delegate: ModelSummarizer, owner: SummaryOwner): ModelSummarizer {
  return {
    scope: delegate.scope,
    summarize: (request) => summaryOwner.run(owner, () => delegate.summarize(request)),
  };
}
