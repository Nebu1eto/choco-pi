import { existsSync, readFileSync } from "node:fs";
import { getWebSearchConfigPath } from "./utils.ts";

const CONFIG_PATH = getWebSearchConfigPath();

interface BrowserCookieConfig {
  allowBrowserCookies?: boolean;
}

type ConfigValue = null | boolean | number | string | ConfigValue[] | ConfigObject;
interface ConfigObject {
  [key: string]: ConfigValue | undefined;
}

function isConfigObject(value: ConfigValue): value is ConfigObject {
  return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}

let cachedConfig: BrowserCookieConfig | null = null;

function loadConfig(): BrowserCookieConfig {
  if (cachedConfig) return cachedConfig;
  if (!existsSync(CONFIG_PATH)) {
    cachedConfig = {};
    return cachedConfig;
  }

  const rawText = readFileSync(CONFIG_PATH, "utf-8");
  let raw: ConfigObject;
  try {
    // SAFETY: JSON.parse accepts only JSON syntax, whose runtime values are exactly ConfigValue.
    const parsed = JSON.parse(rawText) as ConfigValue;
    if (!isConfigObject(parsed)) throw new Error("expected a JSON object");
    raw = parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
  }

  cachedConfig = {
    allowBrowserCookies: raw.allowBrowserCookies === true,
  };
  return cachedConfig;
}

export function isBrowserCookieAccessAllowed(): boolean {
  if (
    process.env.PI_ALLOW_BROWSER_COOKIES === "1" ||
    process.env.FEYNMAN_ALLOW_BROWSER_COOKIES === "1"
  ) {
    return true;
  }
  return loadConfig().allowBrowserCookies === true;
}
