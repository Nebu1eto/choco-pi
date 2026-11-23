import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { errorCode, isRecord } from "@choco-pi/shared/value-guards";
import { getWebSearchConfigPath } from "./utils.ts";

export type ConfigValue = null | boolean | number | string | ConfigValue[] | ConfigObject;
export interface ConfigObject {
  [key: string]: ConfigValue | undefined;
}

export function isConfigObject<Value>(value: Value): value is Value & ConfigObject {
  return isRecord(value);
}

export interface ConfigReadResult {
  config: ConfigObject;
  error?: Error;
}

async function readConfigFile(configPath: string): Promise<ConfigReadResult> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return { config: {} };
    const message = err instanceof Error ? err.message : String(err);
    return {
      config: {},
      error: new Error(`Failed to read ${configPath}: ${message}`),
    };
  }
  try {
    // SAFETY: JSON.parse returns only valid JSON values (ConfigValue).
    const parsed = JSON.parse(raw) as ConfigValue;
    if (!isConfigObject(parsed)) {
      throw new Error("expected a JSON object");
    }
    return { config: parsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      config: {},
      error: new Error(`Failed to parse ${configPath}: ${message}`),
    };
  }
}

const INITIAL_CONFIG_PATH = getWebSearchConfigPath();
let cachedPath = INITIAL_CONFIG_PATH;
let cachedResult: ConfigReadResult = await readConfigFile(INITIAL_CONFIG_PATH);
let inflightLoad: Promise<ConfigReadResult> | null = null;

/**
 * Returns the asynchronously preloaded config snapshot synchronously for legacy sync callers.
 * Throws if the config file failed to read or parse.
 */
export function getCachedWebSearchConfig(): ConfigObject {
  if (cachedResult.error) throw cachedResult.error;
  return cachedResult.config;
}

/** Loads `web-search.json` asynchronously using non-blocking `node:fs/promises`. */
export async function loadWebSearchConfig(options?: {
  fresh?: boolean;
  configPath?: string;
}): Promise<ConfigObject> {
  const targetPath = options?.configPath ?? getWebSearchConfigPath();
  if (!options?.fresh && targetPath === cachedPath) {
    return getCachedWebSearchConfig();
  }
  if (options?.fresh || targetPath !== cachedPath || !inflightLoad) {
    inflightLoad = readConfigFile(targetPath).then((result) => {
      if (targetPath === getWebSearchConfigPath()) {
        cachedPath = targetPath;
        cachedResult = result;
      }
      inflightLoad = null;
      return result;
    });
  }
  const result = await inflightLoad;
  if (result.error) throw result.error;
  return result.config;
}

/**
 * Reads `web-search.json` from disk without consulting or updating the process cache.
 * A missing file is an empty config; any other read or parse failure rejects.
 */
export async function readWebSearchConfigStrict(configPath?: string): Promise<ConfigObject> {
  const result = await readConfigFile(configPath ?? getWebSearchConfigPath());
  if (result.error) throw result.error;
  return result.config;
}

let saveQueue: Promise<void> = Promise.resolve();

async function persistConfigPatch(patch: ConfigObject): Promise<ConfigObject> {
  const targetPath = getWebSearchConfigPath();
  // Strict read: an unreadable or malformed file must never be replaced by the patch alone.
  const current = await readWebSearchConfigStrict(targetPath);
  const next: ConfigObject = { ...current, ...patch };
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, JSON.stringify(next, null, 2) + "\n", "utf-8");
  if (targetPath === getWebSearchConfigPath()) {
    cachedPath = targetPath;
    cachedResult = { config: next };
  }
  return next;
}

/**
 * Persists a partial update to `web-search.json` asynchronously and refreshes the in-memory cache.
 * Saves are serialized so concurrent read-modify-write cycles cannot drop each other's keys.
 * Rejects without touching the file when the existing config cannot be read or parsed.
 */
export function saveWebSearchConfig(patch: ConfigObject): Promise<ConfigObject> {
  const run = saveQueue.then(() => persistConfigPatch(patch));
  saveQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
