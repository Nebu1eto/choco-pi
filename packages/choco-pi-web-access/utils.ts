import { existsSync, readFileSync } from "node:fs";
import { isRecord } from "@choco-pi/shared/value-guards";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { legacyPiFallbacks, piAgentDir } from "@choco-pi/shared/pi-paths";

/**
 * Directory holding web-search.json: PI_CODING_AGENT_DIR, else (legacy mode
 * only) XDG_CONFIG_HOME/pi or ~/.pi. Standalone choco-pi falls back to its own
 * agent directory and never to XDG or ~/.pi.
 */
export function getWebSearchConfigDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  if (env.PI_CODING_AGENT_DIR) return env.PI_CODING_AGENT_DIR;
  const [legacyRoot] = legacyPiFallbacks(env, home);
  if (legacyRoot === undefined) return piAgentDir(env, home);
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "pi");
  return legacyRoot;
}

export function getWebSearchConfigPath(): string {
  return join(getWebSearchConfigDir(), "web-search.json");
}

type ConfigValue = null | boolean | number | string | ConfigValue[] | ConfigObject;
interface ConfigObject {
  [key: string]: ConfigValue | undefined;
}

interface ApiBaseUrlOptions {
  configKey: string;
  configuredValue: unknown;
  defaultValue: string;
  environmentKey: string;
  environmentValue: string | undefined;
}

function isString(value: ConfigValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

export function resolveApiBaseUrl(options: ApiBaseUrlOptions): string {
  const fromEnvironment = options.environmentValue !== undefined;
  const value = fromEnvironment ? options.environmentValue : options.configuredValue;
  if (value === undefined) return options.defaultValue;

  const source = fromEnvironment
    ? options.environmentKey
    : `${options.configKey} in ${getWebSearchConfigPath()}`;
  const stringValue =
    Object.prototype.toString.call(value) === "[object String]" && Object(value) !== value
      ? String(value)
      : "";
  if (stringValue.trim().length === 0) {
    throw new Error(`${source} must be an absolute HTTP(S) URL`);
  }

  let url: URL;
  try {
    url = new URL(stringValue.trim());
  } catch {
    throw new Error(`${source} must be an absolute HTTP(S) URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${source} must be an absolute HTTPS URL`);
  }
  if (url.username || url.password) {
    throw new Error(`${source} must not include credentials`);
  }
  if (url.search || url.hash) {
    throw new Error(`${source} must not include query parameters or fragments`);
  }

  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}

const API_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const API_REQUEST_BODY_HEADERS = [
  "Content-Encoding",
  "Content-Language",
  "Content-Location",
  "Content-Type",
];
const MAX_API_REDIRECTS = 5;

export async function fetchWithCredentialRedirects(
  url: string,
  init: RequestInit,
  credentialHeaders: readonly string[],
): Promise<Response> {
  let current = new URL(url);
  let requestInit = init;

  for (let redirects = 0; ; redirects++) {
    const response = await fetch(current, { ...requestInit, redirect: "manual" });
    if (!API_REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    if (redirects === MAX_API_REDIRECTS) {
      throw new Error(`Too many API redirects from ${url}`);
    }

    const next = new URL(location, current);
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new Error(`API redirect from ${current.origin} must use HTTP(S)`);
    }
    const method = requestInit.method?.toUpperCase() ?? "GET";
    if (
      ((response.status === 301 || response.status === 302) && method === "POST") ||
      (response.status === 303 && method !== "GET" && method !== "HEAD")
    ) {
      const headers = new Headers(requestInit.headers);
      for (const name of API_REQUEST_BODY_HEADERS) headers.delete(name);
      const { body: _body, ...withoutBody } = requestInit;
      requestInit = { ...withoutBody, method: "GET", headers };
    }
    if (next.origin !== current.origin) {
      const headers = new Headers(requestInit.headers);
      for (const name of credentialHeaders) headers.delete(name);
      requestInit = { ...requestInit, headers };
    }
    current = next;
  }
}

export interface CuratorNetworkConfig {
  /** Whether remote access was opted into via curatorRemote. */
  enabled: boolean;
  host: string;
  bind: string;
}

const LOCAL_CURATOR_NETWORK_DEFAULTS: CuratorNetworkConfig = {
  enabled: false,
  host: "localhost",
  bind: "127.0.0.1",
};

function trimmedString(value: ConfigValue | undefined): string | undefined {
  if (!isString(value)) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Resolves the curator server bind address and URL host from `curatorRemote`. */
export function resolveCuratorNetworkConfig(): CuratorNetworkConfig {
  const configPath = getWebSearchConfigPath();
  if (!existsSync(configPath)) return LOCAL_CURATOR_NETWORK_DEFAULTS;

  let raw: ConfigValue;
  try {
    // SAFETY: JSON.parse accepts only JSON syntax, whose runtime values are exactly ConfigValue.
    raw = JSON.parse(readFileSync(configPath, "utf-8")) as ConfigValue;
  } catch {
    return LOCAL_CURATOR_NETWORK_DEFAULTS;
  }
  if (!isRecord(raw)) return LOCAL_CURATOR_NETWORK_DEFAULTS;

  const curatorRemote = raw.curatorRemote;
  if (curatorRemote === true) return { enabled: true, host: hostname(), bind: "0.0.0.0" };

  if (curatorRemote !== undefined && isRecord(curatorRemote)) {
    return {
      enabled: true,
      host: trimmedString(curatorRemote.host) ?? hostname(),
      bind: trimmedString(curatorRemote.bind) ?? "0.0.0.0",
    };
  }

  return LOCAL_CURATOR_NETWORK_DEFAULTS;
}
