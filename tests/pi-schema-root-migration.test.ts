import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { compile, int, obj, opt, str } from "@earendil-works/pi-schema";
import {
  readNativeContextWindow,
  NATIVE_CONTEXT_WINDOW_KEY,
} from "../.pi/extensions/lib/context-policy.ts";
import {
  createProcessSources,
  SHELL_MANAGER_SYMBOL,
  SUBAGENT_REGISTRY_SYMBOL,
} from "../.pi/extensions/lib/host-bridge/sources.ts";
import { hostParams } from "../.pi/extensions/lib/schema-bridge.ts";
import { loadModelFallbacks, MODEL_FALLBACKS_FILE } from "../.pi/extensions/lib/usage-limit.ts";
import {
  isString,
  type JsonRecord,
  type JsonValue,
  type RuntimeValue,
} from "../.pi/extensions/lib/runtime-values.ts";

type FallbackFile = JsonRecord | string;
import {
  parseSubagentUsageLimit,
  parseUsageLimitPendingEntry,
} from "../.pi/extensions/lib/usage-limit-contract.ts";

describe("loadModelFallbacks (replaces three Value.Check + Value.Parse sites)", () => {
  const base = {
    tiers: { workhorse: { primary: ["anthropic/a"], secondary: ["openai-codex/b"] } },
    lastResort: ["synthetic/c"],
  };
  const directories: string[] = [];

  async function fixture(baseValue: FallbackFile, overrideValue?: FallbackFile) {
    const root = await mkdtemp(join(tmpdir(), "choco-pi-fallbacks-"));
    directories.push(root);
    const basePath = join(root, "base.json");
    const stringify = (value: FallbackFile) => (isString(value) ? value : JSON.stringify(value));
    await writeFile(basePath, stringify(baseValue));
    if (overrideValue !== undefined) {
      await writeFile(join(root, MODEL_FALLBACKS_FILE), stringify(overrideValue));
    }
    return { agentDir: root, basePath };
  }

  afterEach(async () => {
    for (const directory of directories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns the base table unchanged: Parse was a no-op after Check on a closed schema", async () => {
    const { agentDir, basePath } = await fixture(base);
    assert.deepEqual(await loadModelFallbacks(agentDir, basePath), base);
  });

  it("merges a valid override over the base table", async () => {
    const override = { tiers: { fast: { primary: ["x/y"] } }, lastResort: ["z/w"] };
    const { agentDir, basePath } = await fixture(base, override);
    assert.deepEqual(await loadModelFallbacks(agentDir, basePath), {
      tiers: { ...base.tiers, ...override.tiers },
      lastResort: ["z/w"],
    });
  });

  it("an empty override keeps the base; an override tier replaces the base tier of that name", async () => {
    const empty = await fixture(base, {});
    assert.deepEqual(await loadModelFallbacks(empty.agentDir, empty.basePath), base);
    const replace = await fixture(base, { tiers: { workhorse: { primary: ["q/r"] } } });
    assert.deepEqual((await loadModelFallbacks(replace.agentDir, replace.basePath)).tiers, {
      workhorse: { primary: ["q/r"] },
    });
  });

  it("rejects an unknown key (closed objects), a wrong type, and a malformed override", async () => {
    const extra = await fixture({ ...base, surprise: 1 });
    await assert.rejects(
      loadModelFallbacks(extra.agentDir, extra.basePath),
      /Invalid model fallback table/,
    );
    const wrongType = await fixture({ ...base, lastResort: "synthetic/c" });
    await assert.rejects(
      loadModelFallbacks(wrongType.agentDir, wrongType.basePath),
      /Invalid model fallback table/,
    );
    const nestedExtra = await fixture({
      ...base,
      tiers: { workhorse: { primary: [], surprise: true } },
    });
    await assert.rejects(
      loadModelFallbacks(nestedExtra.agentDir, nestedExtra.basePath),
      /Invalid model fallback table/,
    );
    const badOverride = await fixture(base, { lastResort: [1] });
    await assert.rejects(
      loadModelFallbacks(badOverride.agentDir, badOverride.basePath),
      /Invalid model fallback override/,
    );
    const unknownOverride = await fixture(base, { other: [] });
    await assert.rejects(
      loadModelFallbacks(unknownOverride.agentDir, unknownOverride.basePath),
      /Invalid model fallback override/,
    );
  });
});

describe("hostParams registration bridge", () => {
  const schema = obj(
    { name: str({ description: "n" }), limit: opt(int({ minimum: 1 })) },
    { open: true },
  );

  it("keeps the pi-schema JSON Schema as the host-facing parameters object", () => {
    const wrapped = hostParams(schema);
    assert.equal(Object.getOwnPropertyDescriptor(wrapped, "type")?.value, "object");
    assert.deepEqual(Object.getOwnPropertyDescriptor(wrapped, "required")?.value, ["name"]);
    assert.equal(
      Object.getOwnPropertyDescriptor(wrapped, "additionalProperties")?.value !== false,
      true,
    );
  });

  it("validates as before: required, bounds, optional absent, extra keys allowed", () => {
    const check = compile(hostParams(schema)).check;
    assert.equal(check({ name: "a" }), true);
    assert.equal(check({ name: "a", limit: 2, extra: 1 }), true);
    assert.equal(check({ limit: 2 }), false);
    assert.equal(check({ name: "a", limit: 0 }), false);
    assert.equal(check({ name: "a", limit: 1.5 }), false);
  });
});

describe("source guards (function members are predicates, data is pi-schema)", () => {
  const symbols = [SUBAGENT_REGISTRY_SYMBOL, SHELL_MANAGER_SYMBOL];
  afterEach(() => {
    for (const symbol of symbols) Reflect.deleteProperty(globalThis, symbol);
  });

  function publish(symbol: symbol, value: RuntimeValue): void {
    Object.defineProperty(globalThis, symbol, { value, configurable: true });
  }

  const record = (id: string, extra: JsonRecord = {}) => ({
    id,
    type: "general",
    description: "d",
    status: "running",
    toolUses: 0,
    startedAt: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    ...extra,
  });
  const registry = (records: JsonRecord[], overrides: { stop?: JsonValue } = {}) => ({
    getAllRecords: () => records,
    stop: () => true,
    isChildSessionContext: () => false,
    isChildSessionId: () => false,
    ...overrides,
  });

  it("a registry missing a function member is unavailable; a complete one is available", () => {
    publish(SUBAGENT_REGISTRY_SYMBOL, registry([], { stop: "not a function" }));
    assert.equal(createProcessSources().subagents("root", () => true).available, false);
    publish(SUBAGENT_REGISTRY_SYMBOL, registry([]));
    assert.equal(createProcessSources().subagents("root", () => true).available, true);
  });

  it("records are open: unknown keys pass; a missing required field or wrong type is skipped", () => {
    publish(
      SUBAGENT_REGISTRY_SYMBOL,
      registry([
        record("ok", { unknownKey: { nested: true } }),
        record("optional-wrong", { completedAt: "later" }),
        { ...record("missing"), lifetimeUsage: undefined },
        record("ok-optional", { completedAt: 5, spawnModel: { provider: "p", id: "m", extra: 1 } }),
      ]),
    );
    const ids = createProcessSources()
      .subagents("root", () => true)
      .records()
      .map((entry) => entry.id);
    assert.deepEqual(ids, ["ok", "ok-optional"]);
  });

  it("shell list results are open; entries missing a field make the list empty", () => {
    const shell = (overrides: JsonRecord = {}) => ({
      shellId: "s1",
      ownerId: "root",
      command: "echo",
      cwd: "/",
      state: "running",
      startedAt: 1,
      ...overrides,
    });
    const manager = (listed: JsonRecord) => ({
      list: () => listed,
      read: () => ({ stdout: { endOffset: 1 }, stderr: { endOffset: 2, extra: true } }),
      stop: () => undefined,
      toolCallIdOf: () => null,
    });
    publish(SHELL_MANAGER_SYMBOL, manager({ shells: [shell({ extra: 1 })], more: true }));
    const source = createProcessSources().shells("root");
    assert.equal(source.shells().length, 1);
    assert.equal(source.bytes("s1"), 3);
    publish(SHELL_MANAGER_SYMBOL, manager({ shells: [shell({ command: undefined })] }));
    assert.deepEqual(createProcessSources().shells("root").shells(), []);
  });
});

describe("usage-limit contract validators keep open objects", () => {
  it("accepts unknown keys, rejects wrong types and missing required fields", () => {
    const pending = {
      recoveryId: "r",
      modelId: "m",
      provider: "p",
      accountId: "a",
      attempts: 1,
    };
    assert.deepEqual(parseUsageLimitPendingEntry({ ...pending, future: true }), {
      ...pending,
      future: true,
    });
    assert.equal(parseUsageLimitPendingEntry({ ...pending, attempts: "1" }), undefined);
    assert.equal(parseUsageLimitPendingEntry({ ...pending, recoveryId: undefined }), undefined);
    assert.equal(parseUsageLimitPendingEntry(null), undefined);
    const limit = { provider: "p", accountId: "a", kind: "quota", status: "reported" };
    assert.deepEqual(parseSubagentUsageLimit(limit), limit);
    assert.equal(parseSubagentUsageLimit({ ...limit, kind: "other" }), undefined);
  });
});

describe("native context window record", () => {
  it("requires positive integers on both fields; extra keys are tolerated", () => {
    const model = (record: JsonRecord, contextWindow = 100) =>
      Object.defineProperty({ contextWindow }, NATIVE_CONTEXT_WINDOW_KEY, {
        value: record,
        enumerable: true,
      });
    assert.equal(readNativeContextWindow(model({ native: 200, applied: 100, extra: 1 })), 200);
    assert.equal(readNativeContextWindow(model({ native: 200.5, applied: 100 })), undefined);
    assert.equal(readNativeContextWindow(model({ native: 0, applied: 100 })), undefined);
    assert.equal(readNativeContextWindow(model({ native: 200 })), undefined);
  });
});
