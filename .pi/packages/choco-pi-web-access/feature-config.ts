import { existsSync, readFileSync } from "node:fs";
import { getWebSearchConfigPath } from "./utils.ts";

const CONFIG_PATH = getWebSearchConfigPath();

type ConfigValue = null | boolean | number | string | ConfigValue[] | ConfigObject;
interface ConfigObject {
  [key: string]: ConfigValue | undefined;
}
interface FeatureConfig {
  image?: ConfigObject;
}

function isConfigObject(value: ConfigValue | undefined): value is ConfigObject {
  return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}

function loadFeatureConfig(): FeatureConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    // SAFETY: JSON.parse accepts only JSON syntax, whose runtime values are exactly ConfigValue.
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as ConfigValue;
    if (!isConfigObject(raw)) return {};
    const image = raw.image;
    return isConfigObject(image) ? { image } : {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
  }
}

export function isImageEnabled(): boolean {
  return loadFeatureConfig().image?.enabled !== false;
}
