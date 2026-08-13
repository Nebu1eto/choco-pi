import assert from "node:assert/strict";
import test from "node:test";
import providerUsage from "../.pi/extensions/provider-usage.ts";

test("registers /quota as a white-text alias for /usage", async () => {
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	providerUsage({
		registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
			commands.set(name, command);
		},
	} as any);

	assert.equal(commands.get("quota"), commands.get("usage"));

	const notifications: Array<[string, string]> = [];
	await commands.get("quota")?.handler("", {
		modelRegistry: {
			getProviderAuthStatus: () => ({ configured: false }),
		},
		ui: {
			theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
			notify: (text: string, level: string) => notifications.push([text, level]),
		},
	});

	assert.equal(notifications.length, 1);
	assert.equal(notifications[0]?.[1], "info");
	assert.match(notifications[0]?.[0] ?? "", /^<text>Claude Code — not connected/);
});
