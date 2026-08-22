import { existsSync, readFileSync } from "node:fs";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { activityMonitor } from "./activity.ts";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";
import type { SearchOptions, SearchResponse } from "./search-types.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { fetchRemoteUrl, loadFetchContentDomainPolicy, loadSsrfConfig, validateRemoteUrl, type SsrfConfig } from "./ssrf-protection.ts";
import { getWebSearchConfigPath } from "./utils.ts";

const KAGI_SEARCH_URL = "https://kagi.com/api/v1/search";
const KAGI_EXTRACT_URL = "https://kagi.com/api/v1/extract";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 60_000;

type KagiScalar = boolean | number | string | null;
type KagiValue = KagiScalar | KagiObject | KagiValue[];
interface KagiObject {
	[key: string]: KagiValue | undefined;
}

interface WebSearchConfig extends KagiObject {
	kagiApiKey?: KagiValue;
}

interface KagiSearchOptions extends SearchOptions {
	includeContent?: boolean;
}

export interface KagiExtractOptions extends Pick<ExtractOptions, "timeoutMs" | "lookup"> {
	ssrf?: SsrfConfig;
}

const StringValueSchema = Type.String();
const NumberValueSchema = Type.Number();

function isKagiObject(value: KagiValue | undefined): value is KagiObject {
	return value !== null && value !== undefined && Object(value) === value && !Array.isArray(value);
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}
	const raw = readFileSync(CONFIG_PATH, "utf-8");
	let parsed: KagiValue;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
	if (!isKagiObject(parsed)) {
		throw new Error(`Invalid config in ${CONFIG_PATH}: expected a JSON object`);
	}
	cachedConfig = parsed;
	return cachedConfig;
}

async function getApiKey(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "Kagi",
		configuredValue: loadConfig().kagiApiKey,
		environmentValue: process.env.KAGI_API_KEY,
		signal,
	});
}

async function requireApiKey(signal?: AbortSignal): Promise<string> {
	const apiKey = await getApiKey(signal);
	if (!apiKey) {
		throw new Error(
			"Kagi API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "kagiApiKey": "your-key" }\n` +
			"  2. Set KAGI_API_KEY environment variable\n" +
			"Create a key at https://kagi.com/settings?p=api",
		);
	}
	return apiKey;
}

function normalizeCount(value: number | undefined): number {
	if (!Check(NumberValueSchema, value) || !Number.isFinite(value)) return 5;
	return Math.max(1, Math.min(Math.floor(value), 20));
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function invalidResponse(message: string): Error {
	return new Error(`Kagi API returned invalid response: ${message}`);
}

function firstString(...values: Array<KagiValue | undefined>): string | null {
	for (const value of values) {
		if (Check(StringValueSchema, value) && value.trim()) return value.trim();
	}
	return null;
}

function appendSearchItems(value: KagiValue | undefined, results: SearchResponse["results"], inlineContent: ExtractedContent[]): void {
	if (Array.isArray(value)) {
		for (const item of value) appendSearchItems(item, results, inlineContent);
		return;
	}
	if (!isKagiObject(value)) return;
	const item = value;
	const url = firstString(item.url, item.href, item.link);
	if (!url) return;
	const title = firstString(item.title, item.name) ?? url;
	const snippet = firstString(item.snippet, item.description, item.summary, item.content, item.markdown, item.text) ?? "";
	results.push({ title, url, snippet });
	const content = firstString(item.markdown, item.content, item.text);
	if (content) inlineContent.push({ url, title, content, error: null });
}

function parseErrors(value: KagiValue): string | null {
	if (!isKagiObject(value)) return null;
	const envelope = value;
	const rawErrors = envelope.errors ?? envelope.error;
	if (!Array.isArray(rawErrors)) return null;
	const messages = rawErrors.map((entry) => {
		if (!isKagiObject(entry)) return String(entry);
		return firstString(entry.message, entry.msg, entry.code) ?? JSON.stringify(entry);
	});
	return messages.length > 0 ? messages.join("; ") : null;
}

interface ParsedKagiSearchResponse {
	results: SearchResponse["results"];
	inlineContent: ExtractedContent[];
}

function parseSearchResponse(value: KagiValue): ParsedKagiSearchResponse {
	if (!isKagiObject(value)) throw invalidResponse("expected an object envelope");
	const message = parseErrors(value);
	if (message) throw invalidResponse(message);
	const envelope = value;
	const results: SearchResponse["results"] = [];
	const inlineContent: ExtractedContent[] = [];
	const data = envelope.data;
	const items = isKagiObject(data) ? data.search : data;
	appendSearchItems(items, results, inlineContent);
	return { results, inlineContent };
}

function parseExtractResponse(value: KagiValue, requestedUrl: string): ExtractedContent | null {
	if (!isKagiObject(value)) throw invalidResponse("expected extract object envelope");
	const message = parseErrors(value);
	if (message) throw invalidResponse(message);
	const envelope = value;
	const candidates = Array.isArray(envelope.data) ? envelope.data : [envelope.data ?? envelope];
	for (const candidate of candidates) {
		if (!isKagiObject(candidate)) continue;
		const item = candidate;
		const content = firstString(item.markdown, item.content, item.text);
		if (!content) continue;
		return {
			url: firstString(item.url, item.href, item.link) ?? requestedUrl,
			title: firstString(item.title, item.name) ?? requestedUrl,
			content,
			error: null,
		};
	}
	return null;
}

function buildAnswer(results: SearchResponse["results"]): string {
	return results.map((result) => result.snippet
		? `${result.snippet}\nSource: ${result.title} (${result.url})`
		: `Source: ${result.title} (${result.url})`).join("\n\n");
}

export function isKagiAvailable(): boolean {
	return hasCredentialSource({ provider: "Kagi", configuredValue: loadConfig().kagiApiKey, environmentValue: process.env.KAGI_API_KEY });
}

export async function searchWithKagi(query: string, options: KagiSearchOptions = {}): Promise<SearchResponse> {
	const apiKey = await requireApiKey(options.signal);
	const numResults = normalizeCount(options.numResults);
	const activityId = activityMonitor.logStart({ type: "api", query });
	let response: Response;
	try {
		response = await fetch(KAGI_SEARCH_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ query, limit: numResults }),
			signal: options.signal ? AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), options.signal]) : AbortSignal.timeout(SEARCH_TIMEOUT_MS),
		});
	} catch (err) {
		const message = errorMessage(err);
		const redactedMessage = redactCredential(message, apiKey);
		if (redactedMessage.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, redactedMessage);
		if (redactedMessage === message) throw err;
		const redactedError = new Error(redactedMessage);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}
	if (!response.ok) {
		activityMonitor.logComplete(activityId, response.status);
		const errorText = redactCredential(await response.text(), apiKey);
		throw new Error(`Kagi API error ${response.status}: ${errorText.slice(0, 300)}`);
	}
	let rawData: KagiValue;
	try {
		rawData = await response.json();
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		throw new Error(`Kagi API returned invalid JSON: ${errorMessage(err)}`);
	}
	const parsed = parseSearchResponse(rawData);
	activityMonitor.logComplete(activityId, response.status);
	const results = parsed.results.slice(0, numResults);
	const mapped: SearchResponse = { answer: buildAnswer(results), results };
	if (options.includeContent) {
		const urls = new Set(results.map(result => result.url));
		const inlineContent = parsed.inlineContent.filter(content => urls.has(content.url));
		if (inlineContent.length > 0) mapped.inlineContent = inlineContent;
	}
	return mapped;
}

