import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const REQUEST_TIMEOUT_MS = 10_000;
const SYNTHETIC_QUOTAS_REQUEST_EVENT = "synthetic:quotas:request";
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const USAGE_BAR_WIDTH = 50;

type UsageWindow = {
	label: string;
	percent: number;
	qualifier: "used" | "remaining";
	eventAt?: Date;
	eventLabel?: string;
	detail?: string;
	precision?: number;
};

type ProviderUsage = {
	name: string;
	status?: string;
	windows: UsageWindow[];
};

type QuotaWindow = {
	utilization?: number;
	resets_at?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function dateValue(value: unknown, unixSeconds = false): Date | undefined {
	if (unixSeconds && typeof value === "number") {
		const date = new Date(value * 1000);
		return Number.isNaN(date.getTime()) ? undefined : date;
	}
	if (typeof value !== "string") return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

async function fetchJson(url: string, token: string, headers: Record<string, string>): Promise<unknown> {
	const response = await fetch(url, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${token}`,
			...headers,
		},
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response.json();
}

function parseJwtPayload(token: string): Record<string, unknown> | undefined {
	try {
		const encoded = token.split(".")[1];
		if (!encoded) return undefined;
		const payload = Buffer.from(encoded, "base64url").toString("utf8");
		const parsed = JSON.parse(payload);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function codexAccountId(token: string): string | undefined {
	const payload = parseJwtPayload(token);
	const auth = payload?.[OPENAI_AUTH_CLAIM];
	return isRecord(auth) ? stringValue(auth.chatgpt_account_id) : undefined;
}

function quotaWindow(value: unknown): QuotaWindow | undefined {
	if (!isRecord(value)) return undefined;
	return {
		utilization: numberValue(value.utilization),
		resets_at: stringValue(value.resets_at),
	};
}

function structuredClaudeWindow(value: unknown): UsageWindow | undefined {
	if (!isRecord(value)) return undefined;
	const percent = numberValue(value.percent);
	const kind = stringValue(value.kind);
	if (percent === undefined || !kind) return undefined;

	let label: string;
	if (kind === "session") {
		label = "5h";
	} else if (kind === "weekly_all") {
		label = "7d";
	} else if (kind === "weekly_scoped") {
		const scope = isRecord(value.scope) ? value.scope : undefined;
		const model = scope && isRecord(scope.model) ? scope.model : undefined;
		label = `${stringValue(model?.display_name) ?? "Scoped"} 7d`;
	} else {
		return undefined;
	}

	return {
		label,
		percent: clampPercent(percent),
		qualifier: "used",
		eventAt: dateValue(value.resets_at),
		eventLabel: "resets",
	};
}

export function normalizeClaudeUsage(payload: unknown): ProviderUsage {
	if (!isRecord(payload)) throw new Error("Unexpected response");
	const structuredWindows = Array.isArray(payload.limits)
		? payload.limits.flatMap((value) => {
			const window = structuredClaudeWindow(value);
			return window ? [window] : [];
		})
		: [];
	const definitions: Array<[string, string]> = [
		["five_hour", "5h"],
		["seven_day", "7d"],
		["seven_day_sonnet", "Sonnet 7d"],
		["seven_day_opus", "Opus 7d"],
		["seven_day_fable", "Fable 7d"],
	];
	const legacyWindows = definitions.flatMap(([key, label]) => {
		const value = quotaWindow(payload[key]);
		return value?.utilization === undefined ? [] : [{
			label,
			percent: clampPercent(value.utilization),
			qualifier: "used" as const,
			eventAt: dateValue(value.resets_at),
			eventLabel: "resets",
		}];
	});
	const extraUsage = isRecord(payload.extra_usage) ? payload.extra_usage : undefined;
	const extraPercent = extraUsage ? numberValue(extraUsage.utilization) : undefined;
	const status = extraUsage?.is_enabled === true
		? extraPercent === undefined ? "extra usage enabled" : `extra usage ${extraPercent.toFixed(0)}% used`
		: undefined;
	return { name: "Claude Code", status, windows: structuredWindows.length > 0 ? structuredWindows : legacyWindows };
}

function codexWindow(value: unknown, label: string): UsageWindow | undefined {
	if (!isRecord(value)) return undefined;
	const percent = numberValue(value.used_percent);
	if (percent === undefined) return undefined;
	const seconds = numberValue(value.limit_window_seconds);
	const resolvedLabel = seconds === undefined
		? label
		: seconds % 86_400 === 0
			? `${seconds / 86_400}d`
			: seconds % 3_600 === 0 ? `${seconds / 3_600}h` : label;
	return {
		label: resolvedLabel,
		percent: clampPercent(percent),
		qualifier: "used",
		eventAt: dateValue(value.reset_at, true),
		eventLabel: "resets",
	};
}

export function normalizeCodexUsage(payload: unknown): ProviderUsage {
	if (!isRecord(payload)) throw new Error("Unexpected response");
	const rateLimit = isRecord(payload.rate_limit) ? payload.rate_limit : {};
	const windows = [
		codexWindow(rateLimit.primary_window, "5h"),
		codexWindow(rateLimit.secondary_window, "7d"),
	].filter((window): window is UsageWindow => window !== undefined);
	const plan = stringValue(payload.plan_type);
	const credits = isRecord(payload.credits) ? payload.credits : undefined;
	const balance = credits ? stringValue(credits.balance) ?? numberValue(credits.balance)?.toString() : undefined;
	const statusParts = [plan, balance === undefined ? undefined : `${balance} credits`].filter(Boolean);
	return { name: "OpenAI Codex", status: statusParts.join(" · ") || undefined, windows };
}

export function normalizeSyntheticUsage(payload: unknown): ProviderUsage {
	if (!isRecord(payload)) throw new Error("Unexpected response");
	const windows: UsageWindow[] = [];
	const subscription = isRecord(payload.subscription) ? payload.subscription : undefined;
	const rolling = isRecord(payload.rollingFiveHourLimit) ? payload.rollingFiveHourLimit : undefined;
	const rollingMaximum = rolling ? numberValue(rolling.max) : undefined;
	const rollingRemaining = rolling ? numberValue(rolling.remaining) : undefined;
	const subscriptionLimit = subscription ? numberValue(subscription.limit) : undefined;
	const subscriptionRequests = subscription ? numberValue(subscription.requests) : undefined;
	const maximum = rollingMaximum ?? subscriptionLimit;
	const remaining = rollingRemaining ?? (
		maximum !== undefined && subscriptionRequests !== undefined
			? maximum - subscriptionRequests
			: undefined
	);
	if (maximum !== undefined && maximum > 0 && remaining !== undefined) {
		const boundedRemaining = Math.max(0, Math.min(maximum, remaining));
		const requestsUsed = subscriptionRequests ?? maximum - boundedRemaining;
		const requestDetail = requestsUsed === 0
			? "No requests used"
			: `${boundedRemaining}/${maximum} requests remaining`;
		const detail = `${requestDetail}${rolling?.limited === true ? " · limited" : ""}`;
		windows.push({
			label: "Five-hour requests",
			percent: clampPercent((maximum - boundedRemaining) / maximum * 100),
			qualifier: "used",
			eventAt: dateValue(subscription?.renewsAt),
			eventLabel: "resets",
			detail,
			precision: 0,
		});
	}

	const weekly = isRecord(payload.weeklyTokenLimit) ? payload.weeklyTokenLimit : undefined;
	const remainingPercent = weekly ? numberValue(weekly.percentRemaining) : undefined;
	if (remainingPercent !== undefined) {
		const nextRegenCredits = stringValue(weekly?.nextRegenCredits);
		const maxCredits = stringValue(weekly?.maxCredits);
		const regenPercent = nextRegenCredits && maxCredits
			? currencyValue(nextRegenCredits) / currencyValue(maxCredits) * 100
			: undefined;
		const regenDescription = nextRegenCredits
			? `regenerates${regenPercent !== undefined && Number.isFinite(regenPercent) ? ` ${formatNumber(regenPercent, 2)}%` : ""} (${nextRegenCredits})`
			: "regenerates";
		windows.push({
			label: "Weekly credits",
			percent: clampPercent(100 - remainingPercent),
			qualifier: "used",
			eventAt: dateValue(weekly?.nextRegenAt),
			eventLabel: regenDescription,
			detail: stringValue(weekly?.remainingCredits) ? `${weekly?.remainingCredits} remaining` : undefined,
			precision: 2,
		});
	}

	return { name: "Synthetic", windows };
}

async function providerToken(ctx: ExtensionContext, provider: string): Promise<string | undefined> {
	if (!ctx.modelRegistry.getProviderAuthStatus(provider).configured) return undefined;
	return ctx.modelRegistry.getApiKeyForProvider(provider);
}

async function claudeUsage(ctx: ExtensionContext): Promise<ProviderUsage> {
	const token = await providerToken(ctx, "anthropic");
	if (!token) return { name: "Claude Code", status: "not connected", windows: [] };
	const payload = await fetchJson("https://api.anthropic.com/api/oauth/usage", token, {
		"anthropic-beta": "oauth-2025-04-20",
	});
	return normalizeClaudeUsage(payload);
}

async function codexUsage(ctx: ExtensionContext): Promise<ProviderUsage> {
	const token = await providerToken(ctx, "openai-codex");
	if (!token) return { name: "OpenAI Codex", status: "not connected", windows: [] };
	const accountId = codexAccountId(token);
	if (!accountId) throw new Error("OAuth account ID is unavailable");
	const payload = await fetchJson("https://chatgpt.com/backend-api/wham/usage", token, {
		"chatgpt-account-id": accountId,
		originator: "pi",
	});
	return normalizeCodexUsage(payload);
}

function syntheticUsage(pi: ExtensionAPI, ctx: ExtensionContext): Promise<ProviderUsage> {
	if (!ctx.modelRegistry.getProviderAuthStatus("synthetic").configured) {
		return Promise.resolve({ name: "Synthetic", status: "not connected", windows: [] });
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("request timed out")), REQUEST_TIMEOUT_MS);
		pi.events.emit(SYNTHETIC_QUOTAS_REQUEST_EVENT, {
			respond(snapshot: unknown) {
				clearTimeout(timer);
				if (!isRecord(snapshot) || !isRecord(snapshot.quotas)) {
					reject(new Error("quota data is unavailable"));
					return;
				}
				try {
					resolve(normalizeSyntheticUsage(snapshot.quotas));
				} catch (error) {
					reject(error);
				}
			},
		});
	});
}

function currencyValue(value: string): number {
	const parsed = Number(value.replace(/[^0-9.-]/g, ""));
	return Number.isFinite(parsed) ? parsed : 0;
}

function formatNumber(value: number, precision: number): string {
	const fixed = value.toFixed(precision);
	return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

function relativeTime(date: Date | undefined): string | undefined {
	if (!date) return undefined;
	const milliseconds = date.getTime() - Date.now();
	if (milliseconds <= 0) return "soon";
	const totalMinutes = Math.ceil(milliseconds / 60_000);
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor(totalMinutes % 1440 / 60);
	const minutes = totalMinutes % 60;
	const value = [days ? `${days}d` : "", hours ? `${hours}h` : "", !days && minutes ? `${minutes}m` : ""]
		.filter(Boolean)
		.join(" ");
	return `in ${value || "<1m"}`;
}

function progressBar(percent: number, width = USAGE_BAR_WIDTH): string {
	const filled = Math.round(clampPercent(percent) / 100 * width);
	return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

export function formatProviderUsage(result: ProviderUsage): string {
	const heading = result.status ? `${result.name} — ${result.status}` : result.name;
	if (result.windows.length === 0) return result.status ? heading : `${heading} — no quota windows`;
	const windows = result.windows.flatMap((window) => {
		const percent = formatNumber(window.percent, window.precision ?? 0);
		const eventTime = relativeTime(window.eventAt);
		const event = window.eventLabel && eventTime ? `${window.eventLabel} ${eventTime}` : undefined;
		const detail = [event, window.detail].filter(Boolean).join(" · ");
		return [
			`  ${window.label}`,
			`  ${progressBar(window.percent)} ${percent}% ${window.qualifier}`,
			...(detail ? [`  ${detail}`] : []),
		];
	});
	return [heading, ...windows].join("\n");
}

export default function providerUsage(pi: ExtensionAPI): void {
	pi.registerCommand("usage", {
		description: "Show connected Claude Code, OpenAI Codex, and Synthetic usage",
		handler: async (_args, ctx) => {
			const requests = [claudeUsage(ctx), codexUsage(ctx), syntheticUsage(pi, ctx)];
			const settled = await Promise.allSettled(requests);
			const names = ["Claude Code", "OpenAI Codex", "Synthetic"];
			const sections = settled.map((result, index) => result.status === "fulfilled"
				? formatProviderUsage(result.value)
				: `${names[index]} — unavailable (${result.reason instanceof Error ? result.reason.message : "unknown error"})`);
			ctx.ui.notify(sections.join("\n\n"), "info");
		},
	});
}
