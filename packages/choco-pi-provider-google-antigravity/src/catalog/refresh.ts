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
  withoutHiddenModels,
  type AntigravityCatalog,
} from "./group.ts";

export const CATALOG_TTL_MS = 4 * 60 * 60 * 1000;
export const STORE_KEY = "google_antigravity";

/*
 * The models-store slot `google` is shared with Pi's built-in google remote-catalog refresh, which
 * runs first in the same composed refresh and owns the top-level fields (models, lastModified,
 * etag, checkedAt). This provider owns only the `google_antigravity` key, keeps its freshness
 * timestamp inside it, and leaves every other field as the snapshot holds it. See README "Models".
 */
const StoredCatalogSchema = obj(
  {
    google_antigravity: obj({
      schema_version: lit(2),
      credential_key: str(),
      checked_at: num(),
      catalog: AntigravityCatalogSchema,
    }),
  },
  { open: true },
);
const isStoredCatalog = compile(StoredCatalogSchema).check;
type StoredCatalog = Static<typeof StoredCatalogSchema>["google_antigravity"];

/**
 * Schema version 1 kept its timestamp in the shared top-level `checkedAt`, which the base also
 * moves. Its catalog is still served offline and as the failure fallback, but it is always stale:
 * the first online run refetches and rewrites the entry as version 2.
 */
const isLegacyStoredCatalog = compile(
  obj(
    {
      google_antigravity: obj({
        schema_version: lit(1),
        credential_key: str(),
        catalog: AntigravityCatalogSchema,
      }),
    },
    { open: true },
  ),
).check;

/** The models-store entry: the shared slot's fields plus this provider's catalog metadata. */
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
  /** Undefined for a legacy entry, which is never fresh. */
  checkedAt: number | undefined;
}

function readCache(context: RefreshModelsContext): CachedCatalog | undefined {
  const stored = context.stored;
  let cached: CachedCatalog;
  if (isStoredCatalog(stored)) {
    cached = {
      catalog: stored.google_antigravity.catalog,
      credentialKey: stored.google_antigravity.credential_key,
      checkedAt: stored.google_antigravity.checked_at,
    };
  } else if (isLegacyStoredCatalog(stored)) {
    cached = {
      catalog: stored.google_antigravity.catalog,
      credentialKey: stored.google_antigravity.credential_key,
      checkedAt: undefined,
    };
  } else {
    return undefined;
  }
  // A catalog persisted before a model was hidden must not bring it back.
  const catalog = withoutHiddenModels(cached.catalog);
  if (catalog.models.length === 0) return undefined;
  return { ...cached, catalog };
}

function isAbort(context: RefreshModelsContext, cause: unknown): boolean {
  return context.signal.aborted || (cause instanceof DOMException && cause.name === "AbortError");
}

/**
 * refreshModels for the `google` provider, following the synthetic provider's precedent: cache-only
 * when offline, 4-hour TTL keyed to the credential, best-effort persistence through
 * `context.publish`, and the last good (or fallback) catalog on any failure except abort. With a
 * current credential, a persisted catalog serves as the fallback only when it was fetched with
 * that credential; another account's catalog gives way to the offline FALLBACK_CATALOG. Only a
 * successful fetch persists, and the write carries the snapshot's foreign fields unchanged.
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
      cached.checkedAt !== undefined &&
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
    // Replace semantics: the snapshot's fields (the base's catalog and freshness) go back as read.
    const entry: AntigravityStoreEntry = {
      models: [],
      ...context.stored,
      [STORE_KEY]: { schema_version: 2, credential_key: credentialKey, checked_at: now(), catalog },
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
