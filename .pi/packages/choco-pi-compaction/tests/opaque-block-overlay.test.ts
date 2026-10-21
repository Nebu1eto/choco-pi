/**
 * The provider-boundary block overlay over a fake registry with the host's
 * merge semantics: a blocked request is refused before the provider stream
 * runs, a later registration of the provider is wrapped again, two
 * registrations on one registry never wrap each other's overlay (no chain
 * growth across requests), the owning registration announces once, and
 * release restores the original registration. A native `Provider`
 * registration is overlaid by a delegating provider, and a request without
 * a session id is never authorized by the missing identity nor attributed to
 * a registration's mutable session (also through the real `ModelRuntime`,
 * whose `transformHeaders` await precedes the overlay), nor sent because
 * one registration re-wrapped a re-registered provider while another still
 * uses it.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  type Api,
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Model,
  type ModelsRequestTransforms,
  normalizeContext,
  type Provider,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { type ExtensionAPI, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { clearOpaqueBlock, pendingOpaqueBlock, setOpaqueBlock } from "../src/opaque-block.ts";
import {
  createOpaqueBlockOverlay,
  OPAQUE_BLOCK_REFUSAL_PREFIX,
  type OpaqueGuardRecord,
  type OverlayContext,
  type OverlayHostApi,
  type OverlayRegistry,
} from "../src/opaque-guard.ts";

type ProviderRegistration = Parameters<ExtensionAPI["registerProvider"]>[1];
type ProviderStream = NonNullable<ProviderRegistration["streamSimple"]>;

const MODEL: Model<Api> = {
  id: "overlay-test-1",
  name: "Synthetic overlay",
  api: "openai-responses",
  provider: "overlay-llm",
  baseUrl: "https://overlay.example/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 100,
};
const CONTEXT = normalizeContext({ messages: [] });

interface FakeHost {
  readonly api: OverlayHostApi;
  readonly registry: OverlayRegistry;
  readonly calls: { register: number; transmitted: number };
}

/**
 * A registry with the host's registration semantics: config registrations
 * merge over a built-in stream, a native registration replaces both, and a
 * config registration replaces a native one.
 */
function fakeHost(): FakeHost {
  const configs = new Map<string, ProviderRegistration>();
  const natives = new Map<string, Provider>();
  const calls = { register: 0, transmitted: 0 };
  const builtin: ProviderStream = () => {
    calls.transmitted += 1;
    return createAssistantMessageEventStream();
  };
  function registerProvider(provider: Provider): void;
  function registerProvider(name: string, config: ProviderRegistration): void;
  function registerProvider(...args: [Provider] | [string, ProviderRegistration]): void {
    calls.register += 1;
    if (args.length === 1) {
      const [provider] = args;
      configs.delete(provider.id);
      natives.set(provider.id, provider);
      return;
    }
    const [name, config] = args;
    natives.delete(name);
    configs.set(name, { ...configs.get(name), ...config });
  }
  return {
    calls,
    api: {
      registerProvider,
      unregisterProvider: (name) => {
        configs.delete(name);
        natives.delete(name);
      },
    },
    registry: {
      getRegisteredProviderConfig: (name) => configs.get(name),
      getRegisteredNativeProvider: (name) => natives.get(name),
      getProvider: (name) =>
        natives.get(name) ?? { streamSimple: configs.get(name)?.streamSimple ?? builtin },
    },
  };
}

/** The host's stale-context failure (`lifecycle.ts`). */
const STALE_CONTEXT = "This extension ctx is stale after session replacement or reload.";

function contextOf(registry: OverlayRegistry, sessionId: string | undefined): OverlayContext {
  return {
    model: MODEL,
    modelRegistry: registry,
    sessionManager: {
      getSessionId: () => {
        if (sessionId === undefined) throw new Error(STALE_CONTEXT);
        return sessionId;
      },
    },
  };
}

function send(registry: OverlayRegistry, sessionId: string | undefined): void {
  const options: SimpleStreamOptions = sessionId === undefined ? {} : { sessionId };
  registry.getProvider(MODEL.provider)?.streamSimple(MODEL, CONTEXT, options);
}

interface NativeProbe {
  readonly provider: Provider;
  readonly sent: { stream: number; streamSimple: number; deferred: number };
}

