import { createHash, randomBytes } from "node:crypto";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { compile, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";
import type { FetchLike } from "../client/http.ts";
import {
  AGY_CLIENT_IDENTITY,
  ENV_CLIENT_ID,
  ENV_CLIENT_SECRET,
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  OAUTH_REDIRECT_URI,
  OAUTH_SCOPES,
  OAUTH_LOGIN_NAME,
  SIGN_IN_HINT,
  defaultAgentDir,
  readAntigravityConfig,
  type ReadTextFile,
} from "../config.ts";
import { AntigravityError, antigravityNetworkError, sanitizeBackendMessage } from "../errors.ts";
import {
  resolveClientCredentials,
  type AgyScanResult,
  type AntigravityClientCredentials,
  type EnvLookup,
  type ResolveClientCredentialsOptions,
} from "./client-credentials.ts";
import { discoverAntigravityProject, type AntigravityProjectInfo } from "./project.ts";

export type AntigravityOAuthConfig = NonNullable<ProviderConfig["oauth"]>;

/**
 * Shown before any network request; login continues only on an explicit "accept". One line with
 * no hard breaks, so the host wraps it to the terminal width.
 */
export const ANTIGRAVITY_TERMS_WARNING = [
  "Warning: Google's Antigravity terms restrict third-party clients on consumer (personal Google account) OAuth access, and Google has suspended accounts used this way.",
  "choco-pi is a third-party client.",
  `For compatibility it identifies itself with the official agy CLI's user agent (version ${AGY_CLIENT_IDENTITY.version}) and request format.`,
  "Continue only if you accept the risk to your Google account.",
].join(" ");

const ACCEPT_TERMS = "accept";
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
const TOKEN_TIMEOUT_MS = 30_000;
const USERINFO_TIMEOUT_MS = 30_000;
const AUTH_INSTRUCTIONS =
  "Sign in with Google in the browser. After you allow access, the Antigravity page (antigravity.google) shows an authorization code: copy it and paste it here.";
const CODE_PROMPT = "Paste the authorization code shown on the Antigravity page:";

const TokenResponseSchema = obj(
  {
    access_token: str({ minLength: 1 }),
    expires_in: num({ minimum: 0 }),
    refresh_token: opt(str({ minLength: 1 })),
    scope: opt(str()),
    token_type: opt(str()),
  },
  { open: true },
);
const isTokenResponse = compile(TokenResponseSchema).check;
type TokenResponse = Static<typeof TokenResponseSchema>;
const isTokenError = compile(
  obj({ error: str(), error_description: opt(str()) }, { open: true }),
).check;

const EMAIL = { minLength: 3, maxLength: 320, pattern: "^[^\\s@]+@[^\\s@]+$" };
/** The one userinfo field this provider keeps: the account email, the stable account identity. */
const isUserInfo = compile(obj({ email: opt(str(EMAIL)) }, { open: true })).check;

/** The provider-owned fields persisted in Pi's credential store next to refresh/access/expires. */
const StoredCredentialSchema = obj(
  {
    refresh: str({ minLength: 1 }),
    access: str({ minLength: 1 }),
    expires: num(),
    project_id: opt(str({ minLength: 1 })),
    tier_id: opt(str()),
    tier_name: opt(str()),
    paid_tier_id: opt(str()),
    paid_tier_name: opt(str()),
    client_source: opt(oneOf(["env", "config", "agy"])),
    client_id: opt(str({ minLength: 1 })),
    client_secret: opt(str({ minLength: 1 })),
    /** The account email from userinfo at login; absent on credentials from older logins. */
    email: opt(str(EMAIL)),
  },
  { open: true },
);
const isStoredCredential = compile(StoredCredentialSchema).check;
export type StoredAntigravityCredential = Static<typeof StoredCredentialSchema>;

const PRINTABLE = "^[\\x21-\\x7e]+$";
const ApiKeySchema = obj({
  token: str({ minLength: 1, pattern: PRINTABLE }),
  project_id: str({ minLength: 1, pattern: PRINTABLE }),
  account_key: opt(str({ pattern: "^[0-9a-f]{32}$" })),
});
const isApiKey = compile(ApiKeySchema).check;

export interface AntigravityApiKey {
  token: string;
  projectId: string;
  /**
   * A non-reversible key for the signed-in account, stable across access-token refreshes, for
   * keying per-account caches. Absent from keys this provider did not pack.
   */
  accountKey?: string | undefined;
}

/** What identifies the signed-in account: its email when login learned it, else its refresh token. */
export interface AntigravityAccountIdentity {
  refresh: string;
  email?: string | undefined;
}

/**
 * The account key packed into the API key: a truncated SHA-256 of the account email (case-folded)
 * or, for credentials without one, of the refresh token. Consumer accounts share one project id,
 * so the project cannot tell accounts apart; the email survives refresh-token rotation and the
 * refresh token survives access-token rotation. Never the email or token itself.
 */
export function antigravityAccountKey(identity: AntigravityAccountIdentity): string {
  const email = identity.email?.trim().toLowerCase();
  const material = email
    ? `google-antigravity-account-email:${email}`
    : `google-antigravity-account:${identity.refresh}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

/**
 * Reads the packed `{token, project_id, account_key?}` API key, or undefined for any other
 * string, such as a raw Gemini API key that Pi's inherited `google` API-key auth resolved.
 */
export function readAntigravityApiKey(apiKey: string): AntigravityApiKey | undefined {
  let value: unknown;
  try {
    value = JSON.parse(apiKey);
  } catch {
    return undefined;
  }
  if (!isApiKey(value)) return undefined;
  return { token: value.token, projectId: value.project_id, accountKey: value.account_key };
}

/**
 * Parses the packed API key. Anything else (a Gemini API key from GEMINI_API_KEY or a stored
 * API-key credential included) is a classified `auth` error that never echoes the input.
 */
export function parseAntigravityApiKey(apiKey: string): AntigravityApiKey {
  const parsed = readAntigravityApiKey(apiKey);
  if (parsed === undefined) {
    throw new AntigravityError({
      kind: "auth",
      detail: `this provider signs in with Google Antigravity OAuth and does not accept a Gemini API key; ${SIGN_IN_HINT}`,
    });
  }
  return parsed;
}

export interface AntigravityOAuthDeps {
  fetch?: FetchLike | undefined;
  env?: EnvLookup | undefined;
  agentDir?: (() => Promise<string>) | undefined;
  readFile?: ReadTextFile | undefined;
  now?: (() => number) | undefined;
  endpoints?: readonly string[] | undefined;
  onboardPollIntervalMs?: number | undefined;
  findAgyBinary?: ResolveClientCredentialsOptions["findAgyBinary"];
  scanAgyBinary?: ((file: string, signal?: AbortSignal) => Promise<AgyScanResult>) | undefined;
}

interface AuthorizationInput {
  code?: string | undefined;
  state?: string | undefined;
  error?: string | undefined;
}

/** Settles with `promise`, or rejects with the abort reason first; settles exactly once. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(signal.reason);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        reject(cause);
      },
    );
  });
}

function fromParams(params: URLSearchParams): AuthorizationInput {
  return {
    code: params.get("code") ?? undefined,
    state: params.get("state") ?? undefined,
    error: params.get("error") ?? undefined,
  };
}

/** A bare code copied in its percent-encoded form (`4%2F...`) is decoded once. */
function bareCode(value: string): string {
  if (!/%[0-9A-Fa-f]{2}/u.test(value)) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The pasted text: the code the Antigravity page shows, or the full redirect URL. */
function parseAuthorizationInput(value: string): AuthorizationInput {
  if (/^https?:\/\//iu.test(value)) {
    try {
      return fromParams(new URL(value).searchParams);
    } catch {
      return {};
    }
  }
  if (/(?:^|[?&])(?:code|error)=/u.test(value)) {
    return fromParams(new URLSearchParams(value.startsWith("?") ? value.slice(1) : value));
  }
  return { code: bareCode(value) };
}

function loginError(detail: string): AntigravityError {
  return new AntigravityError({ kind: "auth", detail });
}

/** Never echoes the pasted text: it holds the authorization code. */
function codeFromInput(input: string, state: string): string {
  const value = input.trim();
  if (!value) {
    throw loginError(
      "no authorization code was pasted; sign in in the browser and paste the code the Antigravity page shows",
    );
  }
  const parsed = parseAuthorizationInput(value);
  if (parsed.state !== undefined && parsed.state !== state) {
    throw loginError(
      "the pasted redirect URL belongs to a different login (state mismatch); start the login again",
    );
  }
  if (parsed.error !== undefined) {
    throw loginError(`Google authorization failed: ${sanitizeBackendMessage(parsed.error)}`);
  }
  const code = parsed.code?.trim();
  if (!code) throw loginError("the pasted text contains no authorization code");
  return code;
}

interface PkcePair {
  verifier: string;
  challenge: string;
}

function createPkce(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/**
 * The authorize URL with agy 1.5.14's parameters in the order it prints them (alphabetical) and
 * its encoding: form encoding, so spaces are `+` and `:`/`/` are percent-encoded.
 */
export function buildAuthorizationUrl(clientId: string, challenge: string, state: string): string {
  const params = new URLSearchParams([
    ["access_type", "offline"],
    ["client_id", clientId],
    ["code_challenge", challenge],
    ["code_challenge_method", "S256"],
    ["prompt", "consent"],
    ["redirect_uri", OAUTH_REDIRECT_URI],
    ["response_type", "code"],
    ["scope", OAUTH_SCOPES.join(" ")],
    ["state", state],
  ]);
  return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * The signed-in account's email from userinfo, as agy reads it after the token exchange. Any
 * failure other than the login's own abort resolves undefined: the email only keys caches.
 */
async function fetchAccountEmail(
  token: string,
  fetchImpl: FetchLike,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const timeout = AbortSignal.timeout(USERINFO_TIMEOUT_MS);
  let value: unknown;
  try {
    const response = await fetchImpl(GOOGLE_USERINFO_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await response.text();
    if (!response.ok) return undefined;
    value = JSON.parse(text);
  } catch {
    if (signal?.aborted) throw signal.reason;
    return undefined;
  }
  return isUserInfo(value) ? value.email : undefined;
}

async function tokenRequest(
  form: URLSearchParams,
  fetchImpl: FetchLike,
  signal: AbortSignal | undefined,
): Promise<TokenResponse> {
  const timeout = AbortSignal.timeout(TOKEN_TIMEOUT_MS);
  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    text = await response.text();
  } catch (cause) {
    if (signal?.aborted) throw signal.reason;
    throw antigravityNetworkError(
      timeout.aborted ? "token request timed out" : "token request failed",
      cause,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  if (!response.ok) {
    const code = isTokenError(value) ? value.error : `http_${response.status}`;
    throw new AntigravityError({
      kind: response.status >= 500 ? "server" : "auth",
      status: response.status,
      detail:
        code === "invalid_grant"
          ? `Google rejected the refresh token (revoked or expired); ${SIGN_IN_HINT}`
          : `Google token endpoint returned ${code}`,
    });
  }
  if (!isTokenResponse(value)) {
    throw new AntigravityError({
      kind: "malformed_response",
      detail: "token response is malformed",
    });
  }
  return value;
}

function credentialsFrom(
  tokens: TokenResponse,
  refresh: string,
  project: AntigravityProjectInfo,
  client: AntigravityClientCredentials,
  now: number,
  email: string | undefined,
): OAuthCredentials {
  const credentials: OAuthCredentials = {
    refresh,
    access: tokens.access_token,
    expires: now + tokens.expires_in * 1000 - EXPIRY_SKEW_MS,
    project_id: project.projectId,
    client_source: client.source,
    client_id: client.clientId,
  };
  if (project.tierId) credentials["tier_id"] = project.tierId;
  if (project.tierName) credentials["tier_name"] = project.tierName;
  if (project.paidTierId) credentials["paid_tier_id"] = project.paidTierId;
  if (project.paidTierName) credentials["paid_tier_name"] = project.paidTierName;
  if (email) credentials["email"] = email;
  // Only a pair discovered in agy is stored, so refresh never rescans the binary. Env and config
  // pairs are re-read at refresh and never persisted.
  if (client.source === "agy") credentials["client_secret"] = client.clientSecret;
  return credentials;
}

function projectFromStored(
  stored: StoredAntigravityCredential,
): AntigravityProjectInfo | undefined {
  if (!stored.project_id) return undefined;
  return {
    projectId: stored.project_id,
    tierId: stored.tier_id,
    tierName: stored.tier_name,
    paidTierId: stored.paid_tier_id,
    paidTierName: stored.paid_tier_name,
  };
}

function missingClientError(): Error {
  return new Error(
    `No Google Antigravity OAuth client is configured. Set ${ENV_CLIENT_ID} and ${ENV_CLIENT_SECRET}, ` +
      "add client_id and client_secret to <agentDir>/google-antigravity.json, or allow discovery from agy at login.",
  );
}

function storedCredential(credentials: OAuthCredentials): StoredAntigravityCredential {
  if (!isStoredCredential(credentials)) {
    throw new AntigravityError({
      kind: "auth",
      detail: `the stored Google Antigravity credential is incomplete; ${SIGN_IN_HINT}`,
    });
  }
  return credentials;
}

export function createAntigravityOAuth(deps: AntigravityOAuthDeps = {}): AntigravityOAuthConfig {
  const fetchImpl: FetchLike = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;

  async function readConfig() {
    const agentDir = await (deps.agentDir ?? defaultAgentDir)();
    return readAntigravityConfig(agentDir, deps.readFile);
  }

  /**
   * Shows the authorize URL, then asks exactly once for the code the Antigravity page displays:
   * through the host's manual code input when it has one, else a text prompt. An abort settles
   * the wait at once, even if the host prompt stays open.
   */
  async function readAuthorizationCode(
    callbacks: OAuthLoginCallbacks,
    authorizeUrl: string,
    state: string,
  ): Promise<string> {
    const signal = callbacks.signal;
    signal?.throwIfAborted();
    callbacks.onAuth({ url: authorizeUrl, instructions: AUTH_INSTRUCTIONS });
    const pending =
      callbacks.onManualCodeInput !== undefined
        ? callbacks.onManualCodeInput()
        : callbacks.onPrompt({ message: CODE_PROMPT });
    const input = await untilAborted(pending, signal);
    return codeFromInput(input, state);
  }

  async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    const decision = await callbacks.onSelect({
      message: ANTIGRAVITY_TERMS_WARNING,
      options: [
        { id: ACCEPT_TERMS, label: "I understand the risk and want to continue" },
        { id: "decline", label: "Cancel login" },
      ],
    });
    if (decision !== ACCEPT_TERMS) {
      throw new Error("Google Antigravity login cancelled: the terms warning was not accepted");
    }
    const signal = callbacks.signal;
    signal?.throwIfAborted();
    const config = await readConfig();
    const client = await resolveClientCredentials({
      env,
      config,
      signal,
      findAgyBinary: deps.findAgyBinary,
      scanAgyBinary: deps.scanAgyBinary,
      confirmAgyDiscovery: async () =>
        (await callbacks.onSelect({
          message:
            "No Google Antigravity OAuth client is configured. Scan the installed agy binary on this machine for its OAuth client? The scan is local; the discovered pair is stored only in your Pi credential.",
          options: [
            { id: "scan", label: "Scan agy" },
            { id: "cancel", label: "Cancel login" },
          ],
        })) === "scan",
      chooseCandidate: async (choice) => {
        const selected = await callbacks.onSelect({
          message: choice.message,
          options: choice.labels.map((label, index) => ({ id: String(index), label })),
        });
        const index = selected === undefined ? Number.NaN : Number(selected);
        return Number.isInteger(index) ? index : undefined;
      },
    });
    if (!client) throw missingClientError();
    signal?.throwIfAborted();

    const { verifier, challenge } = createPkce();
    const state = randomBytes(32).toString("base64url");
    const url = buildAuthorizationUrl(client.clientId, challenge, state);
    const code = await readAuthorizationCode(callbacks, url, state);
    signal?.throwIfAborted();

    const tokens = await tokenRequest(
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: OAUTH_REDIRECT_URI,
        code_verifier: verifier,
      }),
      fetchImpl,
      signal,
    );
    if (!tokens.refresh_token) {
      throw new AntigravityError({
        kind: "auth",
        detail:
          "Google returned no refresh token; remove choco-pi's access at myaccount.google.com/permissions and log in again",
      });
    }
    const email = await fetchAccountEmail(tokens.access_token, fetchImpl, signal);
    callbacks.onProgress?.("Discovering the Antigravity project…");
    const project = await discoverAntigravityProject({
      token: tokens.access_token,
      fetch: fetchImpl,
      signal,
      endpoints: deps.endpoints,
      configuredProjectId: config?.project_id,
      onboardPollIntervalMs: deps.onboardPollIntervalMs,
    });
    return credentialsFrom(tokens, tokens.refresh_token, project, client, now(), email);
  }

  async function refreshClient(
    stored: StoredAntigravityCredential,
  ): Promise<AntigravityClientCredentials> {
    if (stored.client_source === "agy") {
      if (!stored.client_id || !stored.client_secret) {
        throw new AntigravityError({
          kind: "auth",
          detail: `the stored agy OAuth client is incomplete; ${SIGN_IN_HINT}`,
        });
      }
      return { clientId: stored.client_id, clientSecret: stored.client_secret, source: "agy" };
    }
    const client = await resolveClientCredentials({ env, config: await readConfig() });
    if (!client) throw missingClientError();
    if (stored.client_id && stored.client_id !== client.clientId) {
      throw new AntigravityError({
        kind: "auth",
        detail: `the configured OAuth client changed since login; ${SIGN_IN_HINT}`,
      });
    }
    return client;
  }

  async function refreshToken(
    credentials: OAuthCredentials,
    signal: AbortSignal,
  ): Promise<OAuthCredentials> {
    const stored = storedCredential(credentials);
    const client = await refreshClient(stored);
    const tokens = await tokenRequest(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: stored.refresh,
        client_id: client.clientId,
        client_secret: client.clientSecret,
      }),
      fetchImpl,
      signal,
    );
    const project =
      projectFromStored(stored) ??
      (await discoverAntigravityProject({
        token: tokens.access_token,
        fetch: fetchImpl,
        signal,
        endpoints: deps.endpoints,
        configuredProjectId: (await readConfig())?.project_id,
      }));
    return credentialsFrom(
      tokens,
      tokens.refresh_token ?? stored.refresh,
      project,
      client,
      now(),
      stored.email,
    );
  }

  function getApiKey(credentials: OAuthCredentials): string {
    const stored = storedCredential(credentials);
    if (!stored.project_id) {
      throw new AntigravityError({
        kind: "auth",
        detail: `the Google Antigravity credential has no project; ${SIGN_IN_HINT}`,
      });
    }
    return JSON.stringify({
      token: stored.access,
      project_id: stored.project_id,
      account_key: antigravityAccountKey({ refresh: stored.refresh, email: stored.email }),
    });
  }

  return { name: OAUTH_LOGIN_NAME, isSubscription: true, login, refreshToken, getApiKey };
}

export const antigravityOAuth: AntigravityOAuthConfig = createAntigravityOAuth();
