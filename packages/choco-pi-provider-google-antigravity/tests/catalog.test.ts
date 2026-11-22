import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type {
  Api,
  Model,
  ModelsPublication,
  ModelsStoreEntry,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
  fetchAvailableModelsValidator,
  type FetchAvailableModelsResponse,
} from "../src/catalog/fetch.ts";
import {
  FALLBACK_CATALOG,
  buildAntigravityCatalog,
  catalogToProviderModels,
  getActiveCatalog,
  resolveRuntimeModel,
  setActiveCatalog,
} from "../src/catalog/group.ts";
import {
  CATALOG_TTL_MS,
  catalogCredentialKey,
  createAntigravityRefreshModels,
  type AntigravityStoreEntry,
} from "../src/catalog/refresh.ts";
import { AntigravityError } from "../src/errors.ts";
import { fixture } from "./helpers.ts";

afterEach(() => setActiveCatalog(undefined));

async function capturedModels(): Promise<FetchAvailableModelsResponse> {
  const value: unknown = JSON.parse(await fixture("fetch-available-models.json"));
  assert.ok(fetchAvailableModelsValidator.check(value));
  return value;
}

function asModel(config: ProviderModelConfig): Model<Api> {
  assert.ok(config.type === undefined || config.type === "chat");
  return {
    ...config,
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://cloudcode.test",
  };
}

test("24 agent runtime ids collapse to 8 base models with advertised levels only", async () => {
  const catalog = buildAntigravityCatalog(await capturedModels());
  const levels = Object.fromEntries(
    catalog.models.map((model) => [model.id, model.variants.map((variant) => variant.level)]),
  );
  assert.deepEqual(levels, {
    "gemini-4-neon": ["low", "medium", "high", "xhigh"],
    "gemini-4-carbon": ["low", "medium", "high"],
    "gemini-4-argon": ["low", "medium", "high"],
    "gemini-4-hydrogen": ["low", "medium", "high", "xhigh"],
    "gemini-3.8-flash": ["low", "medium", "high"],
    "claude-opus-5-5": ["low", "medium", "high"],
    "claude-sonnet-5-5": ["low", "medium", "high"],
    "gpt-oss-120b": ["medium"],
  });
  assert.equal(
    catalog.models.reduce((count, model) => count + model.variants.length, 0),
    24,
  );
  assert.deepEqual(catalog.webSearchModelIds, ["gemini-3.5-flash-lite"]);
  const byId = new Map(catalog.models.map((model) => [model.id, model]));
  assert.equal(byId.get("gemini-4-neon")?.name, "Gemini 4 Neon");
  assert.equal(byId.get("gpt-oss-120b")?.name, "GPT-OSS 120B");
  assert.equal(byId.get("gpt-oss-120b")?.family, "gpt-oss");
  assert.equal(byId.get("claude-opus-5-5")?.family, "claude");
  assert.equal(byId.get("claude-opus-5-5")?.contextWindow, 1_000_000);
  assert.equal(byId.get("gemini-4-argon")?.maxTokens, 65_536);
  assert.equal(byId.get("gemini-4-neon")?.maxTokens, 262_144);
});

