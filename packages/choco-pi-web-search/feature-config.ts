import { getCachedWebSearchConfig, isConfigObject } from "./config-loader.ts";

export function isImageEnabled(): boolean {
  const image = getCachedWebSearchConfig().image;
  return !isConfigObject(image) || image.enabled !== false;
}
