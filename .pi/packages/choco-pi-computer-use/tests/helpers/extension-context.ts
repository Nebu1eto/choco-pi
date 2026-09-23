import {
  createExtensionRuntime,
  type ExtensionContext,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

/**
 * A complete, host-built `ExtensionContext` for bridge tests.
 *
 * The host's own `ExtensionRunner.createContext()` supplies every member, so
 * the fixture satisfies the real type without a cast. Nothing touches user
 * state: credentials are an empty in-memory store, no models file is read,
 * the model catalog is not refreshed, and the session is in memory. With no
 * UI context bound, `hasUI` is false.
 */
export async function createTestExtensionContext(cwd: string): Promise<ExtensionContext> {
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
  return runner.createContext();
}
