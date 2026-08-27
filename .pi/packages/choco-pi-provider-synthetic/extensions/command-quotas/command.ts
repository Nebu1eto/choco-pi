import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

interface CommandHandlerRuntime {
  handleQuotasCommand(
    args: string,
    ctx: ExtensionCommandContext,
    isCurrent: () => boolean,
  ): Promise<void>;
}

let handlerRuntimePromise: Promise<CommandHandlerRuntime> | undefined;

function loadHandlerRuntime(): Promise<CommandHandlerRuntime> {
  handlerRuntimePromise ??= import("./handler.ts");
  return handlerRuntimePromise;
}

export function registerQuotasCommand(
  pi: ExtensionAPI,
  loadRuntime: () => Promise<CommandHandlerRuntime> = loadHandlerRuntime,
): void {
  let generation = 0;
  let activeGeneration: number | undefined;

  pi.on("session_start", () => {
    activeGeneration = ++generation;
  });

  pi.on("session_shutdown", () => {
    generation += 1;
    activeGeneration = undefined;
  });

  pi.registerCommand("synthetic:quotas", {
    description: "Display Synthetic API usage quotas",
    handler: async (args, ctx) => {
      const capturedGeneration = activeGeneration;
      const isCurrent = () =>
        capturedGeneration !== undefined && activeGeneration === capturedGeneration;
      const runtime = await loadRuntime();
      if (!isCurrent()) return;
      await runtime.handleQuotasCommand(args, ctx, isCurrent);
    },
  });
}
