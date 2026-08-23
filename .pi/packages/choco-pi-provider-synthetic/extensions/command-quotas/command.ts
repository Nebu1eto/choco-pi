import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

interface CommandHandlerRuntime {
  handleQuotasCommand(args: string, ctx: ExtensionCommandContext): Promise<void>;
}

let handlerRuntimePromise: Promise<CommandHandlerRuntime> | undefined;

function loadHandlerRuntime(): Promise<CommandHandlerRuntime> {
  handlerRuntimePromise ??= import("./handler.ts");
  return handlerRuntimePromise;
}

export function registerQuotasCommand(pi: ExtensionAPI): void {
  pi.registerCommand("synthetic:quotas", {
    description: "Display Synthetic API usage quotas",
    handler: async (args, ctx) => {
      const runtime = await loadHandlerRuntime();
      await runtime.handleQuotasCommand(args, ctx);
    },
  });
}