export function isKagiExtractAvailable(): boolean {
	return isKagiAvailable();
}

export async function extractWithKagi(url: string, signal?: AbortSignal, options: KagiExtractOptions = {}): Promise<ExtractedContent | null> {
	const ssrf = options.ssrf ?? loadSsrfConfig();
	const domainPolicy = loadFetchContentDomainPolicy();
	const validationOptions: NonNullable<Parameters<typeof validateRemoteUrl>[1]> = {
		allowRanges: ssrf.allowRanges,
		trustEnvProxy: ssrf.trustEnvProxy,
		domainPolicy,
	};
	if (options.lookup) validationOptions.lookup = options.lookup;
	await validateRemoteUrl(url, validationOptions);
	const apiKey = await requireApiKey(signal);
	const activityId = activityMonitor.logStart({ type: "api", query: `kagi extract: ${url}` });
	let response: Response;
	try {
		const fetchOptions: NonNullable<Parameters<typeof fetchRemoteUrl>[2]> = {
			allowRanges: ssrf.allowRanges,
			trustEnvProxy: ssrf.trustEnvProxy,
			onRedirect: ({ from, to, init }) => to.origin === from.origin ? init : { ...init, headers: { "Content-Type": "application/json", Accept: "application/json" } },
		};
		if (options.lookup) fetchOptions.lookup = options.lookup;
		response = await fetchRemoteUrl(KAGI_EXTRACT_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ pages: [{ url }] }),
			signal: signal ? AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? SEARCH_TIMEOUT_MS), signal]) : AbortSignal.timeout(options.timeoutMs ?? SEARCH_TIMEOUT_MS),
		}, fetchOptions);
	} catch (err) {
		const message = errorMessage(err);
		const redactedMessage = redactCredential(message, apiKey);
		if (redactedMessage.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, redactedMessage);
		if (redactedMessage === message) throw err;
		const redactedError = new Error(redactedMessage);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}
	if (!response.ok) {
		activityMonitor.logComplete(activityId, response.status);
		const errorText = redactCredential(await response.text(), apiKey);
		throw new Error(`Kagi Extract API error ${response.status}: ${errorText.slice(0, 300)}`);
	}
	let rawData: KagiValue;
	try {
		rawData = await response.json();
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		throw new Error(`Kagi Extract API returned invalid JSON: ${errorMessage(err)}`);
	}
	const parsed = parseExtractResponse(rawData, url);
	activityMonitor.logComplete(activityId, response.status);
	return parsed;
}
