import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { deleteResult, getAllResults } from "./storage.ts";
import { isCommandEnabled, type WebSearchConfig } from "./extension-config.ts";

export function registerWebAccessCommands(pi: ExtensionAPI, initConfig: WebSearchConfig): void {
  if (!isCommandEnabled(initConfig, "search")) return;
  pi.registerCommand("search", {
    description: "Browse stored web search results",
    handler: async (_args, ctx) => {
      const results = getAllResults();

      if (results.length === 0) {
        ctx.ui.notify("No stored search results", "info");
        return;
      }

      const options = results.map((r) => {
        const age = Math.floor((Date.now() - r.timestamp) / 60000);
        const ageStr = age < 60 ? `${age}m ago` : `${Math.floor(age / 60)}h ago`;
        if (r.type === "search" && r.queries) {
          const query = r.queries[0]?.query || "unknown";
          return `[${r.id.slice(0, 6)}] "${query}" (${r.queries.length} queries) - ${ageStr}`;
        }
        if (r.type === "fetch" && (r.urls || r.urlMetadata)) {
          return `[${r.id.slice(0, 6)}] ${(r.urls ?? r.urlMetadata ?? []).length} URLs fetched - ${ageStr}`;
        }
        return `[${r.id.slice(0, 6)}] ${r.type} - ${ageStr}`;
      });

      const choice = await ctx.ui.select("Stored Search Results", options);
      if (!choice) return;

      const match = choice.match(/^\[([a-z0-9]+)\]/);
      if (!match) return;

      const selected = results.find((r) => r.id.startsWith(match[1]));
      if (!selected) return;

      const actions = ["View details", "Delete"];
      const action = await ctx.ui.select(`Result ${selected.id.slice(0, 6)}`, actions);

      if (action === "Delete") {
        deleteResult(selected.id);
        ctx.ui.notify(`Deleted ${selected.id.slice(0, 6)}`, "info");
      } else if (action === "View details") {
        let info = `ID: ${selected.id}\nType: ${selected.type}\nAge: ${Math.floor((Date.now() - selected.timestamp) / 60000)}m\n\n`;
        if (selected.summary) {
          const preview =
            selected.summary.length > 400
              ? `${selected.summary.slice(0, 397)}...`
              : selected.summary;
          info += `Summary:\n${preview}\n\n`;
        }
        if (selected.type === "search" && selected.queries) {
          info += "Queries:\n";
          const queries = selected.queries.slice(0, 10);
          for (const q of queries) {
            info += `- "${q.query}" (${q.results.length} results)\n`;
          }
          if (selected.queries.length > 10) {
            info += `... and ${selected.queries.length - 10} more\n`;
          }
        }
        if (selected.type === "fetch" && (selected.urls || selected.urlMetadata)) {
          info += "URLs:\n";
          const urlItems = selected.urls ?? selected.urlMetadata ?? [];
          const urls = urlItems.slice(0, 10);
          for (const u of urls) {
            const urlDisplay = u.url.length > 50 ? u.url.slice(0, 47) + "..." : u.url;
            const contentLength = "content" in u ? u.content.length : u.contentLength;
            info += `- ${urlDisplay} (${u.error || `${contentLength} chars`})\n`;
          }
          if (urlItems.length > 10) {
            info += `... and ${urlItems.length - 10} more\n`;
          }
        }
        ctx.ui.notify(info, "info");
      }
    },
  });
}
