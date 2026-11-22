import { constants, createReadStream } from "node:fs";
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

export interface CandidateChoice {
  message: string;
  labels: string[];
}

export interface ResolveClientCredentialsOptions {
  env?: EnvLookup | undefined;
  /** Already-read config file; omitted reads `<agentDir>/google-antigravity.json`. */
  config?: AntigravityConfigFile | undefined;
  agentDir?: string | undefined;
  /**
   * Explicit opt-in for scanning the installed agy binary. Only login passes it; it must ask the
   * user and resolve true only on an explicit yes. Refresh never scans.
   */
  confirmAgyDiscovery?: (() => Promise<boolean>) | undefined;
  /** Picks one candidate when the binary holds several; resolves undefined to cancel. */
  chooseCandidate?: ((choice: CandidateChoice) => Promise<number | undefined>) | undefined;
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

/**
 * Streams a binary once and collects distinct OAuth client ids and secrets in file order. Reads
 * in chunks with an overlap so a value split across chunks is still found; nothing is logged.
 */
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

/** `CHOCO_PI_ANTIGRAVITY_AGY_PATH`, then config `agy_path`, then `agy` on PATH. */
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

function redactedSecretLabel(secret: string, index: number): string {
  return `secret candidate ${index + 1} (ends …${secret.slice(-4)})`;
}

async function pick(
  values: string[],
  message: string,
  label: (value: string, index: number) => string,
  choose: ResolveClientCredentialsOptions["chooseCandidate"],
): Promise<string> {
  const [only] = values;
  if (values.length === 1 && only !== undefined) return only;
  const index = choose ? await choose({ message, labels: values.map(label) }) : undefined;
  const chosen = index === undefined ? undefined : values[index];
  if (chosen === undefined) {
    throw new AntigravityConfigError(
      `agy holds ${values.length} candidates and none was chosen; set ${ENV_CLIENT_ID} and ${ENV_CLIENT_SECRET} instead`,
    );
  }
  return chosen;
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
  if (scan.clientIds.length === 0 || scan.clientSecrets.length === 0) {
    throw new AntigravityConfigError(`no OAuth client found in ${binary}`);
  }
  // Candidates keep file order. agy's Go string table groups literals by length, so neither an
  // id's distance to the redirect string nor a secret's distance to an id identifies the pair the
  // consumer login uses; no deterministic ranking rule exists, so the user chooses.
  const clientId = await pick(
    scan.clientIds,
    "agy contains several OAuth client ids. Choose the one to use:",
    (value) => value,
    options.chooseCandidate,
  );
  const clientSecret = await pick(
    scan.clientSecrets,
    "agy contains several OAuth client secrets. Choose the one to use:",
    redactedSecretLabel,
    options.chooseCandidate,
  );
  return { clientId, clientSecret, source: "agy" };
}

/**
 * Resolves the OAuth client in order: environment, config file, then (only after an explicit
 * opt-in) the installed agy binary. Resolves undefined when no source supplies one.
 */
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
  if (!options.confirmAgyDiscovery) return undefined;
  if (!(await options.confirmAgyDiscovery())) return undefined;
  return discoverFromAgy(options, env, config);
}
