import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isCodexTransportModel, isResponsesModel } from "./prompt/codex-model.ts";

type Model = ExtensionContext["model"];

export function supportsNativeWebSearch(model: Model): boolean {
  return isCodexTransportModel(model) && isResponsesModel(model);
}

export function supportsNativeImageGeneration(model: Model): boolean {
  const supportsImages = !Array.isArray(model?.input) || model.input.includes("image");
  return isCodexTransportModel(model) && isResponsesModel(model) && supportsImages;
}
