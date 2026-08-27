import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STALE_CONTEXT_MESSAGE = "This extension ctx is stale after session replacement or reload.";
const SYNTHETIC_CONFIG_UPDATED_EVENT = "synthetic:config:updated";
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

interface SyntheticQuotasSnapshotPayload {
  quotas: {
    rollingFiveHourLimit: {
      nextTickAt: string;
      tickPercent: number;
      remaining: number;
      max: number;
      limited: boolean;
    };
  };
  source: "api";
  updatedAt: number;
}

interface UsageStatusDependencies {
  ensureConfig: () => Promise<ResolvedSyntheticConfig>;
  publishConfig: (config: ResolvedSyntheticConfig) => void;
  read: (
    pi: ExtensionAPI,
    respond: (value: SyntheticQuotasSnapshotPayload | undefined) => void,
  ) => void;
  request: (
    pi: ExtensionAPI,
    respond?: (value: SyntheticQuotasSnapshotPayload | undefined) => void,
  ) => void;
}

interface QuotaWarningsDependencies extends UsageStatusDependencies {
  createHistory: () => {
    initialize: () => Promise<void>;
    record: (snapshot: SyntheticQuotasSnapshotPayload) => void;
    getSnapshots: () => SyntheticQuotasSnapshotPayload[];
    flush: () => Promise<void>;
  };
  createNotifier: () => {
    evaluate: (
      quotas: SyntheticQuotasSnapshotPayload["quotas"],
      notify: (message: string, level: "warning") => void,
      projections: Map<string, never>,
    ) => void;
    clearAlertState: () => void;
  };
  buildProjections: () => Map<string, never>;
}

type ActivateUsageStatus = (
  pi: ExtensionAPI,
  dependencies: UsageStatusDependencies,
) => Promise<void>;
type ActivateQuotaWarnings = (
  pi: ExtensionAPI,
  dependencies: QuotaWarningsDependencies,
) => Promise<void>;

const syntheticPackageUrl = new URL(
  "../.pi/packages/choco-pi-provider-synthetic/",
  import.meta.url,
);
// SAFETY: These local module paths are fixed, and the assertions describe only their exported activators.
const usageRuntime = (await import(
  new URL("extensions/usage-status/runtime.ts", syntheticPackageUrl).href
)) as { activateUsageStatus: ActivateUsageStatus };
// SAFETY: These local module paths are fixed, and the assertions describe only their exported activators.
const warningsRuntime = (await import(
  new URL("extensions/quota-warnings/runtime.ts", syntheticPackageUrl).href
)) as { activateQuotaWarnings: ActivateQuotaWarnings };
const { activateUsageStatus } = usageRuntime;
const { activateQuotaWarnings } = warningsRuntime;

type LifecycleHandler = (
  event: Record<string, never>,
  ctx: ExtensionContext,
) => void | Promise<void>;
interface ConfigEventData {
  config: ResolvedSyntheticConfig;
}
type ExtensionEventHandler = (data: ConfigEventData) => void;

function createExtensionApi() {
  const lifecycleHandlers = new Map<string, LifecycleHandler>();
  const extensionHandlers = new Map<string, ExtensionEventHandler>();
  // SAFETY: The extensions only use the on/events members implemented by this fixture.
  const pi = Object.assign(Object.create(null) as ExtensionAPI, {
    on(event: string, handler: LifecycleHandler) {
      lifecycleHandlers.set(event, handler);
    },
    events: {
      on(event: string, handler: ExtensionEventHandler) {
        extensionHandlers.set(event, handler);
        return () => {};
      },
      emit() {},
    },
  });

  return {
    pi,
    invoke(event: string, ctx: ExtensionContext) {
      return lifecycleHandlers.get(event)?.({}, ctx);
    },
    emit(event: string, data: ConfigEventData) {
      extensionHandlers.get(event)?.(data);
    },
  };
}

