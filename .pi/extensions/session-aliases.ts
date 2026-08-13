import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
}
