import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@earendil-works/pi-schema";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSyntheticProviderModelsFromApi,
  buildSyntheticProviderModelsFromStore,
} from "../extensions/provider/models.ts";
import { persistModels, readStoredModels } from "../extensions/provider/refresh-store-compat.ts";
import {
  shouldActivateWebSearch,
  syncToolActivation,
} from "../extensions/web-search/activation.ts";
import { CountTokensResponseSchema, countSyntheticTokens } from "./client/count-tokens.ts";
import { SyntheticClient } from "./client/synthetic-client.ts";
import { isSyntheticApiModel, isSyntheticSearchResponse } from "./client/types.ts";
import { parseErrorMessage } from "./client/utils.ts";
import {
  isSyntheticConfigUpdatedPayload,
  isSyntheticExtensionsRegisterPayload,
} from "./config-events.ts";
import * as config from "./config.ts";
import { QuotaHistory } from "./services/quota-history.ts";
import {
  isQuotasResponse,
  isSyntheticQuotasReadPayload,
  isSyntheticQuotasRequestEventPayload,
  isSyntheticQuotasUpdatedPayload,
  parseQuotaHeader,
} from "./types/quotas.ts";
import { detectBillingMode } from "./utils/quotas.ts";

const resolvedConfig = {
  configVersion: "1.0.0",
  webSearch: true,
  quotasCommand: true,
  usageStatus: true,
  quotaWarnings: false,
  subBarIntegration: true,
  proxyUrl: "",
  proxyRequiresAuth: false,
};

const weekly = {
  nextRegenAt: "2026-07-06T00:00:00.000Z",
  percentRemaining: 50,
  maxCredits: "$15.12",
  remainingCredits: "$8.00",
  nextRegenCredits: "$2.16",
};

const rolling = {
  nextTickAt: "2026-07-06T00:00:00.000Z",
  tickPercent: 2,
  remaining: 10,
  max: 100,
  limited: false,
};

const apiModel = {
  id: "hf:vendor/model",
  name: "vendor/model",
  input_modalities: ["text"],
  output_modalities: ["text"],
  context_length: 1000,
  max_output_length: 100,
  pricing: {
    prompt: "$0.000001",
    completion: "$0.000002",
    input_cache_reads: "$0.0000001",
    input_cache_writes: "$0",
  },
};

describe("config event payloads (open objects)", () => {
  it("accepts a resolved config and keeps unknown keys allowed", () => {
    expect(isSyntheticConfigUpdatedPayload({ config: resolvedConfig })).toBe(true);
    expect(isSyntheticConfigUpdatedPayload({ config: { ...resolvedConfig, extra: 1 }, x: 2 })).toBe(
      true,
    );
    expect(config.isSyntheticConfigUpdatedPayload({ config: resolvedConfig })).toBe(true);
  });

  it("rejects wrong types, missing keys, arrays and non-objects", () => {
    expect(
      isSyntheticConfigUpdatedPayload({ config: { ...resolvedConfig, webSearch: "yes" } }),
    ).toBe(false);
    expect(
      isSyntheticConfigUpdatedPayload({ config: { ...resolvedConfig, proxyUrl: undefined } }),
    ).toBe(false);
    expect(isSyntheticConfigUpdatedPayload({})).toBe(false);
    expect(isSyntheticConfigUpdatedPayload([])).toBe(false);
    expect(isSyntheticConfigUpdatedPayload(null)).toBe(false);
    expect(isSyntheticConfigUpdatedPayload(undefined)).toBe(false);
  });

  it("validates feature ids as an enum", () => {
    expect(isSyntheticExtensionsRegisterPayload({ feature: "usageStatus", more: true })).toBe(true);
    expect(isSyntheticExtensionsRegisterPayload({ feature: "other" })).toBe(false);
    expect(isSyntheticExtensionsRegisterPayload({ feature: 1 })).toBe(false);
    expect(config.isSyntheticExtensionsRegisterPayload({ feature: "quotaWarnings" })).toBe(true);
    expect(config.isSyntheticExtensionsRegisterPayload({ feature: "nope" })).toBe(false);
  });
});

