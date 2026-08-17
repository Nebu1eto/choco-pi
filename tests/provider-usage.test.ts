import assert from "node:assert/strict";
import test from "node:test";
import statusCommands, { STATUS_TABS, tabBody } from "../.pi/extensions/status-commands.ts";

test("status tabs expose Status and Usage in order", () => {
	assert.deepEqual(STATUS_TABS.map((tab) => tab.title), ["Status", "Usage"]);
});

test("usage tab keeps the white body text for readability", async () => {
	const body = await tabBody({
		modelRegistry: { getProviderAuthStatus: () => ({ configured: false }) },
		ui: { theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` } },
	} as any, "medium", "usage", true);
	assert.match(body, /^<text>Claude Code — not connected/);
});

test("registers /quota as a white-text alias for /usage", async () => {
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	statusCommands({
		registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
			commands.set(name, command);
		},
		getThinkingLevel: () => "medium",
	} as any);

	assert.equal(commands.get("quota"), commands.get("usage"));
	assert.equal(commands.has("settings"), false);

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
