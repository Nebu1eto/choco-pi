import { createHash } from "node:crypto";
import type { ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { compile, lit, num, obj, opt, str } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";
import type { FetchLike } from "../client/http.ts";
import { fetchAvailableModels, type FetchAvailableModelsResponse } from "./fetch.ts";
import {
  AntigravityCatalogSchema,
  FALLBACK_CATALOG,
  buildAntigravityCatalog,
  catalogToProviderModels,
  setActiveCatalog,
  type AntigravityCatalog,
} from "./group.ts";

export const CATALOG_TTL_MS = 4 * 60 * 60 * 1000;
export const STORE_KEY = "google_antigravity";

const StoredCatalogSchema = obj(
  {
    google_antigravity: obj({
      schema_version: lit(1),
      credential_key: str(),
      catalog: AntigravityCatalogSchema,
    }),
    checkedAt: opt(num()),
  },
  { open: true },
);
const isStoredCatalog = compile(StoredCatalogSchema).check;
type StoredCatalog = Static<typeof StoredCatalogSchema>["google_antigravity"];

/** The models-store entry: Pi's fields plus this provider's catalog metadata. */
export interface AntigravityStoreEntry extends ModelsStoreEntry {
  google_antigravity: StoredCatalog;
}

const isOAuthCredential = compile(
  obj(
    {
      type: lit("oauth"),
      access: str({ minLength: 1 }),
      refresh: str({ minLength: 1 }),
      project_id: opt(str()),
    },
    { open: true },
  ),
).check;

export type FetchCatalog = (
  token: string,
  projectId: string,
  signal: AbortSignal,
) => Promise<FetchAvailableModelsResponse>;

export interface AntigravityRefreshDeps {
  fetchCatalog?: FetchCatalog | undefined;
  fetch?: FetchLike | undefined;
  now?: (() => number) | undefined;
  ttlMs?: number | undefined;
}

/** A non-reversible key tying a cached catalog to the credential that fetched it. */
export function catalogCredentialKey(refreshToken: string): string {
  return createHash("sha256")
    .update(`google-antigravity:${refreshToken}`)
    .digest("hex")
    .slice(0, 32);
}

interface CachedCatalog {
  catalog: AntigravityCatalog;
  credentialKey: string;
  checkedAt: number;
}

function readCache(context: RefreshModelsContext): CachedCatalog | undefined {
  const stored = context.stored;
  if (!isStoredCatalog(stored)) return undefined;
  return {
    catalog: stored.google_antigravity.catalog,
    credentialKey: stored.google_antigravity.credential_key,
    checkedAt: stored.checkedAt ?? 0,
  };
}

function isAbort(context: RefreshModelsContext, cause: unknown): boolean {
  return context.signal.aborted || (cause instanceof DOMException && cause.name === "AbortError");
}

/**
 * refreshModels for the `google` provider, following the synthetic provider's precedent: cache-only
 * when offline, 4-hour TTL keyed to the credential, best-effort persistence through
 * `context.publish`, and the last good (or fallback) catalog on any failure except abort. With a
 * current credential, a persisted catalog serves as the fallback only when it was fetched with
 * that credential; another account's catalog gives way to the offline FALLBACK_CATALOG.
 */
export function createAntigravityRefreshModels(
  deps: AntigravityRefreshDeps = {},
): (context: RefreshModelsContext) => Promise<ProviderModelConfig[]> {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? CATALOG_TTL_MS;
  const fetchCatalog: FetchCatalog =
    deps.fetchCatalog ??
    ((token, projectId, signal) =>
      fetchAvailableModels({ token, projectId, signal, fetch: deps.fetch }));

  const use = (catalog: AntigravityCatalog): ProviderModelConfig[] => {
    setActiveCatalog(catalog === FALLBACK_CATALOG ? undefined : catalog);
    return catalogToProviderModels(catalog);
  };

  return async (context) => {
    const cached = readCache(context);
    const credential = context.credential;
    const credentialKey = isOAuthCredential(credential)
      ? catalogCredentialKey(credential.refresh)
      : undefined;
    const fallback =
      cached && (credentialKey === undefined || cached.credentialKey === credentialKey)
        ? cached.catalog
        : FALLBACK_CATALOG;
    if (
      !context.allowNetwork ||
      credentialKey === undefined ||
      !isOAuthCredential(credential) ||
      !credential.project_id
    ) {
      return use(fallback);
    }
    if (
      cached &&
      !context.force &&
      cached.credentialKey === credentialKey &&
      now() - cached.checkedAt < ttl
    ) {
      return use(cached.catalog);
    }
    let catalog: AntigravityCatalog;
    try {
      catalog = buildAntigravityCatalog(
        await fetchCatalog(credential.access, credential.project_id, context.signal),
      );
      if (catalog.models.length === 0) return use(fallback);
    } catch (cause) {
      if (isAbort(context, cause)) throw cause;
      return use(fallback);
    }
    context.signal.throwIfAborted();
    const entry: AntigravityStoreEntry = {
      models: [],
      checkedAt: now(),
      [STORE_KEY]: { schema_version: 1, credential_key: credentialKey, catalog },
    };
    try {
      await context.publish({ persist: entry, update: () => setActiveCatalog(catalog) });
    } catch (cause) {
      if (isAbort(context, cause)) throw cause;
      // Persistence is best-effort; the fresh catalog still serves this process.
      setActiveCatalog(catalog);
    }
    return catalogToProviderModels(catalog);
  };
}