/** A native provider (a class instance with private state) that counts what it sends. */
function nativeProvider(): NativeProbe {
  const sent = { stream: 0, streamSimple: 0, deferred: 0 };
  class NativeProvider implements Provider {
    readonly id = MODEL.provider;
    readonly name = "Native overlay";
    readonly baseUrl = MODEL.baseUrl;
    readonly auth = {
      apiKey: { name: "Native key", resolve: async () => ({ auth: {}, source: "test" }) },
    };
    readonly extra = "kept";
    readonly #models: readonly Model<Api>[] = [MODEL];
    getModels(): readonly Model<Api>[] {
      return this.#models;
    }
    stream(): ReturnType<Provider["stream"]> {
      sent.stream += 1;
      return createAssistantMessageEventStream();
    }
    streamSimple(): ReturnType<Provider["streamSimple"]> {
      sent.streamSimple += 1;
      return createAssistantMessageEventStream();
    }
    fetchDeferred(): ReturnType<Provider["streamSimple"]> {
      sent.deferred += this.#models.length;
      return createAssistantMessageEventStream();
    }
  }
  return { provider: new NativeProvider(), sent };
}

test("a blocked session is refused before the provider stream runs; others pass", () => {
  const host = fakeHost();
  const records: OpaqueGuardRecord[] = [];
  const overlay = createOpaqueBlockOverlay(host.api, {
    modes: () => ({ opaqueHistory: "preserve" }),
    announce: (_ctx, record) => records.push(record),
  });
  try {
    overlay.sync(contextOf(host.registry, "overlay-s1"));
    setOpaqueBlock("overlay-s1", { entryId: "cp-1", owner: "xai-native" });
    assert.throws(
      () => send(host.registry, "overlay-s1"),
      (error: Error) => error.message.startsWith(OPAQUE_BLOCK_REFUSAL_PREFIX),
    );
    assert.throws(() => send(host.registry, "overlay-s1"));
    assert.equal(host.calls.transmitted, 0, "zero transmissions");
    assert.equal(records.length, 1, "announced once per checkpoint and reason");
    assert.equal(records[0]?.event, "refuse");
    assert.equal(records[0]?.provider, "xai");
    send(host.registry, "overlay-other-session");
    assert.equal(host.calls.transmitted, 1, "an unblocked session passes");
  } finally {
    clearOpaqueBlock("overlay-s1");
    overlay.release();
  }
});

test("allow-loss on the owning registration lifts the block", () => {
  const host = fakeHost();
  const overlay = createOpaqueBlockOverlay(host.api, {
    modes: () => ({ opaqueHistory: "allow-loss" }),
    announce: () => {},
  });
  try {
    overlay.sync(contextOf(host.registry, "overlay-s2"));
    setOpaqueBlock("overlay-s2", { entryId: "cp-2", owner: "codex-native" });
    send(host.registry, "overlay-s2");
    assert.equal(host.calls.transmitted, 1);
  } finally {
    clearOpaqueBlock("overlay-s2");
    overlay.release();
  }
});

test("a later registration of the provider is wrapped again on the next sync", () => {
  const host = fakeHost();
  const overlay = createOpaqueBlockOverlay(host.api, {
    modes: () => ({ opaqueHistory: "preserve" }),
    announce: () => {},
  });
  try {
    const ctx = contextOf(host.registry, "overlay-s3");
    overlay.sync(ctx);
    // A capture transport registers after the overlay and replaces it.
    let captured = 0;
    host.api.registerProvider(MODEL.provider, {
      api: "openai-responses",
      streamSimple: () => {
        captured += 1;
        return createAssistantMessageEventStream();
      },
    });
    overlay.sync(ctx);
    setOpaqueBlock("overlay-s3", { entryId: "cp-3", owner: "xai-native" });
    assert.throws(() => send(host.registry, "overlay-s3"));
    assert.equal(captured, 0, "the capture transport never ran");
    clearOpaqueBlock("overlay-s3");
    send(host.registry, "overlay-s3");
    assert.equal(captured, 1, "it runs once the block is gone");
  } finally {
    clearOpaqueBlock("overlay-s3");
    overlay.release();
  }
});

