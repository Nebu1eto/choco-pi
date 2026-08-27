import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const STALE_CONTEXT_MESSAGE = "This extension ctx is stale after session replacement or reload.";
const SYNTHETIC_PACKAGE_PATH = "/.pi/packages/choco-pi-provider-synthetic/";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith(".") &&
      context.parentURL?.includes(SYNTHETIC_PACKAGE_PATH) &&
      extname(new URL(specifier, context.parentURL).pathname) === ""
    ) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const commandUrl = new URL(
  "../.pi/packages/choco-pi-provider-synthetic/extensions/command-quotas/command.ts",
  import.meta.url,
);
const handlerUrl = new URL(
  "../.pi/packages/choco-pi-provider-synthetic/extensions/command-quotas/handler.ts",
  import.meta.url,
);
const { registerQuotasCommand } = await import(commandUrl.href);
const { handleQuotasCommand } = await import(handlerUrl.href);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

type LifecycleHandler = () => void;
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

function createExtensionApi() {
  const lifecycle = new Map<string, LifecycleHandler>();
  let command: CommandHandler | undefined;
  // SAFETY: The command extension only uses the on/registerCommand members supplied below.
  const pi = Object.assign(Object.create(null) as ExtensionAPI, {
    on(event: string, handler: LifecycleHandler) {
      lifecycle.set(event, handler);
    },
    registerCommand(_name: string, options: { handler: CommandHandler }) {
      command = options.handler;
    },
  });
  return {
    pi,
    invokeLifecycle(event: string) {
      lifecycle.get(event)?.();
    },
    invokeCommand(ctx: ExtensionCommandContext) {
      assert.ok(command);
      return command("", ctx);
    },
  };
}

interface ContextOptions {
  customResult?: null | undefined | Promise<null | undefined>;
  apiKey?: string;
}

function createContext(options: ContextOptions = {}) {
  let stale = false;
  let accesses = 0;
  const notifications: Array<[string, string | undefined]> = [];
  const read = <T>(value: T): T => {
    accesses += 1;
    if (stale) throw new Error(STALE_CONTEXT_MESSAGE);
    return value;
  };
  const ui = {
    custom: () => Promise.resolve(options.customResult),
    notify: (message: string, level?: string) => notifications.push([message, level]),
  };
  // SAFETY: The fixture supplies every command-context member exercised by this handler.
  const ctx = Object.create(null) as ExtensionCommandContext;
  Object.defineProperties(ctx, {
    ui: {
      get: () => read(ui),
    },
    modelRegistry: {
      get: () =>
        read({
          getApiKeyForProvider: async () => options.apiKey,
        }),
    },
  });
  return {
    ctx,
    notifications,
    markStale() {
      stale = true;
    },
    accessCount() {
      return accesses;
    },
  };
}

interface ResolvedSyntheticConfig {
  configVersion: string;
  webSearch: boolean;
  quotasCommand: boolean;
  usageStatus: boolean;
  quotaWarnings: boolean;
  subBarIntegration: boolean;
  proxyUrl: string;
  proxyRequiresAuth: boolean;
}

const config: ResolvedSyntheticConfig = {
  configVersion: "1",
  webSearch: true,
  quotasCommand: true,
  usageStatus: true,
  quotaWarnings: true,
  subBarIntegration: true,
  proxyUrl: "",
  proxyRequiresAuth: true,
};
const quotas = {
  rollingFiveHourLimit: {
    nextTickAt: "2030-01-01T00:00:00.000Z",
    tickPercent: 0.1,
    remaining: 10,
    max: 100,
    limited: false,
  },
};

test("shutdown during lazy handler import prevents stale command context access", async () => {
  const fixture = createExtensionApi();
  const context = createContext();
  const runtime = deferred<{
    handleQuotasCommand: (
      args: string,
      ctx: ExtensionCommandContext,
      isCurrent: () => boolean,
    ) => Promise<void>;
  }>();
  let handlerCalls = 0;
  registerQuotasCommand(fixture.pi, () => runtime.promise);
  fixture.invokeLifecycle("session_start");
  const pending = fixture.invokeCommand(context.ctx);
  fixture.invokeLifecycle("session_shutdown");
  context.markStale();
  runtime.resolve({
    async handleQuotasCommand() {
      handlerCalls += 1;
    },
  });
  await pending;
  assert.equal(handlerCalls, 0);
  assert.equal(context.accessCount(), 0);
});