describe("quotas response", () => {
  it("accepts optional, null and open shapes", () => {
    expect(isQuotasResponse({})).toBe(true);
    expect(isQuotasResponse({ unknownWindow: 1 })).toBe(true);
    expect(isQuotasResponse({ subscription: null, search: null, freeToolCalls: null })).toBe(true);
    expect(isQuotasResponse({ subscription: undefined })).toBe(true);
    expect(
      isQuotasResponse({
        subscription: { limit: 1, requests: 0, renewsAt: "x", extra: true },
        search: { hourly: null },
        weeklyTokenLimit: weekly,
        rollingFiveHourLimit: rolling,
      }),
    ).toBe(true);
  });

  it("rejects wrong member types, arrays and non-objects", () => {
    expect(isQuotasResponse({ subscription: { limit: "1", requests: 0, renewsAt: "x" } })).toBe(
      false,
    );
    expect(isQuotasResponse({ rollingFiveHourLimit: { ...rolling, limited: "no" } })).toBe(false);
    expect(isQuotasResponse({ weeklyTokenLimit: { ...weekly, maxCredits: 5 } })).toBe(false);
    expect(isQuotasResponse({ search: { hourly: 3 } })).toBe(false);
    expect(isQuotasResponse([])).toBe(false);
    expect(isQuotasResponse("{}")).toBe(false);
    expect(isQuotasResponse(null)).toBe(false);
  });

  it("keeps rejecting NaN and Infinity as TypeBox Number did", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(isQuotasResponse({ rollingFiveHourLimit: { ...rolling, remaining: bad } })).toBe(
        false,
      );
      expect(isQuotasResponse({ weeklyTokenLimit: { ...weekly, percentRemaining: bad } })).toBe(
        false,
      );
    }
    expect(isQuotasResponse({ rollingFiveHourLimit: { ...rolling, max: Number.MAX_VALUE } })).toBe(
      true,
    );
  });

  it("parseQuotaHeader applies the same validation", () => {
    const headers = {
      "X-Synthetic-Quotas": JSON.stringify({ weeklyTokenLimit: weekly, extra: 1 }),
    };
    expect(parseQuotaHeader(headers)).toEqual({ weeklyTokenLimit: weekly, extra: 1 });
    expect(parseQuotaHeader({ "x-synthetic-quotas": JSON.stringify({ subscription: 1 }) })).toBe(
      undefined,
    );
    expect(parseQuotaHeader({ "x-synthetic-quotas": "not json" })).toBe(undefined);
  });

  it("detectBillingMode treats a valid window as subscription and malformed ones as PAYG", () => {
    expect(detectBillingMode({ weeklyTokenLimit: weekly })).toBe("subscription");
    expect(detectBillingMode({ rollingFiveHourLimit: rolling })).toBe("subscription");
    expect(detectBillingMode({ subscription: { limit: 1, requests: 1, renewsAt: "x" } })).toBe(
      "subscription",
    );
    expect(
      detectBillingMode({ weeklyTokenLimit: { ...weekly, percentRemaining: Number.NaN } }),
    ).toBe("pay-as-you-go");
    expect(detectBillingMode({})).toBe("pay-as-you-go");
    expect(detectBillingMode(undefined)).toBe("pay-as-you-go");
  });
});

