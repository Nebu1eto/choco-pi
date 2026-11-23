export interface BearerAuth {
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string | null | undefined>>;
}

const BEARER_HEADER = /^Bearer\s+(\S+)$/iu;

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