test("Pi sees only advertised thinking levels and never off", async () => {
  const models = catalogToProviderModels(buildAntigravityCatalog(await capturedModels()));
  const supported = Object.fromEntries(
    models.map((config) => [config.id, getSupportedThinkingLevels(asModel(config))]),
  );
  assert.deepEqual(supported["gemini-4-neon"], ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(supported["gemini-3.8-flash"], ["low", "medium", "high"]);
  assert.deepEqual(supported["gpt-oss-120b"], ["medium"]);
  for (const config of models) assert.equal(config.api, "google-generative-ai");
});

const isOrchestrator = (id: string) => id.startsWith("gemini-pro-orchestrator");

test("the Antigravity Orchestrator is never offered", async () => {
  const response = await capturedModels();
  assert.ok(Object.keys(response.models).some(isOrchestrator), "the fixture has orchestrators");
  const catalog = buildAntigravityCatalog(response);
  assert.deepEqual(catalog.models.map((model) => model.id).filter(isOrchestrator), []);
  assert.deepEqual(
    catalog.models
      .flatMap((model) => model.variants.map((variant) => variant.runtimeId))
      .filter(isOrchestrator),
    [],
  );
  assert.deepEqual(FALLBACK_CATALOG.models.map((model) => model.id).filter(isOrchestrator), []);
  // Even when agentModelSorts is absent and the display-name heuristic decides.
  const unsorted = buildAntigravityCatalog({ ...response, agentModelSorts: [] });
  assert.deepEqual(unsorted.models.map((model) => model.id).filter(isOrchestrator), []);
  setActiveCatalog(catalog);
  assert.throws(
    () => resolveRuntimeModel("gemini-pro-orchestrator-neon", "xhigh"),
    (error) => error instanceof AntigravityError && error.kind === "model_unavailable",
  );
});

test("a persisted catalog with Orchestrator entries never resurfaces them", async () => {
  const orchestrator = {
    id: "gemini-pro-orchestrator-neon",
    name: "Orchestrator (Neon)",
    family: "gemini" as const,
    reasoning: true,
    images: true,
    contextWindow: 1_048_576,
    maxTokens: 262_144,
    variants: [
      {
        level: "xhigh" as const,
        runtimeId: "gemini-pro-orchestrator-neon",
        maxOutputTokens: 262_144,
        wireThinkingLevel: 100,
      },
    ],
  };
  const now = 5_000;
  const stored: AntigravityStoreEntry = {
    models: [],
    google_antigravity: {
      schema_version: 2,
      credential_key: catalogCredentialKey("r"),
      checked_at: now,
      catalog: {
        models: [...FALLBACK_CATALOG.models, orchestrator],
        webSearchModelIds: [],
        defaultModelId: "gemini-pro-orchestrator-neon",
      },
    },
  };
  let fetched = 0;
  const refresh = createAntigravityRefreshModels({
    now: () => now,
    fetchCatalog: async () => {
      fetched++;
      throw new AntigravityError({ kind: "server" });
    },
  });
  const runs = [
    context({ allowNetwork: false, stored: structuredClone(stored) }, []),
    context({ allowNetwork: true, refresh: "r", stored: structuredClone(stored) }, []),
    context({ allowNetwork: true, refresh: "r", stored: structuredClone(stored), force: true }, []),
  ];
  for (const run of runs) {
    setActiveCatalog(undefined);
    const models = await refresh(run);
    assert.deepEqual(
      models.map((model) => model.id),
      FALLBACK_CATALOG.models.map((model) => model.id),
    );
    assert.deepEqual(
      getActiveCatalog()
        .models.map((model) => model.id)
        .filter(isOrchestrator),
      [],
    );
    assert.equal(getActiveCatalog().defaultModelId, undefined);
    assert.throws(
      () => resolveRuntimeModel("gemini-pro-orchestrator-neon", "xhigh"),
      (error) => error instanceof AntigravityError && error.kind === "model_unavailable",
    );
  }
  assert.equal(fetched, 1, "only the forced run fetched");
});

test("active catalog is shared across distinct module instances", async () => {
  const url = new URL("../src/catalog/group.ts?instance=reader", import.meta.url);
  const reader: typeof import("../src/catalog/group.ts") = await import(url.href);
  assert.notEqual(reader.getActiveCatalog, getActiveCatalog);
  assert.equal(reader.getActiveCatalog(), reader.FALLBACK_CATALOG);

  const catalog = buildAntigravityCatalog(await capturedModels());
  setActiveCatalog(catalog);
  assert.equal(reader.getActiveCatalog(), catalog);
  assert.equal(reader.resolveRuntimeModel("gpt-oss-120b", "high").runtimeId, "gpt-oss-120b-medium");

  reader.setActiveCatalog(undefined);
  assert.equal(getActiveCatalog(), FALLBACK_CATALOG);
});

test("invalid shared catalog falls back to the offline catalog", () => {
  Object.defineProperty(globalThis, Symbol.for("choco-pi.provider-google-antigravity.catalog"), {
    configurable: true,
    value: { models: [{}], webSearchModelIds: [] },
  });
  assert.equal(getActiveCatalog(), FALLBACK_CATALOG);
});

test("resolveRuntimeModel maps base id and level to the runtime variant", async () => {
  setActiveCatalog(buildAntigravityCatalog(await capturedModels()));
  assert.deepEqual(resolveRuntimeModel("gemini-3.8-flash", "low"), {
    runtimeId: "gemini-3.8-flash-low",
    thinkingConfig: { includeThoughts: true, thinkingLevel: "LOW" },
    maxOutputTokens: 65_536,
    modelEnum: "MODEL_PLACEHOLDER_M320",
    family: "gemini",
    level: "low",
  });
  assert.deepEqual(resolveRuntimeModel("gemini-4-neon", "xhigh").thinkingConfig, {
    includeThoughts: true,
    thinkingLevel: 100,
  });
  assert.deepEqual(resolveRuntimeModel("gemini-4-hydrogen", "xhigh"), {
    runtimeId: "gemini-4-hydrogen-xhigh",
    thinkingConfig: { includeThoughts: true, thinkingLevel: 100 },
    maxOutputTokens: 262_144,
    modelEnum: "MODEL_PLACEHOLDER_M528",
    family: "gemini",
    level: "xhigh",
  });
  assert.deepEqual(resolveRuntimeModel("gemini-4-hydrogen", "high").thinkingConfig, {
    includeThoughts: true,
    thinkingLevel: "HIGH",
  });
  assert.equal(resolveRuntimeModel("claude-opus-5-5", "max").runtimeId, "claude-opus-5-5-high");
  assert.equal(resolveRuntimeModel("claude-opus-5-5", "minimal").runtimeId, "claude-opus-5-5-low");
  const off = resolveRuntimeModel("claude-sonnet-5-5", "off");
  assert.equal(off.runtimeId, "claude-sonnet-5-5-low");
  assert.equal(off.thinkingConfig?.includeThoughts, false);
  const oss = resolveRuntimeModel("gpt-oss-120b", "high");
  assert.equal(oss.runtimeId, "gpt-oss-120b-medium");
  assert.deepEqual(oss.thinkingConfig, { includeThoughts: true, thinkingBudget: 8192 });
  assert.throws(
    () => resolveRuntimeModel("no-such-model", "low"),
    (error) => error instanceof AntigravityError && error.kind === "model_unavailable",
  );
});

interface ContextOptions {
  allowNetwork: boolean;
  refresh?: string;
  stored?: ModelsStoreEntry;
  force?: boolean;
  signal?: AbortSignal;
}

function context(options: ContextOptions, published: ModelsPublication[]): RefreshModelsContext {
  const value: RefreshModelsContext = {
    allowNetwork: options.allowNetwork,
    signal: options.signal ?? new AbortController().signal,
    publish: async (publication) => {
      published.push(publication);
      publication.update?.();
      return true;
    },
  };
  if (options.refresh) {
    value.credential = {
      type: "oauth",
      refresh: options.refresh,
      access: "fake-access",
      expires: 0,
      project_id: "aicode-consumers",
    };
  }
  if (options.stored) value.stored = options.stored;
  if (options.force) value.force = options.force;
  return value;
}

test("refreshModels: offline and credential-less starts use the fallback list", async () => {
  let fetched = 0;
  const refresh = createAntigravityRefreshModels({
    fetchCatalog: async () => {
      fetched++;
      return capturedModels();
    },
  });
  const offline = await refresh(context({ allowNetwork: false, refresh: "r" }, []));
  assert.deepEqual(
    offline.map((model) => model.id),
    FALLBACK_CATALOG.models.map((model) => model.id),
  );
  await refresh(context({ allowNetwork: true }, []));
  assert.equal(fetched, 0);
  assert.equal(getActiveCatalog(), FALLBACK_CATALOG);
});

test("refreshModels: fetch, persist, reuse while fresh, refetch when stale or the credential changes", async () => {
  let now = 1_000;
  const tokens: string[] = [];
  const refresh = createAntigravityRefreshModels({
    now: () => now,
    fetchCatalog: async (token, projectId) => {
      tokens.push(`${token}@${projectId}`);
      return capturedModels();
    },
  });
  const published: ModelsPublication[] = [];
  const models = await refresh(context({ allowNetwork: true, refresh: "refresh-a" }, published));
  assert.equal(models.length, 8);
  assert.deepEqual(tokens, ["fake-access@aicode-consumers"]);
  const persisted = published[0]?.persist;
  assert.ok(persisted);
  assert.equal(getActiveCatalog().models.length, 8);
  assert.equal(JSON.stringify(persisted).includes("refresh-a"), false);
  const stored = structuredClone(persisted);

  setActiveCatalog(undefined);
  now += CATALOG_TTL_MS - 1;
  assert.equal((await refresh(context({ allowNetwork: false, stored }, []))).length, 8);
  assert.equal(
    (await refresh(context({ allowNetwork: true, refresh: "refresh-a", stored }, []))).length,
    8,
  );
  assert.equal(tokens.length, 1);
  assert.equal(getActiveCatalog().models.length, 8);

  await refresh(context({ allowNetwork: true, refresh: "refresh-b", stored }, []));
  assert.equal(tokens.length, 2);
  now += 2;
  await refresh(context({ allowNetwork: true, refresh: "refresh-a", stored }, []));
  assert.equal(tokens.length, 3);
  await refresh(context({ allowNetwork: true, refresh: "refresh-a", stored, force: true }, []));
  assert.equal(tokens.length, 4);
});

test("refreshModels: failures keep the last good catalog; aborts propagate", async () => {
  const good = createAntigravityRefreshModels({ fetchCatalog: capturedModels });
  const published: ModelsPublication[] = [];
  await good(context({ allowNetwork: true, refresh: "r" }, published));
  const stored = published[0]?.persist;
  assert.ok(stored);
  const failing = createAntigravityRefreshModels({
    fetchCatalog: async () => {
      throw new AntigravityError({ kind: "server" });
    },
  });
  const kept = await failing(
    context({ allowNetwork: true, refresh: "r", stored: structuredClone(stored) }, []),
  );
  assert.equal(kept.length, 8);
  const controller = new AbortController();
  const aborting = createAntigravityRefreshModels({
    fetchCatalog: async () => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    },
  });
  await assert.rejects(
    aborting(context({ allowNetwork: true, refresh: "r", signal: controller.signal }, [])),
    /Abort/u,
  );
});

