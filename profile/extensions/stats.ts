import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerStatsTiming } from "./lib/stats/timing.ts";
import { openStatusTab } from "./status-commands.ts";

export default function stats(pi: ExtensionAPI): void {
  registerStatsTiming(pi);
  pi.registerCommand("stats", {
    description:
      "Show token usage, metered cost, feature and model breakdown, and model speed (Statistics tab)",
    handler: async (_args, ctx) => {
      await openStatusTab(ctx, pi.getThinkingLevel(), "stats");
    },
  });
}
