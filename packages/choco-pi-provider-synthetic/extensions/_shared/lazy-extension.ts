import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface LazyRuntime {
  default(pi: ExtensionAPI): void | Promise<void>;
}

export function createLazyExtension(
  load: () => Promise<LazyRuntime>,
): (pi: ExtensionAPI) => Promise<void> {
  let runtimePromise: Promise<LazyRuntime> | undefined;
  return async (pi) => {
    runtimePromise ??= load();
    const runtime = await runtimePromise;
    await runtime.default(pi);
  };
}
