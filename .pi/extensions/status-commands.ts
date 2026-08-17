import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, matchesKey, ScrollView, Text } from "@earendil-works/pi-tui";
import { formatStatus, summarizeStatusRows } from "./session-status.ts";
import { usageReport } from "./provider-usage.ts";

export type StatusTabId = "status" | "usage";

export const STATUS_TABS: ReadonlyArray<{ id: StatusTabId; title: string }> = [
	{ id: "status", title: "Status" },
	{ id: "usage", title: "Usage" },
];

export function tabBody(
	ctx: ExtensionCommandContext,
	thinkingLevel: string,
	id: StatusTabId,
	styled: boolean,
): Promise<string> {
	const style = styled ? ctx.ui.theme : undefined;
	if (id === "usage") {
		return usageReport(ctx).then((report) => style ? style.fg("text", report) : report);
	}
	return Promise.resolve(formatStatus(summarizeStatusRows(ctx, thinkingLevel), style));
}

async function showTab(
	ctx: ExtensionCommandContext,
	thinkingLevel: string,
	initial: StatusTabId,
): Promise<void> {
	if (ctx.mode !== "tui") {
		const body = await tabBody(ctx, thinkingLevel, initial, false);
		ctx.ui.notify(ctx.ui.theme.fg("text", body), "info");
		return;
	}
	await ctx.ui.custom((tui, theme, _keybindings, done) => {
		const cache = new Map<StatusTabId, string>();
		let active = initial;
		let loadToken = 0;

		const text = new Text("", 0, 0);
		const component = new Box(1, 1, (value) => theme.fg("border", value));
		component.addChild(text);
		const scrollView = new ScrollView(component, {
			primary: true,
			scrollbar: "auto",
			scrollbarStyle: (value) => theme.fg("dim", value),
		});

		const header = (): string => STATUS_TABS.map((tab) => {
			const label = `  ${tab.title}  `;
			return tab.id === active ? theme.fg("accent", theme.bold(label)) : theme.fg("dim", label);
		}).join(theme.fg("dim", "·"));
		const hint = (): string => theme.fg("dim", "←/→ or Tab switches tabs · ↑/↓ scrolls · Enter/Esc closes");

		const paint = (body: string): void => {
			text.setText(`${header()}\n\n${body}\n\n${hint()}`);
			scrollView.scrollToStart();
			tui.requestRender();
		};

		const activate = (id: StatusTabId): void => {
			active = id;
			const cached = cache.get(id);
			if (cached !== undefined) {
				paint(cached);
				return;
			}
			const token = ++loadToken;
			paint(theme.fg("dim", "Loading…"));
			tabBody(ctx, thinkingLevel, id, true)
				.then((body) => {
					cache.set(id, body);
					if (token === loadToken) paint(body);
				})
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					if (token === loadToken) paint(theme.fg("error", `Failed to load the ${id} tab: ${message}`));
				});
		};

		const switchTab = (delta: -1 | 1): void => {
			const index = STATUS_TABS.findIndex((tab) => tab.id === active);
			const next = STATUS_TABS[(index + delta + STATUS_TABS.length) % STATUS_TABS.length];
			activate(next.id);
		};

		activate(initial);

		return {
			render: (width: number) => scrollView.render(width),
			invalidate: () => scrollView.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
					done(undefined);
				} else if (matchesKey(data, "tab") || matchesKey(data, "right")) {
					switchTab(1);
				} else if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
					switchTab(-1);
				} else if (matchesKey(data, "up")) {
					scrollView.scrollBy(-1);
					tui.requestRender();
				} else if (matchesKey(data, "down")) {
					scrollView.scrollBy(1);
					tui.requestRender();
				} else if (matchesKey(data, "pageUp")) {
					scrollView.scrollBy(-Math.max(1, scrollView.viewportHeight - 1));
					tui.requestRender();
				} else if (matchesKey(data, "pageDown")) {
					scrollView.scrollBy(Math.max(1, scrollView.viewportHeight - 1));
					tui.requestRender();
				}
			},
		};
	});
}

export default function statusCommands(pi: ExtensionAPI): void {
	pi.registerCommand("status", {
		description: "Show session, model, context, MCP, and environment status (Status/Usage tabs)",
		handler: async (_args, ctx) => showTab(ctx, pi.getThinkingLevel(), "status"),
	});
	const usageCommand = {
		description: "Show connected Claude Code, OpenAI Codex, and Synthetic usage (Status/Usage tabs)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => showTab(ctx, pi.getThinkingLevel(), "usage"),
	};
	pi.registerCommand("usage", usageCommand);
	pi.registerCommand("quota", usageCommand);
}
