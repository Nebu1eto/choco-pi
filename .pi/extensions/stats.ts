import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerStatsTiming } from "./lib/stats/timing.ts";
import { openStatusTab } from "./status-commands.ts";

/**
 * `/stats` opens the Statistics tab of the Status dialog: token usage and
 * metered cost over a period, computed from every session log with fork and
 * rewind copies counted once, split by model and by the feature that
 * triggered each call, plus throughput and time to first token per provider
 * and model. The tab itself is rendered by `lib/stats/` and painted by
 * `status-commands.ts`.
 *
 * The same extension records time to first token for every assistant
 * response, since Pi persists only the request start and total duration.
 */
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