test("refreshModels: a failed fetch never falls back to another credential's persisted catalog", async () => {
  const good = createAntigravityRefreshModels({ fetchCatalog: capturedModels });
  const published: ModelsPublication[] = [];
  await good(context({ allowNetwork: true, refresh: "refresh-a" }, published));
  const stored = published[0]?.persist;
  assert.ok(stored);
  setActiveCatalog(undefined);
  const failing = createAntigravityRefreshModels({
    fetchCatalog: async () => {
      throw new AntigravityError({ kind: "server" });
    },
  });
  const fallbackIds = FALLBACK_CATALOG.models.map((model) => model.id);
  const other = await failing(
    context({ allowNetwork: true, refresh: "refresh-b", stored: structuredClone(stored) }, []),
  );
  assert.deepEqual(
    other.map((model) => model.id),
    fallbackIds,
    "B gets the offline fallback, not A's catalog",
  );
  assert.equal(getActiveCatalog(), FALLBACK_CATALOG);
  const offlineOther = await failing(
    context({ allowNetwork: false, refresh: "refresh-b", stored: structuredClone(stored) }, []),
  );
  assert.deepEqual(
    offlineOther.map((model) => model.id),
    fallbackIds,
  );
  const same = await failing(
    context({ allowNetwork: true, refresh: "refresh-a", stored: structuredClone(stored) }, []),
  );
  assert.equal(same.length, 8, "the same credential keeps its last good catalog");
});