test("two registrations on one registry never re-wrap each other; the owner announces", () => {
  const host = fakeHost();
  const parentRecords: OpaqueGuardRecord[] = [];
  const childRecords: OpaqueGuardRecord[] = [];
  const parent = createOpaqueBlockOverlay(host.api, {
    modes: () => ({ opaqueHistory: "preserve" }),
    announce: (_ctx, record) => parentRecords.push(record),
  });
  const child = createOpaqueBlockOverlay(host.api, {
    modes: () => ({ opaqueHistory: "preserve" }),
    announce: (_ctx, record) => childRecords.push(record),
  });
  const parentCtx = contextOf(host.registry, "overlay-parent");
  const childCtx = contextOf(host.registry, "overlay-child");
  try {
    parent.sync(parentCtx);
    child.sync(childCtx);
    const registrations = host.calls.register;
    for (let index = 0; index < 50; index++) {
      parent.sync(parentCtx);
      child.sync(childCtx);
    }
    assert.equal(host.calls.register, registrations, "no registration per request");
    assert.equal(registrations, 1, "exactly one overlay installed");

    setOpaqueBlock("overlay-child", { entryId: "cp-child", owner: "xai-native" });
    assert.throws(() => send(host.registry, "overlay-child"));
    assert.equal(host.calls.transmitted, 0);
    assert.equal(childRecords.length, 1, "the child's registration journals its session");
    assert.equal(parentRecords.length, 0);

    // The installing registration leaves: the other one takes over on its next sync.
    parent.release();
    child.sync(childCtx);
    assert.throws(() => send(host.registry, "overlay-child"));
    assert.equal(host.calls.transmitted, 0, "still enforced after the first owner left");
  } finally {
    clearOpaqueBlock("overlay-child");
    parent.release();
    child.release();
  }
  assert.equal(host.registry.getRegisteredProviderConfig(MODEL.provider), undefined, "restored");
});

test("a native Provider registration is overlaid: zero sends, one refuse record, restored", () => {
  const host = fakeHost();
  const native = nativeProvider();
  host.api.registerProvider(native.provider);
  const records: OpaqueGuardRecord[] = [];
  const overlay = createOpaqueBlockOverlay(host.api, {
    modes: () => ({ opaqueHistory: "preserve" }),
    announce: (_ctx, record) => records.push(record),
  });
  const ctx = contextOf(host.registry, "overlay-native");
  try {
    overlay.sync(ctx);
    const wrapper = host.registry.getRegisteredNativeProvider(MODEL.provider);
    assert.ok(wrapper !== undefined && wrapper !== native.provider, "the overlay is installed");
    const registrations = host.calls.register;
    for (let index = 0; index < 20; index++) overlay.sync(ctx);
    assert.equal(host.calls.register, registrations, "no re-wrap per request");

    // Every capability of the original is kept, with the original as `this`.
    assert.equal(wrapper.id, MODEL.provider);
    assert.equal(wrapper.baseUrl, MODEL.baseUrl);
    assert.deepEqual(wrapper.getModels(), [MODEL]);
    assert.ok("extra" in wrapper, "fields outside the contract resolve");
    assert.equal("classify" in wrapper, false, "absent optional members stay absent");
    assert.ok(wrapper.fetchDeferred !== undefined);

    setOpaqueBlock("overlay-native", { entryId: "cp-native", owner: "xai-native" });
    assert.throws(
      () => send(host.registry, "overlay-native"),
      (error: Error) => error.message.startsWith(OPAQUE_BLOCK_REFUSAL_PREFIX),
    );
    assert.throws(() => wrapper.stream(MODEL, CONTEXT, { sessionId: "overlay-native" }));
    assert.deepEqual(native.sent, { stream: 0, streamSimple: 0, deferred: 0 }, "zero sends");
    assert.equal(records.length, 1);
    assert.equal(records[0]?.event, "refuse");
    assert.equal(records[0]?.sessionId, "overlay-native");
    assert.equal(records[0]?.checkpointEntryId, "cp-native");

    clearOpaqueBlock("overlay-native");
    send(host.registry, "overlay-native");
    wrapper.fetchDeferred?.(MODEL, {
      provider: MODEL.provider,
      modelId: MODEL.id,
      api: MODEL.api,
      id: "deferred-1",
    });
    assert.deepEqual(native.sent, { stream: 0, streamSimple: 1, deferred: 1 }, "delegated");
  } finally {
    clearOpaqueBlock("overlay-native");
    overlay.release();
  }
  assert.equal(
    host.registry.getRegisteredNativeProvider(MODEL.provider),
    native.provider,
    "the original native registration is restored",
  );
});

