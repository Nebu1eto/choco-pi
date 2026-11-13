import {
  createExtensionRuntime,
  type ExtensionContext,
  type ExtensionUIContext,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

type ExtensionMode = ExtensionContext["mode"];

/** Optional host UI for tests: a `select` stub bound through the runner, and the host mode. */
export interface TestUiOptions {
  select?: ExtensionUIContext["select"];
  notify?: ExtensionUIContext["notify"];
  mode?: ExtensionMode;
}

/**
 * A complete, host-built `ExtensionContext` for bridge tests.
 *
 * The host's own `ExtensionRunner.createContext()` supplies every member, so
 * the fixture satisfies the real type without a cast. Nothing touches user
 * state: credentials are an empty in-memory store, no models file is read,
 * the model catalog is not refreshed, and the session is in memory. With no
 * `ui` option, no UI context is bound and `hasUI` is false; with one, the
 * runner's no-op UI is extended with the given stubs and `hasUI` is true.
 */
export async function createTestExtensionContext(
  cwd: string,
  ui?: TestUiOptions,
): Promise<ExtensionContext> {
  const runtime = await ModelRuntime.create({
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async () => undefined,
      delete: async () => undefined,
    },
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const runner = new ExtensionRunner(
    [],
    createExtensionRuntime(),
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(runtime),
  );
  if (ui) {
    const base = runner.getUIContext();
    runner.setUIContext(
      {
        ...base,
        select: ui.select ?? base.select,
        notify: ui.notify ?? base.notify,
      },
      ui.mode ?? "tui",
    );
  }
  return runner.createContext();
}
