import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type ContextCapConfig = {
	defaultCap?: number;
	defaultCompactAt?: number;
	appliesOver?: number;
	models?: Record<string, number | null | ModelContextPolicy>;
};

type ModelContextPolicy = {
	cap?: number | null;
	compactAt?: number | null;
};

type ResolvedContextPolicy = {
	cap?: number;
	compactAt?: number;
};

const originalWindows = new Map<string, number>();
let appliedPolicies: Array<{ key: string; original: number; cap: number; compactAt?: number }> = [];
let compactionRequested = false;
const PROFILE_CONFIG_PATH = fileURLToPath(new URL("./context-cap.json", import.meta.url));

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function positiveInteger(value: unknown, name: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || (value as number) <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value as number;
}

async function readConfig(cwd: string): Promise<ContextCapConfig> {
	const configPaths = [
		join(cwd, ".pi", "extensions", "context-cap.json"),
		join(getAgentDir(), "extensions", "context-cap.json"),
		PROFILE_CONFIG_PATH,
	];
	let content: string | undefined;
	for (const configPath of configPaths) {
		try {
			content = await readFile(configPath, "utf8");
			break;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
		}
	}
	if (content === undefined) throw new Error("context-cap.json was not found");
	const parsed = JSON.parse(content) as ContextCapConfig;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("context-cap.json must contain a JSON object");
	}

	const defaultCap = positiveInteger(parsed.defaultCap, "defaultCap");
	const defaultCompactAt = positiveInteger(parsed.defaultCompactAt, "defaultCompactAt");
	const appliesOver = positiveInteger(parsed.appliesOver, "appliesOver");
	if (defaultCap !== undefined && defaultCompactAt !== undefined && defaultCompactAt >= defaultCap) {
		throw new Error("defaultCompactAt must be lower than defaultCap");
	}
	if (parsed.models !== undefined && (!parsed.models || typeof parsed.models !== "object" || Array.isArray(parsed.models))) {
		throw new Error("models must be a JSON object");
	}
	const models: Record<string, number | null | ModelContextPolicy> = {};
	for (const [key, value] of Object.entries(parsed.models ?? {})) {
		if (value === null || typeof value === "number") {
			models[key] = value === null ? null : positiveInteger(value, `models.${key}`)!;
			continue;
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error(`models.${key} must be a number, null, or object`);
		}
		const cap = value.cap === null ? null : positiveInteger(value.cap, `models.${key}.cap`);
		const compactAt = value.compactAt === null
			? null
			: positiveInteger(value.compactAt, `models.${key}.compactAt`);
		if (typeof cap === "number" && typeof compactAt === "number" && compactAt >= cap) {
			throw new Error(`models.${key}.compactAt must be lower than its cap`);
		}
		models[key] = { cap, compactAt };
	}
	return { defaultCap, defaultCompactAt, appliesOver, models };
}

function resolvePolicy(model: Model<Api>, nativeWindow: number, config: ContextCapConfig): ResolvedContextPolicy {
	const key = modelKey(model);
	const exact = config.models && Object.hasOwn(config.models, key)
		? config.models[key]
		: config.models?.[model.id];
	if (exact === null) return {};
	if (exact !== undefined) {
		const policy = typeof exact === "number" ? { cap: exact } : exact;
		const cap = policy.cap === null ? nativeWindow : Math.min(policy.cap ?? nativeWindow, nativeWindow);
		const compactAt = policy.compactAt === null ? undefined : policy.compactAt ?? config.defaultCompactAt;
		return { cap, compactAt: compactAt !== undefined && compactAt < cap ? compactAt : undefined };
	}
	if (config.defaultCap === undefined || nativeWindow <= (config.appliesOver ?? config.defaultCap)) return {};
	const cap = Math.min(config.defaultCap, nativeWindow);
	return {
		cap,
		compactAt: config.defaultCompactAt !== undefined && config.defaultCompactAt < cap
			? config.defaultCompactAt
			: undefined,
	};
}

async function applyContextCaps(ctx: ExtensionContext): Promise<void> {
	const config = await readConfig(ctx.cwd);
	appliedPolicies = [];
	compactionRequested = false;

	for (const model of ctx.modelRegistry.getAll()) {
		const key = modelKey(model);
		const nativeWindow = originalWindows.get(key) ?? model.contextWindow;
		originalWindows.set(key, nativeWindow);
		model.contextWindow = nativeWindow;

		const policy = resolvePolicy(model, nativeWindow, config);
		if (policy.cap !== undefined) {
			model.contextWindow = policy.cap;
			if (policy.cap < nativeWindow || policy.compactAt !== undefined) {
				appliedPolicies.push({ key, original: nativeWindow, cap: policy.cap, compactAt: policy.compactAt });
			}
		}
	}
}

export default function modelContextCap(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		try {
			await applyContextCaps(ctx);
		} catch (error) {
			ctx.ui.notify(`Failed to apply context caps: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});
	pi.on("model_select", () => {
		compactionRequested = false;
	});
	pi.on("turn_end", (_event, ctx) => {
		if (!ctx.model) return;
		const policy = appliedPolicies.find((entry) => entry.key === modelKey(ctx.model));
		if (policy?.compactAt === undefined) return;
		const tokens = ctx.getContextUsage()?.tokens;
		if (tokens === null || tokens === undefined || tokens <= policy.compactAt) {
			compactionRequested = false;
			return;
		}
		if (compactionRequested) return;
		compactionRequested = true;
		ctx.compact({
			onComplete: () => { compactionRequested = false; },
			onError: () => { compactionRequested = false; },
		});
	});

	pi.registerCommand("context-cap", {
		description: "Show the current model's context soft cap",
		handler: async (_args, ctx) => {
			if (!ctx.model) {
				ctx.ui.notify("No model is currently selected.", "info");
				return;
			}
			const key = modelKey(ctx.model);
			const applied = appliedPolicies.find((entry) => entry.key === key);
			const detail = applied
				? `${applied.original.toLocaleString()} → ${applied.cap.toLocaleString()}`
					+ (applied.compactAt ? `; compact at ${applied.compactAt.toLocaleString()}` : "")
				: `${ctx.model.contextWindow.toLocaleString()} (native)`;
			ctx.ui.notify(`${key}: ${detail}\nPolicies applied to ${appliedPolicies.length.toLocaleString()} models`, "info");
		},
	});
}
