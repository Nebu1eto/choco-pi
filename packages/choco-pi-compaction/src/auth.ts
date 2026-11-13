/**
 * Shared, header-aware credential classification input (D10). The host
 * resolves a request's auth as an API key and/or provider headers; a provider
 * configured with only an `Authorization: Bearer <token>` header carries its
 * credential there. Every auth-mode classifier (Anthropic, xAI, Codex) looks
 * in the same places, in the same order, so the foreground, the background and
 * the client agree about one session's auth mode.
 */

/** Structurally compatible with `ModelRegistry.getApiKeyAndHeaders` results. */
export interface BearerAuth {
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string | null | undefined>>;
}

const BEARER_HEADER = /^Bearer\s+(\S+)$/iu;

/**
 * The bearer credential of a resolved auth: a non-empty (trimmed) `apiKey`
 * first; else the token of an `Authorization: Bearer <token>` header (name
 * case-insensitive, value trimmed). A null, undefined or empty value, or any
 * other scheme, carries none. Pure.
 */
export function bearerCredentialOf(auth: BearerAuth | undefined): string | undefined {
  if (auth === undefined) return undefined;
  const apiKey = auth.apiKey?.trim();
  if (apiKey !== undefined && apiKey.length > 0) return apiKey;
  const headers = auth.headers;
  if (headers === undefined) return undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "authorization" || value === null || value === undefined) continue;
    const token = BEARER_HEADER.exec(value.trim())?.[1];
    if (token !== undefined) return token;
  }
  return undefined;
}