function createContext() {
  let stale = false;
  let accesses = 0;
  const statuses: Array<[string, string | undefined]> = [];
  const notifications: Array<[string, string | undefined]> = [];
  const ui = {
    setStatus(id: string, value: string | undefined) {
      statuses.push([id, value]);
    },
    notify(message: string, level?: string) {
      notifications.push([message, level]);
    },
    theme: { fg: (_color: string, text: string) => text },
  };
  const read = <T>(value: T): T => {
    accesses += 1;
    if (stale) throw new Error(STALE_CONTEXT_MESSAGE);
    return value;
  };
  const fixture = {
    get hasUI() {
      return read(true);
    },
    get model() {
      return read({ provider: "synthetic" });
    },
    get ui() {
      return read(ui);
    },
  };
  // SAFETY: The fixture supplies every context member exercised by these extensions.
  const ctx = fixture as ExtensionContext;

  return {
    ctx,
    statuses,
    notifications,
    markStale() {
      stale = true;
    },
    accessCount() {
      return accesses;
    },
  };
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const usageConfig: ResolvedSyntheticConfig = {
  configVersion: "1",
  webSearch: true,
  quotasCommand: true,
  usageStatus: true,
  quotaWarnings: false,
  subBarIntegration: true,
  proxyUrl: "",
  proxyRequiresAuth: true,
};

const warningConfig: ResolvedSyntheticConfig = {
  ...usageConfig,
  usageStatus: false,
  quotaWarnings: true,
};

const snapshot: SyntheticQuotasSnapshotPayload = {
  quotas: {
    rollingFiveHourLimit: {
      nextTickAt: "2030-01-01T00:00:00.000Z",
      tickPercent: 0.1,
      remaining: 10,
      max: 100,
      limited: false,
    },
  },
  source: "api",
  updatedAt: 1,
};

function createUsageFixture() {
  let readRespond: ((value: SyntheticQuotasSnapshotPayload | undefined) => void) | undefined;
  let requestRespond: ((value: SyntheticQuotasSnapshotPayload | undefined) => void) | undefined;
  const dependencies = {
    ensureConfig: async () => usageConfig,
    publishConfig() {},
    read(_pi: ExtensionAPI, respond: (value: SyntheticQuotasSnapshotPayload | undefined) => void) {
      readRespond = respond;
    },
    request(
      _pi: ExtensionAPI,
      respond?: (value: SyntheticQuotasSnapshotPayload | undefined) => void,
    ) {
      requestRespond = respond;
    },
  } satisfies UsageStatusDependencies;

  return {
    dependencies,
    readRespond: () => readRespond,
    requestRespond: () => requestRespond,
  };
}

function createWarningsFixture(historyGate = deferred()) {
  let readRespond: ((value: SyntheticQuotasSnapshotPayload | undefined) => void) | undefined;
  let requestRespond: ((value: SyntheticQuotasSnapshotPayload | undefined) => void) | undefined;
  let initializeCount = 0;
  let evaluations = 0;
  const dependencies = {
    ensureConfig: async () => warningConfig,
    publishConfig() {},
    createHistory: () => ({
      initialize() {
        initializeCount += 1;
        return initializeCount === 2 ? historyGate.promise : Promise.resolve();
      },
      record() {},
      getSnapshots: () => [],
      flush: async () => {},
    }),
    createNotifier: () => ({
      evaluate(
        _quotas: SyntheticQuotasSnapshotPayload["quotas"],
        notify: (message: string, level: "warning") => void,
      ) {
        evaluations += 1;
        notify("quota warning", "warning");
      },
      clearAlertState() {},
    }),
    buildProjections: () => new Map<string, never>(),
    read(_pi: ExtensionAPI, respond: (value: SyntheticQuotasSnapshotPayload | undefined) => void) {
      readRespond = respond;
    },
    request(
      _pi: ExtensionAPI,
      respond?: (value: SyntheticQuotasSnapshotPayload | undefined) => void,
    ) {
      requestRespond = respond;
    },
  } satisfies QuotaWarningsDependencies;

  return {
    dependencies,
    historyGate,
    readRespond: () => readRespond,
    requestRespond: () => requestRespond,
    evaluations: () => evaluations,
  };
}

async function shutdownAndStale(
  api: ReturnType<typeof createExtensionApi>,
  oldContext: ReturnType<typeof createContext>,
): Promise<number> {
  await api.invoke("session_shutdown", createContext().ctx);
  oldContext.markStale();
  return oldContext.accessCount();
}

test("usage status ignores stale deferred reads and requests after shutdown", async () => {
  for (const continuation of ["read", "request"] as const) {
    const api = createExtensionApi();
    const fixture = createUsageFixture();
    const oldContext = createContext();
    await activateUsageStatus(api.pi, fixture.dependencies);
    api.invoke("session_start", oldContext.ctx);

    if (continuation === "request") {
      fixture.readRespond()?.(undefined);
      assert.notEqual(fixture.requestRespond(), undefined);
    }

    const accessesBeforeContinuation = await shutdownAndStale(api, oldContext);
    await assert.doesNotReject(async () => {
      if (continuation === "read") fixture.readRespond()?.(snapshot);
      else fixture.requestRespond()?.(snapshot);
      await settle();
    });
    assert.equal(oldContext.accessCount(), accessesBeforeContinuation, continuation);
  }
});

test("usage status keeps the current generation live after a cancelled switch", async () => {
  const api = createExtensionApi();
  const fixture = createUsageFixture();
  const currentContext = createContext();
  await activateUsageStatus(api.pi, fixture.dependencies);

  api.invoke("session_start", currentContext.ctx);
  api.invoke("session_before_switch", currentContext.ctx);
  fixture.readRespond()?.(undefined);
  fixture.requestRespond()?.(snapshot);

  assert.match(currentContext.statuses.at(-1)?.[1] ?? "", /10%/);
});

test("quota warnings ignore stale deferred reads and requests after shutdown", async () => {
  for (const continuation of ["read", "request"] as const) {
    const api = createExtensionApi();
    const fixture = createWarningsFixture();
    const oldContext = createContext();
    await activateQuotaWarnings(api.pi, fixture.dependencies);
    api.invoke("session_start", oldContext.ctx);

    if (continuation === "request") {
      fixture.readRespond()?.(undefined);
      assert.notEqual(fixture.requestRespond(), undefined);
    }

    const accessesBeforeContinuation = await shutdownAndStale(api, oldContext);
    await assert.doesNotReject(async () => {
      if (continuation === "read") fixture.readRespond()?.(snapshot);
      else fixture.requestRespond()?.(snapshot);
      await settle();
    });
    assert.equal(oldContext.accessCount(), accessesBeforeContinuation, continuation);
    assert.equal(fixture.evaluations(), 0, continuation);
  }
});

test("quota warnings do not resume stale history-blocked work after shutdown", async () => {
  const api = createExtensionApi();
  const fixture = createWarningsFixture();
  const oldContext = createContext();
  await activateQuotaWarnings(api.pi, fixture.dependencies);

  api.emit(SYNTHETIC_CONFIG_UPDATED_EVENT, {
    config: { ...warningConfig, quotaWarnings: false },
  });
  api.emit(SYNTHETIC_CONFIG_UPDATED_EVENT, { config: warningConfig });
  api.invoke("session_start", oldContext.ctx);
  fixture.readRespond()?.(snapshot);

  const accessesBeforeContinuation = await shutdownAndStale(api, oldContext);
  await assert.doesNotReject(async () => {
    fixture.historyGate.resolve();
    await settle();
  });
  assert.equal(oldContext.accessCount(), accessesBeforeContinuation);
  assert.equal(fixture.evaluations(), 0);
  assert.deepEqual(oldContext.notifications, []);
});

test("quota warnings keep the current generation live after a cancelled switch", async () => {
  const api = createExtensionApi();
  const fixture = createWarningsFixture();
  const currentContext = createContext();
  await activateQuotaWarnings(api.pi, fixture.dependencies);

  api.invoke("session_start", currentContext.ctx);
  await api.invoke("session_before_switch", currentContext.ctx);
  fixture.readRespond()?.(undefined);
  fixture.requestRespond()?.(snapshot);
  await settle();

  assert.equal(fixture.evaluations(), 1);
  assert.deepEqual(currentContext.notifications, [["quota warning", "warning"]]);
});
