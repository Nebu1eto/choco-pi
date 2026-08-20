import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodexConversionConfig } from "../../adapter/activation/config.ts";
import {
	clearFolderCodexConversionConfig,
	getCodexConversionConfigPath,
	getProjectCodexConversionConfigPath,
	hasFolderCodexConversionConfig,
	materializeFolderCodexConversionConfig,
	readCodexConversionConfig,
	readEffectiveCodexConversionConfig,
	readLayeredCodexConversionConfig,
	setProjectCodexCacheKeepalive,
	type CodexConversionConfigScope,
	writeCodexConversionConfig,
} from "../../adapter/activation/config-store.ts";
import { syncAdapter } from "../../adapter/activation/activation.ts";
import type { AdapterState } from "../../adapter/activation/state.ts";
import { ROUTABLE_SETTINGS_TABS, parseSettingsTab, type SettingsTab } from "./tabs.ts";
import { openCodexSettingsScreen } from "./screen.ts";

const CODEX_COMMAND_COMPLETIONS = [...ROUTABLE_SETTINGS_TABS.map(({ id }) => id)];
const CODEX_USAGE = "Usage: /codex [tools|openai|display|usage|about]";

export function registerCodexCommand(
	pi: ExtensionAPI,
	state: AdapterState,
	onConfigApplied?: (config: CodexConversionConfig, ctx: ExtensionContext, previousConfig: CodexConversionConfig) => void,
): void {
	function effectiveConfig(ctx: ExtensionContext): CodexConversionConfig {
		return readEffectiveCodexConversionConfig({
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
		});
	}

	function applyEffectiveConfig(ctx: ExtensionContext, previousConfig: CodexConversionConfig): void {
		const config = effectiveConfig(ctx);
		state.config = config;
		state.executionMode = config.executionMode;
		onConfigApplied?.(config, ctx, previousConfig);
		syncAdapter(pi, ctx, state);
	}

	function saveAndApply(
		ctx: ExtensionContext,
		scope: CodexConversionConfigScope,
		nextConfig: CodexConversionConfig,
	): boolean {
		const path = scope === "folder"
			? getProjectCodexConversionConfigPath(ctx.cwd)
			: getCodexConversionConfigPath();
		const writeResult = writeCodexConversionConfig(nextConfig, path, scope === "folder");
		if (!writeResult.ok) {
			ctx.ui.notify(`Failed to save Codex settings: ${writeResult.error}`, "error");
			return false;
		}
		const previousConfig = state.config;
		applyEffectiveConfig(ctx, previousConfig);
		return true;
	}

	async function openSettings(ctx: ExtensionContext, tab: SettingsTab): Promise<void> {
		if (!ctx.hasUI) {
			if (tab === "usage") {
				const [{ fetchCodexUsage }, { formatCodexUsage }] = await Promise.all([
					import("../../codex-usage/client.ts"),
					import("../../codex-usage/format.ts"),
				]);
				try {
					ctx.ui.notify(formatCodexUsage(await fetchCodexUsage(ctx)), "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			ctx.ui.notify(formatCodexSettings(state.config), "info");
			return;
		}
		let configScope: CodexConversionConfigScope = hasFolderCodexConversionConfig(
			ctx.cwd,
			ctx.isProjectTrusted(),
		) ? "folder" : "global";
		if (configScope === "folder") {
			const materialized = materializeFolderCodexConversionConfig(ctx.cwd, true);
			if (!materialized.ok) {
				ctx.ui.notify(`Could not materialize folder Codex settings: ${materialized.error}`, "error");
				return;
			}
		}
		const readSelectedConfig = () => {
			const selected = configScope === "folder"
				? readLayeredCodexConversionConfig({ cwd: ctx.cwd, projectTrusted: true })
				: readCodexConversionConfig();
			return {
				...selected,
				openai: {
					...selected.openai,
					cacheKeepalive: effectiveConfig(ctx).openai.cacheKeepalive,
				},
			};
		};
		await openCodexSettingsScreen(ctx, {
			initialConfig: readSelectedConfig(),
			initialTab: tab,
			onChange: (config) => saveAndApply(ctx, configScope, config),
			onProjectCacheKeepalive: (enabled) => {
				const result = setProjectCodexCacheKeepalive(ctx.cwd, ctx.isProjectTrusted(), enabled);
				if (!result.ok) {
					ctx.ui.notify(`Failed to save project cache keepalive: ${result.error}`, "error");
					return undefined;
				}
				const previousConfig = state.config;
				applyEffectiveConfig(ctx, previousConfig);
				return readSelectedConfig();
			},
			configScope: {
				current: () => configScope,
				canUseFolder: ctx.isProjectTrusted(),
				path: () => configScope === "folder"
					? getProjectCodexConversionConfigPath(ctx.cwd)
					: getCodexConversionConfigPath(),
				reload: readSelectedConfig,
				set: (scope) => {
					const previousConfig = state.config;
					const result = scope === "folder"
						? materializeFolderCodexConversionConfig(ctx.cwd, ctx.isProjectTrusted())
						: clearFolderCodexConversionConfig(ctx.cwd, ctx.isProjectTrusted());
					if (!result.ok) {
						ctx.ui.notify(`Could not change Codex settings scope: ${result.error}`, "error");
						return undefined;
					}
					configScope = scope;
					applyEffectiveConfig(ctx, previousConfig);
					return readSelectedConfig();
				},
			},
		});
	}

	pi.registerCommand("codex", {
		description: "Configure Codex adapter settings",
		getArgumentCompletions: (prefix) =>
			CODEX_COMMAND_COMPLETIONS.filter((item) => item.startsWith(prefix.trim().toLowerCase())).map((value) => ({ label: value, value })),
		handler: async (args, ctx) => {
			state.config = effectiveConfig(ctx);
			const arg = args.trim().toLowerCase();

			const tab = arg ? parseSettingsTab(arg) : "adapter";
			if (tab) {
				await openSettings(ctx, tab);
				return;
			}
			ctx.ui.notify(CODEX_USAGE, "warning");
		},
	});
}

function formatAllProvidersMode(value: CodexConversionConfig["scope"]["allProviders"]): string {
	return value === "extras" ? "only extras" : value;
}

function formatCodexSettings(config: CodexConversionConfig): string {
	return `Codex settings: extension ${config.voiceFeaturesOnly ? "extra tools only" : "full adapter"}, execution ${config.executionMode}, providers ${formatAllProvidersMode(config.scope.allProviders)}, Rust binaries ${config.tools.customRustBinariesDir || "bundled"}, heavy prompt overwrite ${config.prompt.heavySystemPromptOverwrite ? "on" : "off"}, harness identifier ${config.openai.harnessIdentifierHeader ? "on" : "off"}, Proxy Responses Lite ${config.openai.proxyResponsesLite ? "on" : "off"}, compaction V2 ${config.compaction.responsesCompaction ? "on" : "off"}, cache diagnostics ${config.openai.cacheDiagnostics}, fast ${config.openai.fast ? "on" : "off"}, verbosity ${config.openai.verbosity}`;
}
