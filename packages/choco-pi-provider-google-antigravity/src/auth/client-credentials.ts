import { constants, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import {
  AntigravityConfigError,
  ENV_AGY_PATH,
  ENV_CLIENT_ID,
  ENV_CLIENT_SECRET,
  readAntigravityConfig,
  type AntigravityConfigFile,
} from "../config.ts";

export type ClientCredentialSource = "env" | "config" | "agy";

export interface AntigravityClientCredentials {
  clientId: string;
  clientSecret: string;
  source: ClientCredentialSource;
}

export type EnvLookup = Readonly<Record<string, string | undefined>>;

export interface AgyScanResult {
  clientIds: string[];
  clientSecrets: string[];
}

export interface ClientFingerprint {
  clientIdSha256: string;
  clientSecretSha256: string;
}

export const AGY_CONSUMER_CLIENT: ClientFingerprint = {
  clientIdSha256: "bf00c418024ba6bf606ccdc37120976e41bc429dd1d46ecf16a729aa532626ea",
  clientSecretSha256: "1d2f041093fd95aa8995a038c711d50a7960da09a505381c09a745d6ad0ecc60",
};

export interface ResolveClientCredentialsOptions {
  env?: EnvLookup | undefined;
  config?: AntigravityConfigFile | undefined;
  agentDir?: string | undefined;
  discoverFromAgy?: boolean | undefined;
  agyClient?: ClientFingerprint | undefined;
  findAgyBinary?:
    | ((env: EnvLookup, config: AntigravityConfigFile | undefined) => Promise<string | undefined>)
    | undefined;
  scanAgyBinary?: ((file: string, signal?: AbortSignal) => Promise<AgyScanResult>) | undefined;
  signal?: AbortSignal | undefined;
}

function pairFrom(
  id: string | undefined,
  secret: string | undefined,
  where: string,
): { clientId: string; clientSecret: string } | undefined {
  const clientId = id?.trim();
  const clientSecret = secret?.trim();
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) {
    throw new AntigravityConfigError(`${where} must set both the OAuth client id and secret`);
  }
  return { clientId, clientSecret };
}

const CLIENT_ID_PATTERN = /[0-9]{6,}-[a-z0-9]{32}\.apps\.googleusercontent\.com/gu;
const CLIENT_SECRET_PATTERN = /GOCSPX-[A-Za-z0-9_-]{28}/gu;
const SCAN_OVERLAP = 256;

export async function scanAgyBinary(file: string, signal?: AbortSignal): Promise<AgyScanResult> {
  const clientIds = new Set<string>();
  const clientSecrets = new Set<string>();
  let carry = "";
  const stream = createReadStream(file, { highWaterMark: 1 << 20, signal });
  for await (const chunk of stream) {
    const text = carry + (Buffer.isBuffer(chunk) ? chunk.toString("latin1") : String(chunk));
    for (const match of text.matchAll(CLIENT_ID_PATTERN)) clientIds.add(match[0]);
    for (const match of text.matchAll(CLIENT_SECRET_PATTERN)) clientSecrets.add(match[0]);
    carry = text.slice(-SCAN_OVERLAP);
  }
  return { clientIds: [...clientIds], clientSecrets: [...clientSecrets] };
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findAgyBinary(
  env: EnvLookup,
  config: AntigravityConfigFile | undefined,
): Promise<string | undefined> {
  const explicit = env[ENV_AGY_PATH]?.trim() || config?.agy_path;
  if (explicit) return (await isExecutable(explicit)) ? explicit : undefined;
  const names = process.platform === "win32" ? ["agy.exe", "agy.cmd"] : ["agy"];
  for (const dir of (env["PATH"] ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function discoverFromAgy(
  options: ResolveClientCredentialsOptions,
  env: EnvLookup,
  config: AntigravityConfigFile | undefined,
): Promise<AntigravityClientCredentials> {
  const binary = await (options.findAgyBinary ?? findAgyBinary)(env, config);
  if (!binary) {
    throw new AntigravityConfigError(
      `agy was not found on PATH; install it, set ${ENV_AGY_PATH}, or set ${ENV_CLIENT_ID} and ${ENV_CLIENT_SECRET}`,
    );
  }
  const scan = await (options.scanAgyBinary ?? scanAgyBinary)(binary, options.signal);
  const wanted = options.agyClient ?? AGY_CONSUMER_CLIENT;
  const clientId = scan.clientIds.find((value) => sha256(value) === wanted.clientIdSha256);
  const clientSecret = scan.clientSecrets.find(
    (value) => sha256(value) === wanted.clientSecretSha256,
  );
  if (clientId === undefined || clientSecret === undefined) {
    throw new AntigravityConfigError(
      `${binary} does not hold the agy consumer OAuth client this choco-pi knows; update choco-pi, or set ${ENV_CLIENT_ID} and ${ENV_CLIENT_SECRET}`,
    );
  }
  return { clientId, clientSecret, source: "agy" };
}

export async function resolveClientCredentials(
  options: ResolveClientCredentialsOptions = {},
): Promise<AntigravityClientCredentials | undefined> {
  const env = options.env ?? process.env;
  const fromEnv = pairFrom(
    env[ENV_CLIENT_ID],
    env[ENV_CLIENT_SECRET],
    `${ENV_CLIENT_ID}/${ENV_CLIENT_SECRET}`,
  );
  if (fromEnv) return { ...fromEnv, source: "env" };
  const config =
    options.config ??
    (options.agentDir === undefined ? undefined : await readAntigravityConfig(options.agentDir));
  const fromConfig = pairFrom(config?.client_id, config?.client_secret, "google-antigravity.json");
  if (fromConfig) return { ...fromConfig, source: "config" };
  if (options.discoverFromAgy !== true) return undefined;
  return discoverFromAgy(options, env, config);
}
