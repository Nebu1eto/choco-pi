import { unlink } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export async function deleteSessionRecord(sessionFile: string | undefined): Promise<void> {
  if (!sessionFile) return;
  try {
    await unlink(sessionFile);
  } catch (error) {
    // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export default function sessionAliases(pi: ExtensionAPI): void {
  pi.registerCommand("exit", {
    description: "Quit choco-pi (alias for /quit)",
    handler: async (_args, ctx) => {
      // A host without the TUI sees only the process exit; say it is intended.
      if (ctx.mode !== "tui") ctx.ui.notify("Exiting Pi.", "info");
      ctx.shutdown();
    },
  });

  pi.registerCommand("clear", {
    description: "Start a fresh session while preserving current history (alias for /new)",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      // The TUI shows the fresh session itself; other hosts get a notice from
      // the replacement context, because session replacement invalidates `ctx`.
      const result = await ctx.newSession(
        ctx.mode === "tui"
          ? undefined
          : {
              withSession: async (fresh) => {
                fresh.ui.notify("Started a new session.", "info");
              },
            },
      );
      if (result.cancelled) {
        ctx.ui.notify("Starting a new session was cancelled.", "info");
      }
    },
  });

  pi.registerCommand("delete", {
    description: "Permanently delete this session and exit",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const confirmed = await ctx.ui.confirm(
        "Permanently delete this session?",
        "This deletes the Pi session record and exits. This cannot be undone.",
      );
      if (!confirmed) return;

      try {
        await deleteSessionRecord(ctx.sessionManager.getSessionFile());
        if (ctx.mode !== "tui") ctx.ui.notify("Deleted this session. Exiting Pi.", "info");
        ctx.shutdown();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Session deletion failed: ${message}`, "error");
      }
    },
  });
}
