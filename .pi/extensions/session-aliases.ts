import { unlink } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export async function deleteSessionRecord(sessionFile: string | undefined): Promise<void> {
	if (!sessionFile) return;
	try {
		await unlink(sessionFile);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export default function sessionAliases(pi: ExtensionAPI): void {
	pi.registerCommand("exit", {
		description: "Quit choco-pi (alias for /quit)",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});

	pi.registerCommand("clear", {
		description: "Start a fresh session while preserving current history (alias for /new)",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const result = await ctx.newSession();
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
				ctx.shutdown();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Session deletion failed: ${message}`, "error");
			}
		},
	});
}