test("two registrations never wrap each other's native overlay", () => {
  const host = fakeHost();
  const native = nativeProvider();
  host.api.registerProvider(native.provider);
  const announce = (): void => {};
  const parent = createOpaqueBlockOverlay(host.api, {
    modes: () => ({ opaqueHistory: "preserve" }),
    announce,
  });
  const child = createOpaqueBlockOverlay(host.api, {
    modes: () => ({ opaqueHistory: "preserve" }),
    announce,
  });
  const parentCtx = contextOf(host.registry, "overlay-native-parent");
  const childCtx = contextOf(host.registry, "overlay-native-child");
  try {
    parent.sync(parentCtx);
    child.sync(childCtx);
    const registrations = host.calls.register;
    for (let index = 0; index < 20; index++) {
      parent.sync(parentCtx);
      child.sync(childCtx);
    }
    assert.equal(host.calls.register, registrations, "no chain growth");
    setOpaqueBlock("overlay-native-child", { entryId: "cp-nc", owner: "codex-native" });
    assert.throws(() => send(host.registry, "overlay-native-child"));
    assert.equal(native.sent.streamSimple, 0);
  } finally {
    clearOpaqueBlock("overlay-native-child");
    parent.release();
    child.release();
  }
  assert.equal(host.registry.getRegisteredNativeProvider(MODEL.provider), native.provider);
});

test("a request without a sessionId is refused by a pending block, unattributed", () => {
  const host = fakeHost();
  const records: OpaqueGuardRecord[] = [];
  const overlay = createOpaqueBlockOverlay(host.api, {
    modes: () => ({ opaqueHistory: "preserve" }),
    announce: (_ctx, record) => records.push(record),
  });
  try {
    overlay.sync(contextOf(host.registry, "overlay-anon"));
    setOpaqueBlock("overlay-anon", { entryId: "cp-anon", owner: "xai-native" });
    assert.throws(
      () => send(host.registry, undefined),
      (error: Error) => error.message.startsWith(OPAQUE_BLOCK_REFUSAL_PREFIX),
    );
    assert.equal(host.calls.transmitted, 0, "zero sends");
    assert.equal(records.length, 1);
    assert.equal(records[0]?.sessionId, "overlay-anon", "journaled by the blocked session's owner");
    assert.equal(records[0]?.detail, "unattributed-request", "never attributed by the owner");
  } finally {
    clearOpaqueBlock("overlay-anon");
    overlay.release();
  }
});

test("an anonymous request with one registration and no block passes unjournaled", () => {
  const host = fakeHost();
  const records: OpaqueGuardRecord[] = [];
  const overlay = createOpaqueBlockOverlay(host.api, {
    modes: () => ({ opaqueHistory: "preserve" }),
    announce: (_ctx, record) => records.push(record),
  });
  try {
    overlay.sync(contextOf(host.registry, "overlay-anon-free"));
    send(host.registry, undefined);
    assert.equal(host.calls.transmitted, 1, "sent");
    assert.deepEqual(records, []);
  } finally {
    overlay.release();
  }
});

test("an anonymous request whose only block allows loss passes with a loss record by its owner", () => {
  const host = fakeHost();
  const records: OpaqueGuardRecord[] = [];
  const overlay = createOpaqueBlockOverlay(host.api, {
    modes: () => ({ opaqueHistory: "allow-loss" }),
    announce: (_ctx, record) => records.push(record),
  });
  try {
    overlay.sync(contextOf(host.registry, "overlay-anon-loss"));
    setOpaqueBlock("overlay-anon-loss", { entryId: "cp-anon-loss", owner: "xai-native" });
    send(host.registry, undefined);
    send(host.registry, undefined);
    assert.equal(host.calls.transmitted, 2, "both sent");
    assert.equal(records.length, 1, "journaled once per checkpoint");
    assert.equal(records[0]?.event, "loss");
    assert.equal(records[0]?.reason, "loss");
    assert.equal(records[0]?.sessionId, "overlay-anon-loss");
    assert.equal(records[0]?.checkpointEntryId, "cp-anon-loss");
    assert.equal(records[0]?.detail, "unattributed-request");
  } finally {
    clearOpaqueBlock("overlay-anon-loss");
    overlay.release();
  }
});

