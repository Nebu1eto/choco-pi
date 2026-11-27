import assert from "node:assert/strict";
import test from "node:test";
import {
  createEventBus,
  createExtensionRuntime,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import {
  getSearchScope,
  unifiedSearchCore,
  type SearchScope,
} from "../../choco-pi-web-search/index.ts";
import { registeredCanonicalSearchFrontend } from "../../choco-pi-web-search/tests/fixtures/registered-canonical-tool.ts";
import googleAntigravityWebSearch from "../extensions/web-search/index.ts";
import {
  createGoogleSearchRegistrationGate,
  GOOGLE_SEARCH_ADAPTER_ID,
} from "../src/search/adapter.ts";
import { signInRegistry, type GoogleSignIn } from "./helpers.ts";

const CWD = "/tmp/choco-pi-google-search-registration";

async function load(factories: ExtensionFactory[]) {
  const bus = createEventBus();
  const loaded = [];
  for (const [index, factory] of factories.entries()) {
    loaded.push(
      await loadExtensionFromFactory(
        factory,
        CWD,
        bus,
        createExtensionRuntime(),
        `<inline:${index}>`,
      ),
    );
  }
  return { bus, loaded };
}

interface RegistryState {
  configured: boolean;
  reads: number;
  signIn?: GoogleSignIn;
}

function registryWith(state: RegistryState) {
  return {
    modelRegistry: {
      ...signInRegistry(() => (state.configured ? (state.signIn ?? "oauth") : "none")),
      getApiKeyForProvider: async () => {
        state.reads += 1;
        return undefined;
      },
    },
  };
}

type LoadedExtension = Awaited<ReturnType<typeof load>>["loaded"][number];

async function syncSignedIn(extension: LoadedExtension) {
  const ctx = registryWith({ configured: true, reads: 0 });
  for (const event of ["session_start", "session_tree", "model_select"]) {
    for (const handler of extension.handlers.get(event) ?? []) await handler({ type: event }, ctx);
  }
}

test("without the unified search core the extension registers nothing", async () => {
  const { bus, loaded } = await load([googleAntigravityWebSearch]);
  const extension = loaded[0];
  assert.ok(extension);
  assert.equal(extension.tools.size, 0);
  await syncSignedIn(extension);
  assert.equal(getSearchScope(bus).adapters.has(GOOGLE_SEARCH_ADAPTER_ID), false);
});

test("a core without a confirmed canonical frontend still registers nothing", async () => {
  const { bus, loaded } = await load([unifiedSearchCore, googleAntigravityWebSearch]);
  const extension = loaded[1];
  assert.ok(extension);
  assert.equal(extension.tools.size, 0);
  await syncSignedIn(extension);
  assert.equal(getSearchScope(bus).adapters.has(GOOGLE_SEARCH_ADAPTER_ID), false);
});

test("after the full handshake the adapter follows the sign-in state without reading credentials", async () => {
  const { bus, loaded } = await load([
    unifiedSearchCore,
    registeredCanonicalSearchFrontend,
    googleAntigravityWebSearch,
  ]);
  const extension = loaded[2];
  assert.ok(extension);
  assert.equal(extension.tools.size, 0);
  const scope: SearchScope = getSearchScope(bus);
  const state: RegistryState = { configured: false, reads: 0 };
  const ctx = registryWith(state);
  const emit = async (event: string) => {
    for (const handler of extension.handlers.get(event) ?? []) await handler({ type: event }, ctx);
  };

  await emit("session_start");
  assert.equal(scope.adapters.has(GOOGLE_SEARCH_ADAPTER_ID), false);
  state.configured = true;
  await emit("model_select");
  const adapter = scope.adapters.get(GOOGLE_SEARCH_ADAPTER_ID);
  assert.equal(adapter?.family, "google");
  assert.equal(adapter?.explicitOnly, true);
  await emit("session_tree");
  assert.equal(scope.adapters.get(GOOGLE_SEARCH_ADAPTER_ID), adapter);
  state.configured = false;
  await emit("session_tree");
  assert.equal(scope.adapters.has(GOOGLE_SEARCH_ADAPTER_ID), false);
  state.configured = true;
  await emit("session_start");
  assert.equal(scope.adapters.has(GOOGLE_SEARCH_ADAPTER_ID), true);
  state.signIn = "stored_api_key";
  await emit("model_select");
  assert.equal(scope.adapters.has(GOOGLE_SEARCH_ADAPTER_ID), false);
  state.signIn = "env_api_key";
  await emit("session_tree");
  assert.equal(scope.adapters.has(GOOGLE_SEARCH_ADAPTER_ID), false);
  state.signIn = "oauth";
  await emit("session_start");
  assert.equal(scope.adapters.has(GOOGLE_SEARCH_ADAPTER_ID), true);
  await emit("session_shutdown");
  assert.equal(scope.adapters.has(GOOGLE_SEARCH_ADAPTER_ID), false);
  assert.equal(state.reads, 0);
});

test("loaded before the frontend confirms web_search, the adapter still appears at session start", async () => {
  const { bus, loaded } = await load([
    unifiedSearchCore,
    googleAntigravityWebSearch,
    registeredCanonicalSearchFrontend,
  ]);
  const extension = loaded[1];
  assert.ok(extension);
  assert.equal(extension.tools.size, 0);
  const scope: SearchScope = getSearchScope(bus);
  const ctx = registryWith({ configured: true, reads: 0 });
  for (const handler of extension.handlers.get("session_start") ?? []) {
    await handler({ type: "session_start" }, ctx);
  }
  assert.equal(scope.adapters.get(GOOGLE_SEARCH_ADAPTER_ID)?.family, "google");
  for (const handler of extension.handlers.get("session_shutdown") ?? []) {
    await handler({ type: "session_shutdown" }, ctx);
  }
  assert.equal(scope.adapters.has(GOOGLE_SEARCH_ADAPTER_ID), false);
});

test("the gate treats a missing or throwing registry as signed out", async () => {
  const { bus } = await load([]);
  const scope = getSearchScope(bus);
  const gate = createGoogleSearchRegistrationGate(scope);
  const state = { configured: true, reads: 0 };
  assert.equal(gate.sync(registryWith(state).modelRegistry), true);
  assert.equal(
    gate.sync({
      ...signInRegistry(() => "oauth"),
      getProviderAuthStatus: () => {
        throw new Error("registry unavailable");
      },
    }),
    false,
  );
  assert.equal(scope.adapters.has(GOOGLE_SEARCH_ADAPTER_ID), false);
  assert.equal(gate.sync(undefined), false);
  gate.dispose();
});
