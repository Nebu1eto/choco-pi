import { readFile } from "node:fs/promises";
import path from "node:path";
import { compile, obj, opt, str } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

export const PROVIDER_ID = "google";
export const PROVIDER_NAME = "Google";
export const OAUTH_LOGIN_NAME = "Google Antigravity";
export const SIGN_IN_HINT = "run /login google and choose Google Antigravity";

export const AGY_CLIENT_IDENTITY = { version: "1.5.14", build: "1026970498" } as const;

export const DEFAULT_ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";

export const ANTIGRAVITY_ENDPOINTS: readonly string[] = [
  DEFAULT_ANTIGRAVITY_ENDPOINT,
  "https://cloudcode-pa.googleapis.com",
];

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
export const OAUTH_REDIRECT_URI = "https://antigravity.google/oauth-callback";

export const OAUTH_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
  "https://www.googleapis.com/auth/aicode",
  "openid",
];

export const ENV_CLIENT_ID = "CHOCO_PI_ANTIGRAVITY_CLIENT_ID";
export const ENV_CLIENT_SECRET = "CHOCO_PI_ANTIGRAVITY_CLIENT_SECRET";
export const ENV_AGY_PATH = "CHOCO_PI_ANTIGRAVITY_AGY_PATH";
export const CONFIG_FILE_NAME = "google-antigravity.json";

function osType(platform: string): string {
  return platform === "win32" ? "windows" : platform;
}

function archName(arch: string): string {
  if (arch === "x64") return "amd64";
  if (arch === "ia32") return "386";
  return arch;
}

export function buildAntigravityUserAgent(
  host: { platform: string; arch: string } = { platform: process.platform, arch: process.arch },
): string {
  return `antigravity/cli/${AGY_CLIENT_IDENTITY.version} (aidev_client; os_type=${osType(host.platform)}; arch=${archName(host.arch)}; cl=${AGY_CLIENT_IDENTITY.build}; auth_method=consumer)`;
}

const ConfigFileSchema = obj({
  client_id: opt(str({ minLength: 1 })),
  client_secret: opt(str({ minLength: 1 })),
  project_id: opt(str({ minLength: 1 })),
  agy_path: opt(str({ minLength: 1 })),
});
const isConfigFile = compile(ConfigFileSchema).check;
const isErrnoLike = compile(obj({ code: str() }, { open: true })).check;

export type AntigravityConfigFile = Static<typeof ConfigFileSchema>;

export class AntigravityConfigError extends Error {
  override readonly name = "AntigravityConfigError";
}

export type ReadTextFile = (file: string) => Promise<string>;

export function errorCode(cause: unknown): string | undefined {
  return isErrnoLike(cause) ? cause.code : undefined;
}

export function antigravityConfigPath(agentDir: string): string {
  return path.join(agentDir, CONFIG_FILE_NAME);
}

export async function readAntigravityConfig(
  agentDir: string,
  read: ReadTextFile = (file) => readFile(file, "utf8"),
): Promise<AntigravityConfigFile | undefined> {
  const file = antigravityConfigPath(agentDir);
  let text: string;
  try {
    text = await read(file);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new AntigravityConfigError(`Cannot read ${file}`, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AntigravityConfigError(`${file} is not valid JSON`);
  }
  if (!isConfigFile(value)) {
    throw new AntigravityConfigError(
      `${file} must be an object with only client_id, client_secret, project_id and agy_path string keys`,
    );
  }
  return value;
}

export async function defaultAgentDir(): Promise<string> {
  const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
  return getAgentDir();
}