test("an anonymous request on a shared overlay is refused even when the block allows loss", () => {
  const host = fakeHost();
  const ownerRecords: OpaqueGuardRecord[] = [];
  const installer = createOpaqueBlockOverlay(host.api, {
    modes: () => ({ opaqueHistory: "preserve" }),
    announce: () => {},
  });
  const owner = createOpaqueBlockOverlay(host.api, {
    modes: () => ({ opaqueHistory: "allow-loss" }),
    announce: (_ctx, record) => ownerRecords.push(record),
  });
  try {
    installer.sync(contextOf(host.registry, "overlay-shared-installer"));
    owner.sync(contextOf(host.registry, "overlay-shared-owner"));
    setOpaqueBlock("overlay-shared-owner", { entryId: "cp-shared", owner: "codex-native" });
    assert.throws(
      () => send(host.registry, undefined),
      (error: Error) => error.message.startsWith(OPAQUE_BLOCK_REFUSAL_PREFIX),
    );
    assert.equal(host.calls.transmitted, 0, "zero sends");
    assert.equal(ownerRecords.length, 1);
    assert.equal(ownerRecords[0]?.event, "refuse");
    assert.equal(ownerRecords[0]?.detail, "unattributed-request");
    // By id, the owner's allow-loss still lifts its block.
    send(host.registry, "overlay-shared-owner");
    assert.equal(host.calls.transmitted, 1);
    // Once the installer leaves, the owner alone serves the overlay: loss applies.
    installer.release();
    owner.sync(contextOf(host.registry, "overlay-shared-owner"));
    send(host.registry, undefined);
    assert.equal(host.calls.transmitted, 2);
    assert.equal(ownerRecords.at(-1)?.event, "loss");
  } finally {
    clearOpaqueBlock("overlay-shared-owner");
    installer.release();
    owner.release();
  }
});

// ---------------------------------------------------------------------------
// Through the real model runtime
// ---------------------------------------------------------------------------

const RUNTIME_KEY = "overlay-runtime-non-secret-placeholder";

/** A real `ModelRuntime` (with `native` registered when given), and the overlay's registration calls on it. */
async function realRuntime(
  native: Provider | undefined,
): Promise<{ readonly runtime: ModelRuntime; readonly api: OverlayHostApi }> {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
    modelsPath: null,
  });
  if (native !== undefined) runtime.registerNativeProvider(native);
  function registerProvider(provider: Provider): void;
  function registerProvider(name: string, config: ProviderRegistration): void;
  function registerProvider(...args: [Provider] | [string, ProviderRegistration]): void {
    if (args.length === 1) runtime.registerNativeProvider(args[0]);
    else runtime.registerProvider(args[0], args[1]);
  }
  return {
    runtime,
    api: { registerProvider, unregisterProvider: (name) => runtime.unregisterProvider(name) },
  };
}

/** A gate the request's `transformHeaders` waits on; `entered` resolves when it is reached. */
interface HeaderPause {
  readonly entered: Promise<void>;
  readonly resume: () => void;
  readonly transformHeaders: NonNullable<ModelsRequestTransforms["transformHeaders"]>;
}

function headerPause(): HeaderPause {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const pause: HeaderPause = {
    entered: entered.promise,
    resume: () => released.resolve(),
    transformHeaders: async (headers) => {
      entered.resolve();
      await released.promise;
      return headers;
    },
  };
  return pause;
}

test("real runtime: a blocked child's anonymous request on the parent's native overlay is refused", async () => {
  const native = nativeProvider();
  const { runtime, api } = await realRuntime(native.provider);
  const parentRecords: OpaqueGuardRecord[] = [];
  const childRecords: OpaqueGuardRecord[] = [];
  const parent = createOpaqueBlockOverlay(api, {
    modes: () => ({ opaqueHistory: "preserve" }),
    announce: (_ctx, record) => parentRecords.push(record),
  });
  const child = createOpaqueBlockOverlay(api, {
    modes: () => ({ opaqueHistory: "preserve" }),
    announce: (_ctx, record) => childRecords.push(record),
  });
  try {
    parent.sync(contextOf(runtime, "overlay-rt-parent"));
    child.sync(contextOf(runtime, "overlay-rt-child"));
    assert.notEqual(runtime.getRegisteredNativeProvider(MODEL.provider), native.provider);
    setOpaqueBlock("overlay-rt-child", { entryId: "cp-rt-child", owner: "xai-native" });

    const refused = await runtime.streamSimple(MODEL, CONTEXT, { apiKey: RUNTIME_KEY }).result();
    assert.equal(refused.stopReason, "error");
    assert.ok(
      (refused.errorMessage ?? "").includes(OPAQUE_BLOCK_REFUSAL_PREFIX),
      refused.errorMessage ?? "no error",
    );
    assert.deepEqual(native.sent, { stream: 0, streamSimple: 0, deferred: 0 }, "zero sends");
    assert.equal(parentRecords.length, 0, "never attributed to the installer's session");
    assert.equal(childRecords.length, 1);
    assert.equal(childRecords[0]?.event, "refuse");
    assert.equal(childRecords[0]?.sessionId, "overlay-rt-child");
    assert.equal(childRecords[0]?.detail, "unattributed-request");
  } finally {
    clearOpaqueBlock("overlay-rt-child");
    parent.release();
    child.release();
  }
  assert.equal(runtime.getRegisteredNativeProvider(MODEL.provider), native.provider, "restored");
});

