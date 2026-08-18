import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, matchesKey, ScrollView, Text } from "@earendil-works/pi-tui";
import { formatStatus, summarizeStatusRows } from "./session-status.ts";
import { usageReport } from "./provider-usage.ts";

export type StatusTabId = "status" | "usage";

export const STATUS_TABS: ReadonlyArray<{ id: StatusTabId; title: string }> = [
	{ id: "status", title: "Status" },
	{ id: "usage", title: "Usage" },
];

/** How often an open Usage tab re-queries the providers. */
export const USAGE_REFRESH_MS = 3 * 60_000;

/** Tabs whose body comes from a remote provider and therefore goes stale while the view stays open. */
const AUTO_REFRESH_TABS: ReadonlySet<StatusTabId> = new Set<StatusTabId>(["usage"]);

export type TabController = {
	/** Switch to a tab, repaint the last body, and re-query it. */
	activate: (id: StatusTabId) => void;
	/** Stop the refresh timer. */
	dispose: () => void;
};

/**
 * Keeps the visible tab body current: every activation re-queries the tab, and
 * an auto-refreshing tab is re-queried again every `intervalMs` while it stays
 * open. A cached body is painted immediately so a refetch never blanks the view,
 * and a failed background refresh keeps the last good body instead of replacing it.
 */
export function createTabController(options: {
	load: (id: StatusTabId) => Promise<string>;
	paint: (body: string, view: { preserveScroll: boolean }) => void;
	loading: string;
	failure: (id: StatusTabId, message: string) => string;
	intervalMs?: number;
}): TabController {
	const cache = new Map<StatusTabId, string>();
	const intervalMs = options.intervalMs ?? USAGE_REFRESH_MS;
	let active: StatusTabId | undefined;
	let token = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	const query = (id: StatusTabId, background: boolean): void => {
		const current = ++token;
		options.load(id)
			.then((body) => {
				cache.set(id, body);
				if (current === token && active === id) options.paint(body, { preserveScroll: background });
			})
			.catch((error: unknown) => {
				if (current !== token || active !== id || cache.has(id)) return;
				const message = error instanceof Error ? error.message : String(error);
				options.paint(options.failure(id, message), { preserveScroll: background });
			});
	};
	const restartTimer = (): void => {
		if (timer !== undefined) clearInterval(timer);
		timer = setInterval(() => {
			if (active !== undefined && AUTO_REFRESH_TABS.has(active)) query(active, true);
		}, intervalMs);
		timer.unref?.();
	};
	return {
		activate: (id: StatusTabId) => {
			active = id;
			options.paint(cache.get(id) ?? options.loading, { preserveScroll: false });
			restartTimer();
			query(id, false);
		},
		dispose: () => {
			if (timer !== undefined) clearInterval(timer);
			timer = undefined;
			token++;
		},
	};
}

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
		let active = initial;

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

		const paint = (body: string, view: { preserveScroll: boolean }): void => {
			text.setText(`${header()}\n\n${body}\n\n${hint()}`);
			if (!view.preserveScroll) scrollView.scrollToStart();
			tui.requestRender();
		};

		const controller = createTabController({
			load: (id) => tabBody(ctx, thinkingLevel, id, true),
			paint,
			loading: theme.fg("dim", "Loading…"),
			failure: (id, message) => theme.fg("error", `Failed to load the ${id} tab: ${message}`),
		});

		const activate = (id: StatusTabId): void => {
			active = id;
			controller.activate(id);
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
			dispose: () => controller.dispose(),
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
