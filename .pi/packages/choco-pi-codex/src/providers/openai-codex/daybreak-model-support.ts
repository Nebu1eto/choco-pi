import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import {
  DAYBREAK_CACHE_MAX_ENTRIES,
  DAYBREAK_ENTITLEMENT_TTL_MS,
  DAYBREAK_FAILURE_TTL_MS,
  type DaybreakAccount,
  type DaybreakLookupCredentials,
  invalidateCodexDaybreakAccount,
} from "./daybreak-entitlement.ts";
import { buildVerifiedAccessHeaders } from "./headers.ts";

export type DaybreakModelSupport = "supported" | "unsupported" | "lookup-failed";
export type DaybreakTargetProgram = "daybreak_blue" | "daybreak_red";
/** `any` asks whether the model advertises some Daybreak program at all. */
export type DaybreakSupportQuery = DaybreakTargetProgram | "any";
const ModelSchema = Type.Object({
  slug: Type.String(),
  available_access_programs: Type.Optional(
    Type.Object({ cyber: Type.Optional(Type.Array(Type.String())) }),
  ),
});
const ModelsSchema = Type.Object({ models: Type.Array(Type.Unknown()) });
type Models = readonly Static<typeof ModelSchema>[];
type LookupResult = Readonly<{ models?: Models; status?: number }>;
type CacheEntry = {
  token: string;
  pending: Promise<LookupResult> | undefined;
  settled: { result: LookupResult; expiresAt: number } | undefined;
};
const cache = new Map<string, CacheEntry>();
type Dependencies = { fetch: typeof globalThis.fetch; now: () => number; timeoutMs: number };
const defaults: Dependencies = {
  fetch: (input, init) => globalThis.fetch(input, init),
  now: () => Date.now(),
  timeoutMs: 5_000,
};
let dependencies = defaults;

export function configureCodexDaybreakModelSupportForTest(
  overrides: Partial<Dependencies> | undefined,
): void {
  dependencies = overrides ? { ...defaults, ...overrides } : defaults;
  cache.clear();
}

/** Called by the entitlement invalidation boundary for toggles and inference auth failures. */
export function invalidateCodexDaybreakModelSupport(account: DaybreakAccount): void {
  cache.delete(account.key);
}

async function fetchModels(
  account: DaybreakAccount,
  credentials: DaybreakLookupCredentials,
  io: Dependencies,
): Promise<LookupResult> {
  const url = new URL("/backend-api/codex/models?client_version=1.0.0", account.url).toString();
  const headers = buildVerifiedAccessHeaders(
    credentials.modelHeaders === undefined ? undefined : { ...credentials.modelHeaders },
    credentials.headers === undefined ? undefined : { ...credentials.headers },
    account.accountId,
    credentials.apiKey,
  );
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), io.timeoutMs);
  try {
    const response = await io.fetch(url, { method: "GET", headers, signal: abort.signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status };
    }
    const payload: unknown = await response.json();
    if (!Check(ModelsSchema, payload)) return { status: response.status };
    return {
      models: payload.models.filter((entry) => Check(ModelSchema, entry)),
      status: response.status,
    };
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

/** One whole-catalog flight per account/backend; target-program decisions are never cached. */
export async function lookupCodexDaybreakModelSupport(
  account: DaybreakAccount,
  credentials: DaybreakLookupCredentials,
  modelId: string,
  targetProgram: DaybreakSupportQuery,
): Promise<DaybreakModelSupport> {
  const io = dependencies;
  let entry = cache.get(account.key);
  if (entry && entry.token !== credentials.apiKey) {
    cache.delete(account.key);
    entry = undefined;
  }
  if (entry?.settled && entry.settled.expiresAt <= io.now()) {
    cache.delete(account.key);
    entry = undefined;
  }
  if (!entry) {
    while (cache.size >= DAYBREAK_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
    const created: CacheEntry = {
      token: credentials.apiKey,
      pending: undefined,
      settled: undefined,
    };
    cache.set(account.key, created);
    created.pending = fetchModels(account, credentials, io).then((result) => {
      if (cache.get(account.key) !== created) return result;
      created.pending = undefined;
      if (result.status === 401 || result.status === 403) {
        invalidateCodexDaybreakAccount(account);
        return result;
      }
      created.settled = {
        result,
        expiresAt:
          io.now() + (result.models ? DAYBREAK_ENTITLEMENT_TTL_MS : DAYBREAK_FAILURE_TTL_MS),
      };
      return result;
    });
    entry = created;
  }
  const result = entry.pending ? await entry.pending : entry.settled?.result;
  if (!result?.models) return "lookup-failed";
  return result.models.some((model) => {
    if (model.slug !== modelId) return false;
    const programs = model.available_access_programs?.cyber ?? [];
    return targetProgram === "any"
      ? programs.some((program) => program.startsWith("daybreak_"))
      : programs.includes(targetProgram);
  })
    ? "supported"
    : "unsupported";
}