test("real runtime: an anonymous request paused in transformHeaders while the installer moves on is refused", async () => {
  const native = nativeProvider();
  const { runtime, api } = await realRuntime(native.provider);
  const installerRecords: OpaqueGuardRecord[] = [];
  const ownerRecords: OpaqueGuardRecord[] = [];
  const installer = createOpaqueBlockOverlay(api, {
    modes: () => ({ opaqueHistory: "preserve" }),
    announce: (_ctx, record) => installerRecords.push(record),
  });
  const owner = createOpaqueBlockOverlay(api, {
    modes: () => ({ opaqueHistory: "preserve" }),
    announce: (_ctx, record) => ownerRecords.push(record),
  });
  try {
    installer.sync(contextOf(runtime, "overlay-rt-a"));
    owner.sync(contextOf(runtime, "overlay-rt-a"));
    setOpaqueBlock("overlay-rt-a", { entryId: "cp-rt-a", owner: "codex-native" });
    const pause = headerPause();
    const request = runtime
      .streamSimple(MODEL, CONTEXT, {
        apiKey: RUNTIME_KEY,
        transformHeaders: pause.transformHeaders,
      })
      .result();
    await pause.entered;
    installer.sync(contextOf(runtime, "overlay-rt-b"));
    pause.resume();
    const refused = await request;
    assert.equal(refused.stopReason, "error");
    assert.ok(
      (refused.errorMessage ?? "").includes(OPAQUE_BLOCK_REFUSAL_PREFIX),
      refused.errorMessage ?? "no error",
    );
    assert.deepEqual(native.sent, { stream: 0, streamSimple: 0, deferred: 0 }, "zero sends");
    assert.deepEqual(pendingOpaqueBlock("overlay-rt-a"), {
      entryId: "cp-rt-a",
      owner: "codex-native",
    });
    assert.equal(installerRecords.length, 0, "never attributed to the installer's new session");
    assert.equal(ownerRecords.length, 1);
    assert.equal(ownerRecords[0]?.event, "refuse");
    assert.equal(ownerRecords[0]?.sessionId, "overlay-rt-a");
    assert.equal(ownerRecords[0]?.detail, "unattributed-request");
  } finally {
    clearOpaqueBlock("overlay-rt-a");
    installer.release();
    owner.release();
  }
});

test("real runtime: a lone installer moving off its blocked session still refuses the paused request", async () => {
  const native = nativeProvider();
  const { runtime, api } = await realRuntime(native.provider);
  const records: OpaqueGuardRecord[] = [];
  const installer = createOpaqueBlockOverlay(api, {
    modes: () => ({ opaqueHistory: "preserve" }),
    announce: (_ctx, record) => records.push(record),
  });
  try {
    installer.sync(contextOf(runtime, "overlay-rt-lone-a"));
    setOpaqueBlock("overlay-rt-lone-a", { entryId: "cp-rt-lone", owner: "xai-native" });
    const pause = headerPause();
    const request = runtime
      .streamSimple(MODEL, CONTEXT, {
        apiKey: RUNTIME_KEY,
        transformHeaders: pause.transformHeaders,
      })
      .result();
    await pause.entered;
    installer.sync(contextOf(runtime, "overlay-rt-lone-b"));
    pause.resume();
    const refused = await request;
    assert.equal(refused.stopReason, "error");
    assert.ok(
      (refused.errorMessage ?? "").includes(OPAQUE_BLOCK_REFUSAL_PREFIX),
      refused.errorMessage ?? "no error",
    );
    assert.deepEqual(native.sent, { stream: 0, streamSimple: 0, deferred: 0 }, "zero sends");
    // Session A has no owner left; its refusal is never journaled into session B.
    assert.equal(
      records.some((record) => record.sessionId === "overlay-rt-lone-b"),
      false,
    );
  } finally {
    clearOpaqueBlock("overlay-rt-lone-a");
    installer.release();
  }
});

