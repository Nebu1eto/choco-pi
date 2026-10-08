import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { isCanonicalCodexBaseUrl } from "../../adapter/prompt/codex-model.ts";
import { buildVerifiedAccessHeaders, extractAccountId } from "./headers.ts";
import { invalidateCodexDaybreakModelSupport } from "./daybreak-model-support.ts";

export const DAYBREAK_LOOKUP_TIMEOUT_MS = 5_000;
export const DAYBREAK_ENTITLEMENT_TTL_MS = 10 * 60_000;
export const DAYBREAK_FAILURE_TTL_MS = 60_000;
export const DAYBREAK_CACHE_MAX_ENTRIES = 64;

export type DaybreakEntitlement = "blue" | "red" | "not-granted" | "lookup-failed";
export type DaybreakLookupResult = Readonly<{
  entitlement: DaybreakEntitlement;
  status?: number | undefined;
}>;

/** Credentials copied at request start; later mutation of caller objects cannot reach the lookup. */
export type DaybreakLookupCredentials = Readonly<{
  apiKey: string;
  headers: Readonly<Record<string, string | null>> | undefined;
  modelHeaders: Readonly<Record<string, string>> | undefined;
}>;

export type DaybreakAccount = Readonly<{ key: string; accountId: string; url: string }>;

// External payload: required fields are validated strictly; unknown fields are tolerated.
// Observed live shape (2026-10-08): grants are objects such as
// { level: "tac1", source: "individual" }.
const GrantSchema = Type.Object({ level: Type.String() });
const ProgramSchema = Type.Object({
  program: Type.String(),
  state: Type.String(),
  grants: Type.Optional(Type.Array(GrantSchema)),
});
const VerifiedAccessSchema = Type.Object({ programs: Type.Array(ProgramSchema) });

type CacheEntry = {
  readonly token: string;
  pending: Promise<DaybreakLookupResult> | undefined;
  settled: { result: DaybreakLookupResult; expiresAt: number } | undefined;
};
const cache = new Map<string, CacheEntry>();

type EntitlementDependencies = {
  fetch: typeof globalThis.fetch;
  now: () => number;
  timeoutMs: number;
};
const defaultDependencies: EntitlementDependencies = {
  fetch: (input, init) => globalThis.fetch(input, init),
  now: () => Date.now(),
  timeoutMs: DAYBREAK_LOOKUP_TIMEOUT_MS,
};
let dependencies: EntitlementDependencies = defaultDependencies;

/** Test seam: replaces lookup I/O and clock, and clears all cached entitlements. */
export function configureCodexDaybreakEntitlementForTest(
  overrides: Partial<EntitlementDependencies> | undefined,
): void {
  dependencies = overrides ? { ...defaultDependencies, ...overrides } : defaultDependencies;
  cache.clear();
}

export function copyDaybreakHeaders<Value extends string | null>(
  headers: Readonly<Record<string, Value>> | undefined,
): Readonly<Record<string, Value>> | undefined {
  return headers ? Object.freeze({ ...headers }) : undefined;
}

/** Normalized cache key: canonical ChatGPT backend URL plus JWT account id; else ineligible. */
export function daybreakAccount(
  apiKey: string,
  baseUrl: string | undefined,
): DaybreakAccount | undefined {
  if (!baseUrl || !isCanonicalCodexBaseUrl(baseUrl)) return undefined;
  let accountId: string;
  try {
    accountId = extractAccountId(apiKey);
  } catch {
    return undefined;
  }
  if (accountId === "") return undefined;
  const url = new URL("/backend-api/accounts/verified_access", baseUrl).toString();
  return Object.freeze({ accountId, url, key: JSON.stringify([accountId, url]) });
}