describe("quota snapshot and callback payloads", () => {
  const snapshot = {
    quotas: { weeklyTokenLimit: weekly },
    source: "api",
    updatedAt: 1_700_000_000_000,
  };

  it("validates updated payloads (open, finite updatedAt, source enum)", () => {
    expect(isSyntheticQuotasUpdatedPayload(snapshot)).toBe(true);
    expect(isSyntheticQuotasUpdatedPayload({ ...snapshot, source: "header", extra: 1 })).toBe(true);
    expect(isSyntheticQuotasUpdatedPayload({ ...snapshot, source: "cache" })).toBe(false);
    expect(isSyntheticQuotasUpdatedPayload({ ...snapshot, updatedAt: Number.NaN })).toBe(false);
    expect(
      isSyntheticQuotasUpdatedPayload({ ...snapshot, updatedAt: Number.POSITIVE_INFINITY }),
    ).toBe(false);
    expect(isSyntheticQuotasUpdatedPayload({ quotas: {}, source: "api" })).toBe(false);
  });

  it("read payload needs a callable respond", () => {
    expect(isSyntheticQuotasReadPayload({ respond: () => undefined })).toBe(true);
    expect(isSyntheticQuotasReadPayload({ respond: () => undefined, extra: 1 })).toBe(true);
    expect(isSyntheticQuotasReadPayload({ respond: "fn" })).toBe(false);
    expect(isSyntheticQuotasReadPayload({ respond: undefined })).toBe(false);
    expect(isSyntheticQuotasReadPayload({})).toBe(false);
    expect(isSyntheticQuotasReadPayload(null)).toBe(false);
    expect(isSyntheticQuotasReadPayload(undefined)).toBe(false);
    expect(isSyntheticQuotasReadPayload([])).toBe(false);
    expect(isSyntheticQuotasReadPayload(() => undefined)).toBe(false);
  });

  it("request payload allows undefined, an empty object, respond null/undefined/function", () => {
    expect(isSyntheticQuotasRequestEventPayload(undefined)).toBe(true);
    expect(isSyntheticQuotasRequestEventPayload({})).toBe(true);
    expect(isSyntheticQuotasRequestEventPayload({ respond: null })).toBe(true);
    expect(isSyntheticQuotasRequestEventPayload({ respond: undefined })).toBe(true);
    expect(isSyntheticQuotasRequestEventPayload({ respond: () => undefined, extra: 1 })).toBe(true);
    expect(isSyntheticQuotasRequestEventPayload({ respond: 1 })).toBe(false);
    expect(isSyntheticQuotasRequestEventPayload(null)).toBe(false);
    expect(isSyntheticQuotasRequestEventPayload([])).toBe(false);
    expect(isSyntheticQuotasRequestEventPayload("x")).toBe(false);
  });
});

