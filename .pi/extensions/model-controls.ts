import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function supportedThinkingLevels(model: Model<any>): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		return level !== "xhigh" && level !== "max" || mapped !== undefined;
	});
}

function isCodexModel(model: Model<any> | undefined): boolean {
	return model?.provider === "openai-codex";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default function modelControls(pi: ExtensionAPI): void {
	let fastEnabled = false;
	let effortCompletions: ThinkingLevel[] = ["off"];

	const updateEffortCompletions = (model: Model<any> | undefined): void => {
		effortCompletions = model ? supportedThinkingLevels(model) : ["off"];
	};

	pi.on("session_start", (_event, ctx) => updateEffortCompletions(ctx.model));
	pi.on("model_select", (_event, ctx) => updateEffortCompletions(ctx.model));

	pi.registerCommand("effort", {
		description: "Set reasoning effort: /effort [off|minimal|low|medium|high|xhigh|max]",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trim().toLowerCase();
			const matches = effortCompletions.filter((level) => level.startsWith(normalized));
			return matches.length > 0 ? matches.map((level) => ({ value: level, label: level })) : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.model) {
				ctx.ui.notify("No model is currently selected.", "warning");
				return;
			}

			const current = pi.getThinkingLevel();
			const levels = supportedThinkingLevels(ctx.model);
			const requested = args.trim().toLowerCase();
			if (requested) {
				if (!levels.includes(requested as ThinkingLevel)) {
					ctx.ui.notify(`Unsupported reasoning effort. Available: ${levels.join(", ")}`, "warning");
					return;
				}
				pi.setThinkingLevel(requested as ThinkingLevel);
				ctx.ui.notify(`Reasoning effort: ${requested}`, "info");
				return;
			}

			const labels = levels.map((level) => level === current ? `${level} (current)` : level);
			const selected = await ctx.ui.select("Reasoning effort", labels);
			if (!selected) return;

			const level = selected.replace(/ \(current\)$/, "") as ThinkingLevel;
			pi.setThinkingLevel(level);
			ctx.ui.notify(`Reasoning effort: ${level}`, "info");
		},
	});

	pi.registerCommand("fast", {
		description: "Control OpenAI Codex Fast mode: /fast [on|off|status]",
		handler: (args, ctx) => {
			if (!isCodexModel(ctx.model)) {
				ctx.ui.notify("/fast is available only for OpenAI Codex models.", "warning");
				return;
			}

			const action = args.trim().toLowerCase();
			if (action === "status") {
				ctx.ui.notify(`Fast mode: ${fastEnabled ? "on" : "off"}`, "info");
				return;
			}
			if (action && action !== "on" && action !== "off") {
				ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
				return;
			}

			fastEnabled = action === "on" || action === "" && !fastEnabled;
			ctx.ui.notify(`Fast mode: ${fastEnabled ? "on" : "off"}`, "info");
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!fastEnabled || !isCodexModel(ctx.model) || !isRecord(event.payload)) return;
		return { ...event.payload, service_tier: "priority" };
	});
}
