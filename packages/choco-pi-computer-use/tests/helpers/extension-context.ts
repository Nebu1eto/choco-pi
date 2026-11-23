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

export interface TestUiOptions {
  select?: ExtensionUIContext["select"];
  notify?: ExtensionUIContext["notify"];
  mode?: ExtensionMode;
}

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