test("handler abandons each awaited stale-context stage without later ctx access", async (t) => {
  await t.test("configuration", async () => {
    const context = createContext();
    const configStage = deferred<typeof config>();
    let current = true;
    const pending = handleQuotasCommand("", context.ctx, () => current, {
      ensureConfig: () => configStage.promise,
      buildClient: async () => assert.fail("client build must not run"),
    });
    current = false;
    context.markStale();
    configStage.resolve(config);
    await pending;
    assert.equal(context.accessCount(), 0);
  });

  await t.test("deferred auth callback", async () => {
    const context = createContext({ apiKey: "secret" });
    const authStage = deferred<void>();
    let current = true;
    const pending = handleQuotasCommand("", context.ctx, () => current, {
      ensureConfig: async () => config,
      buildClient: async (
        _config: ResolvedSyntheticConfig,
        getApiKey: () => Promise<string | undefined>,
      ) => {
        await authStage.promise;
        assert.equal(await getApiKey(), undefined);
        return undefined;
      },
    });
    await settle();
    current = false;
    context.markStale();
    authStage.resolve();
    await pending;
    assert.equal(context.accessCount(), 0);
  });

  await t.test("client build after auth resolution", async () => {
    const context = createContext({ apiKey: "key" });
    const authResolved = deferred<void>();
    const buildStage = deferred<void>();
    let current = true;
    const pending = handleQuotasCommand("", context.ctx, () => current, {
      ensureConfig: async () => config,
      buildClient: async (
        _config: ResolvedSyntheticConfig,
        getApiKey: () => Promise<string | undefined>,
      ) => {
        assert.equal(await getApiKey(), "key");
        authResolved.resolve();
        await buildStage.promise;
        return undefined;
      },
    });
    await authResolved.promise;
    const accessesBeforeShutdown = context.accessCount();
    current = false;
    context.markStale();
    buildStage.resolve();
    await pending;
    assert.equal(context.accessCount(), accessesBeforeShutdown);
  });

  await t.test("custom UI", async () => {
    const customStage = deferred<null | undefined>();
    const context = createContext({ apiKey: "key", customResult: customStage.promise });
    let current = true;
    let fetches = 0;
    const pending = handleQuotasCommand("", context.ctx, () => current, {
      ensureConfig: async () => config,
      buildClient: async (
        _config: ResolvedSyntheticConfig,
        getApiKey: () => Promise<string | undefined>,
      ) => {
        assert.equal(await getApiKey(), "key");
        return {
          async quotas() {
            fetches += 1;
            return { success: true as const, data: { quotas } };
          },
        };
      },
    });
    await settle();
    current = false;
    context.markStale();
    customStage.resolve(undefined);
    await pending;
    assert.equal(fetches, 0);
  });

  await t.test("noninteractive quotas fetch", async () => {
    const fetchStage = deferred<{ success: true; data: { quotas: typeof quotas } }>();
    const context = createContext({ customResult: undefined });
    let current = true;
    const pending = handleQuotasCommand("", context.ctx, () => current, {
      ensureConfig: async () => config,
      buildClient: async () => ({ quotas: () => fetchStage.promise }),
    });
    await settle();
    current = false;
    context.markStale();
    fetchStage.resolve({ success: true, data: { quotas } });
    await pending;
    assert.deepEqual(context.notifications, []);
  });
});

test("current command keeps interactive and RPC behavior and propagates unrelated errors", async () => {
  const interactive = createContext({ customResult: null });
  let interactiveFetches = 0;
  await handleQuotasCommand("", interactive.ctx, () => true, {
    ensureConfig: async () => config,
    buildClient: async () => ({
      async quotas() {
        interactiveFetches += 1;
        return { success: true as const, data: { quotas } };
      },
    }),
  });
  assert.equal(interactiveFetches, 0);
  assert.deepEqual(interactive.notifications, []);

  const rpc = createContext({ customResult: undefined, apiKey: "key" });
  await handleQuotasCommand("", rpc.ctx, () => true, {
    ensureConfig: async () => config,
    buildClient: async (
      _config: ResolvedSyntheticConfig,
      getApiKey: () => Promise<string | undefined>,
    ) => {
      assert.equal(await getApiKey(), "key");
      return { quotas: async () => ({ success: true as const, data: { quotas } }) };
    },
  });
  assert.deepEqual(rpc.notifications, [[JSON.stringify(quotas), "info"]]);

  const expected = new Error("unrelated failure");
  await assert.rejects(
    handleQuotasCommand("", createContext().ctx, () => true, {
      ensureConfig: async () => {
        throw expected;
      },
      buildClient: async () => undefined,
    }),
    (error) => error === expected,
  );
});
