import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ContextCapConfig = {
	defaultCap?: number;
	appliesOver?: number;
	models?: Record<string, number | null>;
};

const originalWindows = new Map<string, number>();
let appliedCaps: Array<{ key: string; original: number; cap: number }> = [];

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

function readConfig(cwd: string): ContextCapConfig {
	const configPath = join(cwd, ".pi", "extensions", "context-cap.json");
	const parsed = JSON.parse(readFileSync(configPath, "utf8")) as ContextCapConfig;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("context-cap.json must contain a JSON object");
	}

	const defaultCap = positiveInteger(parsed.defaultCap, "defaultCap");
	const appliesOver = positiveInteger(parsed.appliesOver, "appliesOver");
	if (parsed.models !== undefined && (!parsed.models || typeof parsed.models !== "object" || Array.isArray(parsed.models))) {
		throw new Error("models must be a JSON object");
	}
	const models: Record<string, number | null> = {};
	for (const [key, value] of Object.entries(parsed.models ?? {})) {
		models[key] = value === null ? null : positiveInteger(value, `models.${key}`)!;
	}
	return { defaultCap, appliesOver, models };
}

function resolveCap(model: Model<Api>, nativeWindow: number, config: ContextCapConfig): number | undefined {
	const key = modelKey(model);
	const exact = config.models && Object.hasOwn(config.models, key)
		? config.models[key]
		: config.models?.[model.id];
	if (exact === null) return undefined;
	if (exact !== undefined) return Math.min(exact, nativeWindow);
	if (config.defaultCap === undefined) return undefined;
	if (nativeWindow <= (config.appliesOver ?? config.defaultCap)) return undefined;
	return Math.min(config.defaultCap, nativeWindow);
}

function applyContextCaps(ctx: ExtensionContext): void {
	const config = readConfig(ctx.cwd);
	appliedCaps = [];

	for (const model of ctx.modelRegistry.getAll()) {
		const key = modelKey(model);
		const nativeWindow = originalWindows.get(key) ?? model.contextWindow;
		originalWindows.set(key, nativeWindow);
		model.contextWindow = nativeWindow;

		const cap = resolveCap(model, nativeWindow, config);
		if (cap !== undefined && cap < nativeWindow) {
			model.contextWindow = cap;
			appliedCaps.push({ key, original: nativeWindow, cap });
		}
	}
}

export default function modelContextCap(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		try {
			applyContextCaps(ctx);
		} catch (error) {
			ctx.ui.notify(`Context cap 설정을 적용하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	pi.registerCommand("context-cap", {
		description: "현재 모델의 context soft cap 표시",
		handler: async (_args, ctx) => {
			if (!ctx.model) {
				ctx.ui.notify("현재 선택된 모델이 없습니다.", "info");
				return;
			}
			const key = modelKey(ctx.model);
			const applied = appliedCaps.find((entry) => entry.key === key);
			const detail = applied
				? `${applied.original.toLocaleString()} → ${applied.cap.toLocaleString()}`
				: `${ctx.model.contextWindow.toLocaleString()} (native)`;
			ctx.ui.notify(`${key}: ${detail}\n전체 ${appliedCaps.length.toLocaleString()}개 모델에 cap 적용`, "info");
		},
	});
}
