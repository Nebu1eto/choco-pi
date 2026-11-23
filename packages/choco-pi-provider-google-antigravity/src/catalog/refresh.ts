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

export function catalogCredentialKey(refreshToken: string): string {
  return createHash("sha256")
    .update(`google-antigravity:${refreshToken}`)
    .digest("hex")
    .slice(0, 32);
}

interface CachedCatalog {
  catalog: AntigravityCatalog;
  credentialKey: string;
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
  const catalog = withoutHiddenModels(cached.catalog);
  if (catalog.models.length === 0) return undefined;
  return { ...cached, catalog };
}

function isAbort(context: RefreshModelsContext, cause: unknown): boolean {
  return context.signal.aborted || (cause instanceof DOMException && cause.name === "AbortError");
}

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
    const entry: AntigravityStoreEntry = {
      models: [],
      ...context.stored,
      [STORE_KEY]: { schema_version: 2, credential_key: credentialKey, checked_at: now(), catalog },
    };
    try {
      await context.publish({ persist: entry, update: () => setActiveCatalog(catalog) });
    } catch (cause) {
      if (isAbort(context, cause)) throw cause;
      setActiveCatalog(catalog);
    }
    return catalogToProviderModels(catalog);
  };
}