/** Drops cached entitlement for one account+backend, e.g. after an inference 401/403. */
export function invalidateCodexDaybreakEntitlement(
  apiKey: string | undefined,
  baseUrl: string | undefined,
): void {
  if (!apiKey) return;
  const account = daybreakAccount(apiKey, baseUrl);
  if (account) invalidateCodexDaybreakAccount(account);
}

/** Invalidate both lookup caches using the already-validated account identity. */
export function invalidateCodexDaybreakAccount(account: DaybreakAccount): void {
  cache.delete(account.key);
  invalidateCodexDaybreakModelSupport(account);
}

function entitlementFromVerifiedAccess(
  payload: Static<typeof VerifiedAccessSchema>,
): DaybreakEntitlement {
  const grants = new Set<string>();
  for (const program of payload.programs) {
    if (program.program !== "cyber" || program.state !== "active") continue;
    for (const grant of program.grants ?? []) grants.add(grant.level);
  }
  if (grants.has("tac3") || grants.has("government")) return "red";
  if (grants.has("tac1") || grants.has("tac2")) return "blue";
  return "not-granted";
}

async function fetchVerifiedAccess(url: string, headers: Headers): Promise<DaybreakLookupResult> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), dependencies.timeoutMs);
  try {
    const response = await dependencies.fetch(url, {
      method: "GET",
      headers,
      signal: abort.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { entitlement: "lookup-failed", status: response.status };
    }
    const payload: unknown = await response.json();
    if (!Check(VerifiedAccessSchema, payload))
      return { entitlement: "lookup-failed", status: response.status };
    return { entitlement: entitlementFromVerifiedAccess(payload), status: response.status };
  } catch {
    return { entitlement: "lookup-failed" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Single-flight, TTL-bounded entitlement lookup. Pending and completed entries are dropped on
 * token change or when `invalidate` reports a toggle-on transition; a dropped flight cannot refill.
 */
export function lookupCodexDaybreakEntitlement(
  account: DaybreakAccount,
  credentials: DaybreakLookupCredentials,
  invalidate: boolean,
): Promise<DaybreakLookupResult> {
  const now = dependencies.now();
  let entry = cache.get(account.key);
  if (entry && entry.token !== credentials.apiKey) {
    invalidateCodexDaybreakAccount(account);
    entry = undefined;
  }
  if (entry && invalidate) {
    cache.delete(account.key);
    entry = undefined;
  }
  if (entry?.pending) return entry.pending;
  if (entry?.settled && entry.settled.expiresAt > now) return Promise.resolve(entry.settled.result);
  if (entry) cache.delete(account.key);
  while (cache.size >= DAYBREAK_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  const created: CacheEntry = { token: credentials.apiKey, pending: undefined, settled: undefined };
  const headers = buildVerifiedAccessHeaders(
    credentials.modelHeaders === undefined ? undefined : { ...credentials.modelHeaders },
    credentials.headers === undefined ? undefined : headersRecord(credentials.headers),
    account.accountId,
    credentials.apiKey,
  );
  created.pending = fetchVerifiedAccess(account.url, headers).then((result) => {
    // An invalidated or replaced entry must not be refilled by its stale flight.
    if (cache.get(account.key) !== created) return result;
    created.pending = undefined;
    if (result.status === 401 || result.status === 403) {
      invalidateCodexDaybreakAccount(account);
      return result;
    }
    created.settled = {
      result,
      expiresAt:
        dependencies.now() +
        (result.entitlement === "lookup-failed" || result.entitlement === "not-granted"
          ? DAYBREAK_FAILURE_TTL_MS
          : DAYBREAK_ENTITLEMENT_TTL_MS),
    };
    return result;
  });
  cache.set(account.key, created);
  return created.pending;
}

/** True while a completed or pending entry exists for the account; test and status support. */
export function hasCodexDaybreakEntitlementEntry(account: DaybreakAccount): boolean {
  return cache.has(account.key);
}

function headersRecord(headers: Readonly<Record<string, string | null>>): ProviderHeaders {
  return { ...headers };
}
