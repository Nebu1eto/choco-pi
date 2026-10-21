import assert from "node:assert/strict";
import test from "node:test";
import {
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  createExtensionRuntime,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../src/adapter/activation/config.ts";
import type { AdapterState } from "../src/adapter/activation/state.ts";
import { codexBackgroundAccountScope } from "../src/adapter/compaction/background-v2.ts";
import { resolveLatestNativeCompactionEntry } from "../src/adapter/compaction/details-store.ts";
import { serializeActiveSessionToResponsesInput } from "../src/adapter/compaction/serializer.ts";
import {
  createNativeCompactionDetails,
  type NativeCompactionDetails,
} from "../src/adapter/compaction/types.ts";
import {
  CodexRequestRefusedError,
  rewriteCodexProviderRequest,
} from "../src/adapter/provider-request.ts";
import { createCodexTurnState } from "../src/providers/openai-codex/turn-state.ts";
import {
  type LaneRecord,
  LaneRecordSchema,
} from "../../choco-pi-compaction/src/background/lane-journal.ts";
import { OPAQUE_GUARD_NOTICE } from "../../choco-pi-compaction/src/opaque-checkpoint.ts";

const model: Model<"openai-codex-responses"> = {
  id: "gpt-6-luna",
  name: "Fixture",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 2048,
};

function tokenFor(id: string): string {
  return `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.fixture`;
}

const InputBodySchema = Type.Object(
  {
    input: Type.Array(
      Type.Object({ type: Type.Optional(Type.String()) }, { additionalProperties: true }),
    ),
  },
  { additionalProperties: true },
);

function nativeDetails(background: { readonly account?: string }): NativeCompactionDetails {
  const details = createNativeCompactionDetails({
    provider: model.provider,
    api: model.api,
    model: model.id,
    baseUrl: model.baseUrl,
    compactedWindow: [{ type: "compaction", encrypted_content: "SYNTHETIC-OPAQUE" }],
  });
  if (background.account === undefined) return details;
  return {
    ...details,
    schemaVersion: 1,
    candidateId: "fixture-candidate",
    prefixFingerprint: "fixture-fingerprint",
    background: {
      sessionId: "fixture-session",
      ownerKey: "main-session:fixture-session",
      ownerGeneration: 1,
      cutEntryId: "fixture-cut",
      retentionPolicyVersion: 1,
      providerScope: {
        provider: model.provider,
        baseUrl: model.baseUrl,
        model: model.id,
        authMode: "oauth",
        accountScope: codexBackgroundAccountScope(background.account),
      },
    },
  };
}

async function fixture(options: { readonly checkpointAccount?: string; readonly account: string }) {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(model.provider, async () => ({
    type: "oauth",
    access: tokenFor(options.account),
    refresh: "synthetic-unused-refresh",
    expires: Date.now() + 3600000,
  }));
  const runtime = await ModelRuntime.create({
    credentials,
    refreshOnCreate: false,
    modelsPath: null,
  });
  runtime.registerProvider(model.provider, { api: model.api, models: [model] });
  const manager = SessionManager.inMemory();
  const kept = manager.appendMessage({ role: "user", content: "before", timestamp: 1 });
  manager.appendCompaction(
    "native",
    kept,
    100,
    nativeDetails(
      options.checkpointAccount === undefined ? {} : { account: options.checkpointAccount },
    ),
  );
  manager.appendMessage({ role: "user", content: "after checkpoint", timestamp: 2 });
  const extensionRuntime = createExtensionRuntime();
  extensionRuntime.getThinkingLevel = () => "off";
  const notices: string[] = [];
  const runner = new ExtensionRunner(
    [],
    extensionRuntime,
    process.cwd(),
    manager,
    new ModelRegistry(runtime),
  );
  const ctx = {
    ...runner.createContext(),
    model,
    ui: { ...runner.getUIContext(), notify: (message: string) => notices.push(message) },
  };
  const config = structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG);
  config.executionMode = "normal";
  config.compaction.responsesCompaction = true;
  const state: AdapterState = {
    enabled: true,
    cwd: process.cwd(),
    promptSkills: [],
    config,
    executionMode: "normal",
    codexTurnState: createCodexTurnState(),
  };
  const records: LaneRecord[] = [];
  const pi = {
    appendEntry: <T>(_customType: string, data?: T) => {
      if (Value.Check(LaneRecordSchema, data)) records.push(structuredClone(data));
    },
  };
  const payload = {
    model: model.id,
    input: serializeActiveSessionToResponsesInput({
      model,
      entries: manager.getBranch(),
      options: { blockImages: false },
    }),
  };
  return { manager, ctx, state, pi, payload, records, notices };
}

test("background checkpoint, same account: the foreground path replays it", async () => {
  const setup = await fixture({ checkpointAccount: "account-a", account: "account-a" });
  const outgoing = await rewriteCodexProviderRequest(
    setup.payload,
    setup.ctx,
    setup.state,
    setup.pi,
  );
  assert.ok(Value.Check(InputBodySchema, outgoing));
  assert.ok(outgoing.input.some((item) => item.type === "compaction"));
});

test("background checkpoint, another account: request refused with the exits text, compaction cancels", async () => {
  const setup = await fixture({ checkpointAccount: "account-a", account: "account-b" });
  const entryId = setup.manager.getBranch().findLast((entry) => entry.type === "compaction")?.id;
  assert.ok(entryId);
  await assert.rejects(
    rewriteCodexProviderRequest(setup.payload, setup.ctx, setup.state, setup.pi),
    (error: Error) =>
      error instanceof CodexRequestRefusedError &&
      error.message === OPAQUE_GUARD_NOTICE("codex", entryId),
  );
  assert.ok(setup.notices.includes(OPAQUE_GUARD_NOTICE("codex", entryId)));
  const refusal = setup.records.find((record) => record.event === "refuse");
  assert.equal(refusal?.reason, "scope-mismatch");
  assert.equal(refusal?.checkpointEntryId, entryId);
  // The compaction path resolves the same mismatch instead of skipping to an older entry.
  const latest = resolveLatestNativeCompactionEntry(setup.manager.getBranch(), {
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    accountScope: codexBackgroundAccountScope("account-b"),
  });
  assert.equal(latest.ok, false);
  assert.equal(latest.ok ? undefined : latest.reason, "latest-native-compaction-mismatch");
});

test("foreground checkpoint without background scope keeps provider/api/baseUrl matching", async () => {
  const setup = await fixture({ account: "account-b" });
  const outgoing = await rewriteCodexProviderRequest(
    setup.payload,
    setup.ctx,
    setup.state,
    setup.pi,
  );
  assert.ok(Value.Check(InputBodySchema, outgoing));
  assert.ok(outgoing.input.some((item) => item.type === "compaction"));
  const latest = resolveLatestNativeCompactionEntry(setup.manager.getBranch(), {
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    accountScope: codexBackgroundAccountScope("account-b"),
  });
  assert.equal(latest.ok, true);
});