describe("client response schemas", () => {
  it("count_tokens requires a finite non-negative integer and allows extra keys", () => {
    const check = compile(CountTokensResponseSchema).check;
    expect(check({ input_tokens: 0 })).toBe(true);
    expect(check({ input_tokens: 12, extra: true })).toBe(true);
    expect(check({ input_tokens: -1 })).toBe(false);
    expect(check({ input_tokens: 1.5 })).toBe(false);
    expect(check({ input_tokens: Number.NaN })).toBe(false);
    expect(check({ input_tokens: Number.POSITIVE_INFINITY })).toBe(false);
    expect(check({ input_tokens: "3" })).toBe(false);
    expect(check({})).toBe(false);
  });

  it("countSyntheticTokens reports malformed for an invalid body", async () => {
    const result = await countSyntheticTokens({
      apiKey: "k",
      model: "m",
      system: "s",
      promptText: "p",
      fetch: async () => new Response(JSON.stringify({ input_tokens: -3 }), { status: 200 }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("malformed");
  });

  it("search response keeps unknown keys and rejects missing result members", () => {
    const result = { url: "u", title: "t", text: "x", published: "p" };
    expect(isSyntheticSearchResponse({ results: [result], extra: 1 })).toBe(true);
    expect(isSyntheticSearchResponse({ results: [{ ...result, extra: 1 }] })).toBe(true);
    expect(isSyntheticSearchResponse({ results: [] })).toBe(true);
    expect(isSyntheticSearchResponse({ results: [{ url: "u" }] })).toBe(false);
    expect(isSyntheticSearchResponse({})).toBe(false);
    expect(isSyntheticSearchResponse([])).toBe(false);
  });

  it("API model: optional/union members and finite numbers", () => {
    expect(isSyntheticApiModel(apiModel)).toBe(true);
    expect(isSyntheticApiModel({ ...apiModel, extra: 1, provider: { a: 1 } })).toBe(true);
    expect(isSyntheticApiModel({ ...apiModel, supported_features: "reasoning" })).toBe(true);
    expect(isSyntheticApiModel({ ...apiModel, supported_features: ["reasoning"] })).toBe(true);
    expect(isSyntheticApiModel({ ...apiModel, supported_features: 3 })).toBe(false);
    expect(isSyntheticApiModel({ ...apiModel, reasoning_parameters: null })).toBe(true);
    expect(
      isSyntheticApiModel({ ...apiModel, reasoning_parameters: { efforts: ["low", 1] } }),
    ).toBe(true);
    expect(isSyntheticApiModel({ ...apiModel, reasoning_parameters: { efforts: "low" } })).toBe(
      false,
    );
    expect(isSyntheticApiModel({ ...apiModel, context_length: Number.NaN })).toBe(false);
    expect(isSyntheticApiModel({ ...apiModel, pricing: { prompt: "1" } })).toBe(false);
    expect(isSyntheticApiModel({ ...apiModel, input_modalities: [1] })).toBe(false);
  });

  it("SyntheticClient.models rejects an invalid models envelope", async () => {
    const client = new SyntheticClient({ apiKey: "k" });
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ data: "nope" }), { status: 200 });
    try {
      await expect(client.models()).rejects.toThrow("invalid response");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("parseErrorMessage uses a string error member and falls back to the body otherwise", async () => {
    expect(await parseErrorMessage(new Response(JSON.stringify({ error: "boom", extra: 1 })))).toBe(
      "boom",
    );
    expect(await parseErrorMessage(new Response(JSON.stringify({ error: 5 })))).toBe('{"error":5}');
    expect(await parseErrorMessage(new Response(JSON.stringify({})))).toBe("{}");
    expect(await parseErrorMessage(new Response(JSON.stringify([])))).toBe("[]");
    expect(await parseErrorMessage(new Response("plain text"))).toBe("plain text");
  });
});

describe("model catalog validators", () => {
  it("buildSyntheticProviderModelsFromApi accepts valid entries and names invalid ones", () => {
    const [model] = buildSyntheticProviderModelsFromApi([{ ...apiModel, extra: true }]);
    expect(model.id).toBe(apiModel.id);
    expect(() => buildSyntheticProviderModelsFromApi([{ ...apiModel, name: 3 }])).toThrow(
      `Synthetic API returned invalid model entry "${apiModel.id}"`,
    );
    expect(() => buildSyntheticProviderModelsFromApi([{ ...apiModel, id: "" }])).toThrow(
      'invalid model entry ""',
    );
    expect(() => buildSyntheticProviderModelsFromApi([null])).toThrow('invalid model entry "0"');
    expect(() => buildSyntheticProviderModelsFromApi([{ id: 9 }])).toThrow(
      'invalid model entry "9"',
    );
  });

  it("efforts drop non-string and empty entries", () => {
    const [model] = buildSyntheticProviderModelsFromApi([
      {
        ...apiModel,
        reasoning_parameters: { efforts: ["low", "", 7, null, "high"] },
      },
    ]);
    expect(model.thinkingLevelMap?.low).toBe("low");
    expect(model.thinkingLevelMap?.high).toBe("high");
    expect(model.thinkingLevelMap?.medium).toBe(null);
  });

  const stored = {
    id: "hf:vendor/model",
    name: "vendor/model",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };

  it("stored models: open objects, non-empty id/input, finite numbers, enum inputs", () => {
    expect(buildSyntheticProviderModelsFromStore([{ ...stored, extra: 1 }])).toHaveLength(1);
    for (const bad of [
      { ...stored, id: "" },
      { ...stored, input: [] },
      { ...stored, input: ["audio"] },
      { ...stored, reasoning: "no" },
      { ...stored, maxTokens: Number.NaN },
      { ...stored, cost: { ...stored.cost, input: Number.POSITIVE_INFINITY } },
      { ...stored, cost: { input: 1 } },
    ]) {
      expect(() => buildSyntheticProviderModelsFromStore([bad])).toThrow(
        "Synthetic model store contains invalid entry",
      );
    }
    expect(() => buildSyntheticProviderModelsFromStore([{ id: 4 }])).toThrow('entry "4"');
  });
});

describe("models store entry", () => {
  // Object.assign widens the typed base context with deliberately off-contract members.
  function contextWith<Extra extends object>(extra: Extra): RefreshModelsContext & Extra {
    const base: RefreshModelsContext = {
      allowNetwork: true,
      signal: new AbortController().signal,
      publish: async () => true,
    };
    return Object.assign(base, extra);
  }

  it("readStoredModels accepts open entries with optional null members", async () => {
    const entry = { models: [{ any: 1 }], lastModified: null, checkedAt: 5, etag: "e", extra: 1 };
    expect(await readStoredModels(contextWith({ stored: entry }))).toEqual(entry);
    expect(await readStoredModels(contextWith({ stored: { models: [] } }))).toEqual({ models: [] });
  });

  it("readStoredModels rejects malformed entries", async () => {
    for (const stored of [
      { models: "x" },
      { models: [], checkedAt: "5" },
      { models: [], checkedAt: Number.NaN },
      { models: [], etag: 5 },
      [],
      null,
    ]) {
      expect(await readStoredModels(contextWith({ stored }))).toBe(undefined);
    }
  });

  it("readStoredModels validates legacy store reads", async () => {
    const good = { models: [], checkedAt: 1 };
    expect(
      await readStoredModels(
        contextWith({ store: { read: async () => good, write: async () => 0 } }),
      ),
    ).toEqual(good);
    expect(
      await readStoredModels(
        contextWith({ store: { read: async () => ({ models: 1 }), write: async () => 0 } }),
      ),
    ).toBe(undefined);
  });

  it("persistModels requires a boolean true publish result and a valid entry", async () => {
    const entry = { models: [], checkedAt: 1 };
    expect(await persistModels(contextWith({ publish: async () => true }), entry)).toBe(true);
    expect(await persistModels(contextWith({ publish: async () => false }), entry)).toBe(false);
    expect(await persistModels(contextWith({ publish: async () => "yes" }), entry)).toBe(false);
  });
});

describe("web-search prefix lock guard", () => {
  const key = Symbol.for("choco-pi.prefix.locked");
  const host = (calls: string[][]) => ({
    getAllTools: () => [{ name: "synthetic_web_search" }],
    getActiveTools: () => [],
    setActiveTools: (names: string[]) => {
      calls.push(names);
    },
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, key);
  });

  it("skips activation only when a lock object reports locked", () => {
    const calls: string[][] = [];
    Object.defineProperty(globalThis, key, { value: { isLocked: () => true }, configurable: true });
    syncToolActivation(host(calls), true);
    expect(calls).toEqual([]);

    Reflect.deleteProperty(globalThis, key);
    for (const value of [{ isLocked: () => false }, { isLocked: 1 }, {}, null, [], () => true]) {
      Object.defineProperty(globalThis, key, { value, configurable: true });
      syncToolActivation(host(calls), true);
    }
    expect(calls).toHaveLength(6);
    expect(shouldActivateWebSearch(true, "subscription")).toBe(true);
  });
});

describe("quota history lines", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("loads only well-formed windows and tolerates unknown keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-synthetic-schema-"));
    directories.push(root);
    const now = Date.parse("2026-07-05T12:00:00.000Z");
    const recordedAt = new Date(now - 1000).toISOString();
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "2026-07-05.jsonl"),
      [
        JSON.stringify({
          version: 1,
          recordedAt,
          extra: 1,
          quotas: { weeklyTokenLimit: weekly, other: 1 },
        }),
        JSON.stringify({
          version: 1,
          recordedAt,
          quotas: { weeklyTokenLimit: { ...weekly, percentRemaining: "50" } },
        }),
        JSON.stringify({
          version: 1,
          recordedAt,
          quotas: {
            weeklyTokenLimit: { ...weekly, percentRemaining: "50" },
            rollingFiveHourLimit: rolling,
          },
        }),
        JSON.stringify({ version: 2, recordedAt, quotas: { weeklyTokenLimit: weekly } }),
        JSON.stringify({ version: 1, recordedAt: 5, quotas: { weeklyTokenLimit: weekly } }),
        JSON.stringify({ version: 1, recordedAt, quotas: null }),
        JSON.stringify([]),
      ].join("\n"),
    );
    const history = new QuotaHistory({ directory: root, now: () => now });
    await history.initialize();
    const snapshots = history.getSnapshots();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].quotas.weeklyTokenLimit?.remainingCredits).toBe("$8.00");
    expect(snapshots[1].quotas.weeklyTokenLimit).toBe(undefined);
    expect(snapshots[1].quotas.rollingFiveHourLimit?.remaining).toBe(10);
  });
});
