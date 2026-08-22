import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openStatusTab } from "./status-commands.ts";

/**
 * `/context` opens the Context tab of the Status dialog. The report itself is
 * built in `lib/context-report.ts` and painted by `status-commands.ts`; the
 * optional `all` argument only picks the expanded view that Ctrl+O toggles
 * once the tab is open.
 */
export default function contextStatus(pi: ExtensionAPI): void {
  pi.registerCommand("context", {
    description: "Show context usage by prompt, tools, MCP, agents, files, skills, and messages",
    getArgumentCompletions: (prefix) =>
      "all".startsWith(prefix.trim().toLowerCase())
        ? [{ value: "all", label: "all", description: "Expand inventories" }]
        : null,
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase();
      if (mode && mode !== "all") {
        ctx.ui.notify("Usage: /context [all]", "warning");
        return;
      }
      await openStatusTab(ctx, pi.getThinkingLevel(), "context", mode === "all");
    },
  });
}