test("an unattributed request is refused while any block is pending, and passes with none", () => {
  const host = fakeHost();
  const installerRecords: OpaqueGuardRecord[] = [];
  const ownerRecords: OpaqueGuardRecord[] = [];
  // The installing registration's context is stale: it owns no session.
  const installer = createOpaqueBlockOverlay(host.api, {
    modes: () => ({ opaqueHistory: "preserve" }),
    announce: (_ctx, record) => installerRecords.push(record),
  });
  const owner = createOpaqueBlockOverlay(host.api, {
    modes: () => ({ opaqueHistory: "preserve" }),
    announce: (_ctx, record) => ownerRecords.push(record),
  });
  try {
    installer.sync(contextOf(host.registry, undefined));
    owner.sync(contextOf(host.registry, "overlay-unattributed"));
    assert.equal(host.calls.register, 1, "one overlay, installed by the session-less registration");

    send(host.registry, undefined);
    assert.equal(host.calls.transmitted, 1, "no pending block: the request passes");

    setOpaqueBlock("overlay-unattributed", { entryId: "cp-unattr", owner: "codex-native" });
    assert.throws(
      () => send(host.registry, undefined),
      (error: Error) => error.message.startsWith(OPAQUE_BLOCK_REFUSAL_PREFIX),
    );
    assert.equal(host.calls.transmitted, 1, "the unattributed request was not sent");
    assert.equal(installerRecords.length, 0);
    assert.equal(ownerRecords.length, 1, "the blocked session's owner journals");
    assert.equal(ownerRecords[0]?.event, "refuse");
    assert.equal(ownerRecords[0]?.detail, "unattributed-request");
    assert.equal(ownerRecords[0]?.checkpointEntryId, "cp-unattr");
  } finally {
    clearOpaqueBlock("overlay-unattributed");
    installer.release();
    owner.release();
  }
});

// ---------------------------------------------------------------------------
// Membership across a re-wrapped provider
// ---------------------------------------------------------------------------

/** Thrown by a transport that was reached: the request ends at once (a regression fails, never hangs). */
const TRANSMITTED = "transmitted";

interface RewrapCase {
  readonly runtime: ModelRuntime;
  readonly api: OverlayHostApi;
  /** Requests that reached the provider's transport. */
  readonly transmitted: () => number;
  /** Register the provider again, replacing the overlay on top of it. */
  readonly reregister: () => void;
}

async function nativeRewrapCase(): Promise<RewrapCase> {
  let transmitted = 0;
  const transport = (): never => {
    transmitted += 1;
    throw new Error(TRANSMITTED);
  };
  const native: Provider = {
    id: MODEL.provider,
    name: "Native rewrap",
    baseUrl: MODEL.baseUrl,
    auth: { apiKey: { name: "Native key", resolve: async () => ({ auth: {}, source: "test" }) } },
    getModels: () => [MODEL],
    stream: transport,
    streamSimple: transport,
  };
  const { runtime, api } = await realRuntime(native);
  return {
    runtime,
    api,
    transmitted: () => transmitted,
    reregister: () => runtime.registerNativeProvider(native),
  };
}

async function configRewrapCase(): Promise<RewrapCase> {
  const { runtime, api } = await realRuntime(undefined);
  let transmitted = 0;
  const transport: ProviderStream = () => {
    transmitted += 1;
    throw new Error(TRANSMITTED);
  };
  const registration: ProviderRegistration = {
    baseUrl: MODEL.baseUrl,
    apiKey: RUNTIME_KEY,
    api: MODEL.api,
    streamSimple: transport,
    models: [
      {
        id: MODEL.id,
        name: MODEL.name,
        reasoning: MODEL.reasoning,
        input: ["text"],
        cost: MODEL.cost,
        contextWindow: MODEL.contextWindow,
        maxTokens: MODEL.maxTokens,
      },
    ],
  };
  runtime.registerProvider(MODEL.provider, registration);
  return {
    runtime,
    api,
    transmitted: () => transmitted,
    reregister: () => runtime.registerProvider(MODEL.provider, registration),
  };
}

