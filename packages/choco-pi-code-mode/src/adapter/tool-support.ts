import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Model = ExtensionContext["model"];

/** Whether the model accepts image inputs, so view_image can hand it the pixels. */
export function supportsViewImageInputs(model: Model): boolean {
  return Array.isArray(model?.input) && model.input.includes("image");
}