// --- Shared models-store slot: Pi composes the built-in google remote-catalog refresh (base) with
// this extension's refresh, and both persist into the slot `google` with replace semantics.

const HOUR_MS = 60 * 60 * 1000;
const BASE_MODEL: Model<Api> = {
  id: "gemini-base-remote",
  name: "Gemini Base Remote",
  api: "google-generative-ai",
  provider: "google",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_048_576,
  maxTokens: 65_536,
};

/** The shape the base's 200 path persists: `{ ...catalog, checkedAt }` with no foreign keys. */
function baseEntry(checkedAt: number): ModelsStoreEntry {
  return { models: [BASE_MODEL], lastModified: 1_700_000_000, etag: '"base-etag"', checkedAt };
}

async function ourEntry(checkedAt: number, refresh = "r"): Promise<AntigravityStoreEntry> {
  return {
    models: [],
    google_antigravity: {
      schema_version: 2,
      credential_key: catalogCredentialKey(refresh),
      checked_at: checkedAt,
      catalog: buildAntigravityCatalog(await capturedModels()),
    },
  };
}

function persists(published: readonly ModelsPublication[]): ModelsStoreEntry[] {
  return published.flatMap((publication) => (publication.persist ? [publication.persist] : []));
}

function withoutKey(entry: ModelsStoreEntry, key: string): string {
  return JSON.stringify(Object.fromEntries(Object.entries(entry).filter(([name]) => name !== key)));
}