for (const [kind, setup] of [
  ["native", nativeRewrapCase],
  ["config", configRewrapCase],
] as const) {
  test(`real runtime: a ${kind} provider re-wrapped by one registration still counts the other's membership`, async () => {
    const rewrap = await setup();
    const { runtime, api } = rewrap;
    const parentRecords: OpaqueGuardRecord[] = [];
    const childRecords: OpaqueGuardRecord[] = [];
    const parent = createOpaqueBlockOverlay(api, {
      modes: () => ({ opaqueHistory: "preserve" }),
      announce: (_ctx, record) => parentRecords.push(record),
    });
    const child = createOpaqueBlockOverlay(api, {
      modes: () => ({ opaqueHistory: "allow-loss" }),
      announce: (_ctx, record) => childRecords.push(record),
    });
    const sessionId = `overlay-rewrap-${kind}-child`;
    const parentCtx = contextOf(runtime, `overlay-rewrap-${kind}-parent`);
    try {
      parent.sync(parentCtx);
      child.sync(contextOf(runtime, sessionId));
      setOpaqueBlock(sessionId, { entryId: `cp-rewrap-${kind}`, owner: "xai-native" });
      const first = await runtime.streamSimple(MODEL, CONTEXT, { apiKey: RUNTIME_KEY }).result();
      assert.equal(first.stopReason, "error");
      assert.ok(
        (first.errorMessage ?? "").includes(OPAQUE_BLOCK_REFUSAL_PREFIX),
        first.errorMessage ?? "no error",
      );

      // The provider is registered again; only the parent syncs and wraps the replacement.
      rewrap.reregister();
      parent.sync(parentCtx);
      const second = await runtime.streamSimple(MODEL, CONTEXT, { apiKey: RUNTIME_KEY }).result();
      assert.equal(second.stopReason, "error");
      assert.ok(
        (second.errorMessage ?? "").includes(OPAQUE_BLOCK_REFUSAL_PREFIX),
        second.errorMessage ?? "no error",
      );
      assert.equal(rewrap.transmitted(), 0, "zero sends");
      assert.deepEqual(
        childRecords.map((record) => record.event),
        ["refuse"],
        "refused, never journaled as a loss",
      );
      assert.equal(childRecords[0]?.detail, "unattributed-request");
      assert.equal(parentRecords.length, 0);
    } finally {
      clearOpaqueBlock(sessionId);
      parent.release();
      child.release();
    }
  });
}

test("an isolated overlay slot counts as shared: an anonymous request is refused even when the block allows loss", () => {
  const symbol = Symbol.for("choco-pi:compaction-opaque-block-overlay");
  const saved = Object.getOwnPropertyDescriptor(globalThis, symbol);
  // Another version's slot occupies the shared one: other memberships are invisible.
  Object.defineProperty(globalThis, symbol, {
    value: {
      version: 2,
      overlays: new WeakSet(),
      owners: new Map(),
      users: new WeakMap(),
      generation: 0,
    },
    configurable: true,
  });
  const host = fakeHost();
  const records: OpaqueGuardRecord[] = [];
  const overlay = createOpaqueBlockOverlay(host.api, {
    modes: () => ({ opaqueHistory: "allow-loss" }),
    announce: (_ctx, record) => records.push(record),
  });
  try {
    overlay.sync(contextOf(host.registry, "overlay-isolated"));
    setOpaqueBlock("overlay-isolated", { entryId: "cp-isolated", owner: "xai-native" });
    assert.throws(
      () => send(host.registry, undefined),
      (error: Error) => error.message.startsWith(OPAQUE_BLOCK_REFUSAL_PREFIX),
    );
    assert.equal(host.calls.transmitted, 0, "zero sends");
    assert.deepEqual(
      records.map((record) => record.event),
      ["refuse"],
    );
    // By id, allow-loss still lifts the block.
    send(host.registry, "overlay-isolated");
    assert.equal(host.calls.transmitted, 1);
  } finally {
    clearOpaqueBlock("overlay-isolated");
    overlay.release();
    if (saved === undefined) Reflect.deleteProperty(globalThis, symbol);
    else Object.defineProperty(globalThis, symbol, saved);
  }
});
