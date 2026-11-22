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
import { CATALOG_TTL_MS, createAntigravityRefreshModels } from "../src/catalog/refresh.ts";
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

test("27 agent runtime ids collapse to 11 base models with advertised levels only", async () => {
  const catalog = buildAntigravityCatalog(await capturedModels());
  const levels = Object.fromEntries(
    catalog.models.map((model) => [model.id, model.variants.map((variant) => variant.level)]),
  );
  assert.deepEqual(levels, {
    "gemini-4-neon": ["low", "medium", "high", "xhigh"],
    "gemini-4-carbon": ["low", "medium", "high"],
    "gemini-4-argon": ["low", "medium", "high"],
    "gemini-4-hydrogen": ["low", "medium", "high", "xhigh"],
    "gemini-pro-orchestrator-neon": ["xhigh"],
    "gemini-pro-orchestrator": ["high"],
    "gemini-pro-orchestrator-argon": ["high"],
    "gemini-3.8-flash": ["low", "medium", "high"],
    "claude-opus-5-5": ["low", "medium", "high"],
    "claude-sonnet-5-5": ["low", "medium", "high"],
    "gpt-oss-120b": ["medium"],
  });
  assert.equal(
    catalog.models.reduce((count, model) => count + model.variants.length, 0),
    27,
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
  assert.deepEqual(supported["gemini-pro-orchestrator-neon"], ["xhigh"]);
  for (const config of models) assert.equal(config.api, "google-generative-ai");
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
  assert.equal(models.length, 11);
  assert.deepEqual(tokens, ["fake-access@aicode-consumers"]);
  const persisted = published[0]?.persist;
  assert.ok(persisted);
  assert.equal(getActiveCatalog().models.length, 11);
  assert.equal(JSON.stringify(persisted).includes("refresh-a"), false);
  const stored = structuredClone(persisted);

  setActiveCatalog(undefined);
  now += CATALOG_TTL_MS - 1;
  assert.equal((await refresh(context({ allowNetwork: false, stored }, []))).length, 11);
  assert.equal(
    (await refresh(context({ allowNetwork: true, refresh: "refresh-a", stored }, []))).length,
    11,
  );
  assert.equal(tokens.length, 1);
  assert.equal(getActiveCatalog().models.length, 11);

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
  assert.equal(kept.length, 11);
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
  assert.equal(same.length, 11, "the same credential keeps its last good catalog");
});