test("shared slot: our cache is fresh by its own checked_at, never by the top-level checkedAt", async () => {
  const now = 10 * CATALOG_TTL_MS;
  let fetched = 0;
  const refresh = createAntigravityRefreshModels({
    now: () => now,
    fetchCatalog: async () => {
      fetched++;
      return capturedModels();
    },
  });
  const ours = await ourEntry(now - 1);
  for (const checkedAt of [0, now, now + CATALOG_TTL_MS]) {
    const stored: AntigravityStoreEntry = {
      ...baseEntry(checkedAt),
      google_antigravity: ours.google_antigravity,
    };
    const published: ModelsPublication[] = [];
    const models = await refresh(context({ allowNetwork: true, refresh: "r", stored }, published));
    assert.equal(models.length, 8);
    assert.equal(getActiveCatalog().models.length, 8);
    assert.deepEqual(persists(published), [], "a cache hit persists nothing");
  }
  assert.equal(fetched, 0);

  const stale = await ourEntry(now - CATALOG_TTL_MS);
  const stored: AntigravityStoreEntry = {
    ...baseEntry(now),
    google_antigravity: stale.google_antigravity,
  };
  await refresh(context({ allowNetwork: true, refresh: "r", stored }, []));
  assert.equal(fetched, 1, "a fresh top-level checkedAt does not keep a stale catalog");
});

test("shared slot: persisting keeps every foreign top-level field of the snapshot", async () => {
  const now = 50_000;
  const refresh = createAntigravityRefreshModels({ now: () => now, fetchCatalog: capturedModels });
  const raw = {
    ...baseEntry(12_345),
    future_field: { nested: [1, "two", null], flag: true },
    google_antigravity: (await ourEntry(now - CATALOG_TTL_MS)).google_antigravity,
  };
  const stored: ModelsStoreEntry = raw;
  const published: ModelsPublication[] = [];
  assert.equal(
    (
      await refresh(
        context({ allowNetwork: true, refresh: "r", stored: structuredClone(stored) }, published),
      )
    ).length,
    8,
  );
  const [persisted, ...rest] = persists(published);
  assert.ok(persisted);
  assert.deepEqual(rest, []);
  assert.equal(
    withoutKey(persisted, "google_antigravity"),
    withoutKey(stored, "google_antigravity"),
  );
  assert.deepEqual(Object.keys(persisted), [
    "models",
    "lastModified",
    "etag",
    "checkedAt",
    "future_field",
    "google_antigravity",
  ]);
  const next: ModelsPublication[] = [];
  let fetched = 0;
  const cached = createAntigravityRefreshModels({
    now: () => now + 1,
    fetchCatalog: async () => {
      fetched++;
      return capturedModels();
    },
  });
  assert.equal(
    (
      await cached(
        context({ allowNetwork: true, refresh: "r", stored: structuredClone(persisted) }, next),
      )
    ).length,
    8,
  );
  assert.equal(fetched, 0, "the rewritten entry is our fresh cache");
  assert.deepEqual(persists(next), []);
});

test("shared slot: a first fetch into an empty slot persists only Pi's required models field and ours", async () => {
  const now = 7_000;
  const refresh = createAntigravityRefreshModels({ now: () => now, fetchCatalog: capturedModels });
  const published: ModelsPublication[] = [];
  await refresh(context({ allowNetwork: true, refresh: "r" }, published));
  const [persisted] = persists(published);
  assert.ok(persisted);
  assert.deepEqual(Object.keys(persisted), ["models", "google_antigravity"]);
  assert.deepEqual(persisted.models, []);
  assert.equal(
    persisted.checkedAt,
    undefined,
    "the shared top-level checkedAt belongs to the base",
  );
});

interface FakeStore {
  entry: ModelsStoreEntry | undefined;
  writes: number;
}

/** One composed run: Pi snapshots the slot once, then runs the base and this refresh. */
async function composedRun(
  store: FakeStore,
  base: (context: RefreshModelsContext) => Promise<void>,
  ours: (context: RefreshModelsContext) => Promise<ProviderModelConfig[]>,
): Promise<ProviderModelConfig[]> {
  const value: RefreshModelsContext = {
    allowNetwork: true,
    signal: new AbortController().signal,
    credential: {
      type: "oauth",
      refresh: "r",
      access: "fake-access",
      expires: 0,
      project_id: "aicode-consumers",
    },
    publish: async (publication) => {
      if (publication.persist === null) store.entry = undefined;
      else if (publication.persist !== undefined) {
        store.entry = structuredClone(publication.persist);
        store.writes++;
      }
      publication.update?.();
      return true;
    },
  };
  if (store.entry) value.stored = structuredClone(store.entry);
  await base(value);
  return ours(value);
}

/** The base's freshness and persistence rules (remote-catalog-provider.js), with a fixed answer. */
function fakeBase(now: () => number, status: 200 | 304, requests: { count: number }) {
  return async (context: RefreshModelsContext): Promise<void> => {
    const stored = context.stored;
    if (
      stored?.checkedAt !== undefined &&
      stored.lastModified !== undefined &&
      now() - stored.checkedAt < CATALOG_TTL_MS
    ) {
      return;
    }
    requests.count++;
    if (status === 304 && stored && stored.models.length > 0 && stored.etag !== undefined) {
      await context.publish({ persist: { ...stored, checkedAt: now() } });
      return;
    }
    await context.publish({ persist: baseEntry(now()) });
  };
}

for (const status of [200, 304] as const) {
  test(`shared slot: composed refresh with a base that answers ${status} keeps our catalog`, async () => {
    let now = 1_000_000;
    let fetched = 0;
    const base = { count: 0 };
    const ours = createAntigravityRefreshModels({
      now: () => now,
      fetchCatalog: async () => {
        fetched++;
        return capturedModels();
      },
    });
    const store: FakeStore = { entry: undefined, writes: 0 };
    const fetchesPerRun: number[] = [];
    // Five runs inside one TTL window, then five more after both clocks expire.
    for (let run = 0; run < 10; run++) {
      if (run === 5) now += CATALOG_TTL_MS + HOUR_MS;
      else now += 60_000;
      setActiveCatalog(undefined);
      const before = fetched;
      const models = await composedRun(
        store,
        fakeBase(() => now, status, base),
        ours,
      );
      fetchesPerRun.push(fetched - before);
      assert.equal(models.length, 8, `run ${run} serves the live catalog, not the fallback`);
      assert.equal(getActiveCatalog().models.length, 8);
    }
    // Run 0 fetches into an empty slot and its write replaces the base's same-run 200. With a 200,
    // run 1's base refetch drops our key (we serve the snapshot), run 2 refetches and merges with
    // the base's entry, and the slot is then stable; the same two-run settle repeats once per
    // expired window. With a 304 the base keeps our key, so only expiry costs a fetch.
    assert.deepEqual(
      fetchesPerRun,
      status === 200 ? [1, 0, 1, 0, 0, 1, 0, 1, 0, 0] : [1, 0, 1, 0, 0, 1, 0, 0, 0, 0],
    );
    const entry = store.entry;
    assert.ok(entry);
    assert.deepEqual(entry.models, [BASE_MODEL], "the base's catalog survives in the slot");
    assert.equal(entry.etag, '"base-etag"');
    assert.ok(Object.hasOwn(entry, "google_antigravity"), "our catalog survives in the slot");
  });
}

test("legacy entry: offline and on failure it serves its catalog; online it refetches and migrates", async () => {
  const now = 3 * CATALOG_TTL_MS;
  const catalog = buildAntigravityCatalog(await capturedModels());
  const raw = {
    ...baseEntry(now),
    google_antigravity: { schema_version: 1, credential_key: catalogCredentialKey("r"), catalog },
  };
  const legacy: ModelsStoreEntry = raw;
  let fetched = 0;
  let fail = true;
  const refresh = createAntigravityRefreshModels({
    now: () => now,
    fetchCatalog: async () => {
      fetched++;
      if (fail) throw new AntigravityError({ kind: "server" });
      return capturedModels();
    },
  });
  const offline: ModelsPublication[] = [];
  assert.equal(
    (await refresh(context({ allowNetwork: false, stored: structuredClone(legacy) }, offline)))
      .length,
    8,
  );
  assert.equal(fetched, 0);
  const failed: ModelsPublication[] = [];
  assert.equal(
    (
      await refresh(
        context({ allowNetwork: true, refresh: "r", stored: structuredClone(legacy) }, failed),
      )
    ).length,
    8,
    "a legacy catalog stays the fallback for its credential",
  );
  assert.equal(fetched, 1, "a legacy entry is stale even with a fresh top-level checkedAt");
  assert.deepEqual([...persists(offline), ...persists(failed)], []);

  fail = false;
  const migrated: ModelsPublication[] = [];
  await refresh(
    context({ allowNetwork: true, refresh: "r", stored: structuredClone(legacy) }, migrated),
  );
  assert.equal(fetched, 2);
  const [persisted] = persists(migrated);
  assert.ok(persisted);
  assert.equal(
    withoutKey(persisted, "google_antigravity"),
    withoutKey(legacy, "google_antigravity"),
  );
  assert.equal(
    JSON.stringify(Object.entries(persisted).find(([name]) => name === "google_antigravity")?.[1]),
    JSON.stringify({
      schema_version: 2,
      credential_key: catalogCredentialKey("r"),
      checked_at: now,
      catalog,
    }),
  );
});
