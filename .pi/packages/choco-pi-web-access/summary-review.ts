import { clampThinkingLevel, type ModelThinkingLevel, type ThinkingLevel } from "@earendil-works/pi-ai";
import { complete, completeSimple, type Api, type Message, type Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findModelWithProviderRouting, loadEnabledModelPatterns, modelMatchesEnabledPatterns, splitThinkingSuffix, type SummaryThinkingLevel } from "./summary-model-scope.ts";
import type { QueryResultData } from "./storage.ts";

type ProviderHeaders = Record<string, string | null>;
type CompleteFunction = typeof complete;
type CompleteOptions = NonNullable<Parameters<CompleteFunction>[2]>;
type CompleteSimpleOptions = NonNullable<Parameters<typeof completeSimple>[2]>;

interface SummaryDraft {
	summary: string;
	meta: SummaryMeta;
}

interface SummaryModelSpec {
	provider: string;
	id: string;
	thinkingLevel?: SummaryThinkingLevel;
}

interface SummaryModelCandidate {
	model: Model<Api>;
	apiKey?: string;
	headers?: ProviderHeaders;
	thinkingLevel?: SummaryThinkingLevel;
}

interface SummaryModelCandidates {
	candidates: SummaryModelCandidate[];
	errors: string[];
}

const PREFERRED_SUMMARY_MODELS = [
	{ provider: "anthropic", id: "claude-haiku-4-5" },
	{ provider: "openai-codex", id: "gpt-5.6-luna" },
	{ provider: "openai-codex", id: "gpt-5.6-terra" },
	{ provider: "google", id: "gemini-3.6-flash" },
	{ provider: "openai", id: "gpt-5-mini" },
	{ provider: "deepseek", id: "deepseek-v4-flash" },
] as const;

export const SUMMARY_GENERATION_DEADLINE_MS = 30_000;

export interface SummaryMeta {
	model: string | null;
	durationMs: number;
	tokenEstimate: number;
	fallbackUsed: boolean;
	fallbackReason?: string;
	phase?: "summary-model" | "deterministic-fallback";
	edited?: boolean;
}

export type SummaryGenerationContext = Pick<ExtensionContext, "model" | "modelRegistry" | "cwd" | "isProjectTrusted">;

function estimateTokens(text: string): number {
	const trimmed = text.trim();
	if (trimmed.length === 0) return 0;
	return Math.max(1, Math.ceil(trimmed.length / 4));
}

function summarizeQueryResult(result: QueryResultData): string {
	if (result.error) {
		return `Query: ${result.query}\nStatus: Error\nError: ${result.error}`;
	}

	const lines = [
		`Query: ${result.query}`,
		`Provider: ${result.provider ?? "unknown"}`,
		`Answer: ${result.answer || "(no answer text returned)"}`,
	];

	if (result.results.length === 0) {
		lines.push("Sources: none");
		return lines.join("\n");
	}

	lines.push("Sources:");
	for (let i = 0; i < result.results.length; i++) {
		const source = result.results[i];
		lines.push(`${i + 1}. ${source.title} — ${source.url}`);
	}

	return lines.join("\n");
}

export function buildSummaryPrompt(results: QueryResultData[], feedback?: string): string {
	const sections = [
		"You are writing the final web search summary for a coding assistant.",
		"Write a concise, factual summary using only the provided search results.",
		"Requirements:",
		"- Keep it readable and skimmable.",
		"- Include key findings and caveats.",
		"- Do not invent sources or claims.",
		"- If evidence is weak or conflicting, say so explicitly.",
		"- End with a short \"Sources\" section listing the most relevant URLs.",
	];

	if (feedback) {
		sections.push("- Incorporate the user feedback provided below into the summary.");
	}

	sections.push("");
	sections.push("<search_results>");

	for (let i = 0; i < results.length; i++) {
		sections.push(`\n[Result ${i + 1}]`);
		sections.push(summarizeQueryResult(results[i]));
	}

	sections.push("\n</search_results>");

	if (feedback) {
		sections.push("");
		sections.push("<user_feedback>");
		sections.push(feedback);
		sections.push("</user_feedback>");
	}

	return sections.join("\n");
}

function buildDeterministicAnswerPreview(answer: string): string {
	let text = answer.replace(/\s+/g, " ").trim();
	if (text.length === 0) return "";

	const sourceMarker = text.search(/\bSources?\s*:/i);
	if (sourceMarker >= 0) text = text.slice(0, sourceMarker).trim();
	if (text.length === 0) return "";

	return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function buildDeterministicSummaryLines(results: QueryResultData[]): string[] {
	if (results.length === 0) {
		return [
			"No completed search results were available when the curator session finished.",
			"",
			"Sources",
			"- None",
		];
	}

	const lines: string[] = [
		"Summary based on the currently selected search results.",
		"",
	];

	const sourceUrls: string[] = [];
	let successful = 0;
	let failed = 0;

	for (const result of results) {
		if (result.error) {
			failed += 1;
			lines.push(`- ${result.query}: failed (${result.error})`);
			continue;
		}

		successful += 1;
		const preview = buildDeterministicAnswerPreview(result.answer);
		if (preview.length > 0) {
			lines.push(`- ${result.query}: ${preview}`);
		} else {
			lines.push(`- ${result.query}: returned ${result.results.length} source${result.results.length === 1 ? "" : "s"} without answer text.`);
		}

		for (const source of result.results) {
			if (!sourceUrls.includes(source.url)) {
				sourceUrls.push(source.url);
			}
		}
	}

	lines.push("");
	lines.push(`Completed queries: ${results.length}`);
	lines.push(`Successful: ${successful}`);
	lines.push(`Failed: ${failed}`);
	lines.push("");
	lines.push("Sources");

	if (sourceUrls.length === 0) {
		lines.push("- None");
	} else {
		for (const url of sourceUrls.slice(0, 12)) {
			lines.push(`- ${url}`);
		}
		if (sourceUrls.length > 12) {
			lines.push(`- ... and ${sourceUrls.length - 12} more`);
		}
	}

	return lines;
}

export function buildDeterministicSummary(results: QueryResultData[]): SummaryDraft {
	const summary = buildDeterministicSummaryLines(results).join("\n").trim();
	const nonEmptySummary = summary.length > 0
		? summary
		: "No completed search results were available when the curator session finished.\n\nSources\n- None";

	return {
		summary: nonEmptySummary,
		meta: {
			model: null,
			durationMs: 0,
			tokenEstimate: estimateTokens(nonEmptySummary),
			fallbackUsed: true,
			fallbackReason: "deterministic-submit-fallback",
			phase: "deterministic-fallback",
			edited: false,
		},
	};
}

function parseModelSelector(value: string): SummaryModelSpec {
	const selector = splitThinkingSuffix(value);
	const slashIndex = selector.value.indexOf("/");
	if (slashIndex <= 0 || slashIndex >= selector.value.length - 1) {
		throw new Error(`Invalid summary model: ${value}. Use provider/model-id.`);
	}
	return {
		provider: selector.value.slice(0, slashIndex),
		id: selector.value.slice(slashIndex + 1),
		thinkingLevel: selector.thinkingLevel,
	};
}

function resolveThinkingLevel(model: Model<Api>, requested?: SummaryThinkingLevel): ModelThinkingLevel | undefined {
	if (!requested) return undefined;
	return clampThinkingLevel(model, requested);
}

async function resolveSummaryModelCandidates(
	ctx: SummaryGenerationContext,
	modelOverride?: string,
): Promise<SummaryModelCandidates> {
	const enabledModelPatterns = loadEnabledModelPatterns(ctx);
	const specs: SummaryModelSpec[] = [];
	const normalizedOverride = modelOverride?.trim() ?? "";
	if (normalizedOverride.length > 0) specs.push(parseModelSelector(normalizedOverride));
	specs.push(...PREFERRED_SUMMARY_MODELS);

	const candidates: SummaryModelCandidate[] = [];
	const errors: string[] = [];
	const seen = new Set<string>();
	for (const spec of specs) {
		const value = `${spec.provider}/${spec.id}`;
		if (seen.has(value)) continue;
		seen.add(value);

		const model = findModelWithProviderRouting(ctx.modelRegistry, spec.provider, spec.id);
		if (!model) {
			errors.push(`Summary model not found: ${value}`);
			continue;
		}
		if (!modelMatchesEnabledPatterns(model, enabledModelPatterns)) {
			errors.push(`Summary model is not enabled: ${value}`);
			continue;
		}
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			errors.push(`No API key available for summary model ${value}`);
			continue;
		}
		candidates.push({ model, apiKey: auth.apiKey, headers: auth.headers, thinkingLevel: spec.thinkingLevel });
	}
	return { candidates, errors };
}

function buildFallbackSummary(
	results: QueryResultData[],
	fallbackReason: string,
	durationMs = 0,
): SummaryDraft {
	const deterministic = buildDeterministicSummary(results);
	return {
		summary: deterministic.summary,
		meta: {
			...deterministic.meta,
			durationMs,
			fallbackReason,
		},
	};
}

function isObject<Value>(value: Value): value is Value & object {
	return Object.prototype.toString.call(value) === "[object Object]";
}

function isString<Value>(value: Value): value is Value & string {
	return Object.prototype.toString.call(value) === "[object String]";
}

function isAbortError<Failure>(err: Failure): boolean {
	if (!isObject(err)) return false;
	const name = "name" in err && isString(err.name) ? err.name : "";
	const message = "message" in err && isString(err.message) ? err.message : "";
	return name === "AbortError" || message.toLowerCase().includes("abort");
}

function getTextFromContentPart<Part>(part: Part): string {
	if (!isObject(part)) return "";
	if ("text" in part && isString(part.text)) return part.text;
	if ("refusal" in part && isString(part.refusal)) return part.refusal;
	return "";
}

function getContentPartType<Part>(part: Part): string {
	return isObject(part) && "type" in part && isString(part.type) ? part.type : "unknown";
}

export async function generateSummaryDraft(
	results: QueryResultData[],
	ctx: SummaryGenerationContext,
	signal?: AbortSignal,
	modelOverride?: string,
	feedback?: string,
	completeFn?: CompleteFunction,
	deadlineMs = SUMMARY_GENERATION_DEADLINE_MS,
): Promise<SummaryDraft> {
	if (!ctx || !ctx.modelRegistry) {
		throw new Error("Summary generation context unavailable");
	}

	const suppliedCompleteFn = completeFn;
	const registryComplete = ctx.modelRegistry.complete;
	const usesRegistryComplete = suppliedCompleteFn === undefined && registryComplete !== undefined;

	const generationStartedAt = Date.now();
	const deadlineController = new AbortController();
	const deadlineMarker = Symbol("summary-generation-deadline");
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	let resolveDeadline!: () => void;
	const deadlinePromise = new Promise<typeof deadlineMarker>(resolve => {
		resolveDeadline = () => resolve(deadlineMarker);
		deadlineTimer = setTimeout(() => {
			deadlineController.abort();
			resolveDeadline();
		}, deadlineMs);
	});

	let callerAbortListener: (() => void) | undefined;
	const callerAbortPromise = signal
		? new Promise<never>((_, reject) => {
			callerAbortListener = () => reject(new Error("Aborted"));
			if (signal.aborted) callerAbortListener();
			else signal.addEventListener("abort", callerAbortListener, { once: true });
		})
		: undefined;
	const completionSignal = signal
		? AbortSignal.any([signal, deadlineController.signal])
		: deadlineController.signal;

	async function raceSummaryOperation<T>(operation: Promise<T>): Promise<T> {
		// A provider may ignore AbortSignal and never settle; observe it before racing so
		// its eventual rejection cannot become an unhandled promise rejection.
		void operation.then(() => undefined, () => undefined);
		const operationResult = operation.then(value => ({ kind: "result" as const, value }));
		const deadlineResult = deadlinePromise.then(() => ({ kind: "deadline" as const }));
		const contenders = [operationResult, deadlineResult];
		if (callerAbortPromise) contenders.push(callerAbortPromise);
		const result = await Promise.race(contenders);
		if (result.kind === "deadline") {
			if (signal?.aborted) throw new Error("Aborted");
			throw deadlineMarker;
		}
		return result.value;
	}

	try {
		if (signal?.aborted) throw new Error("Aborted");
		const prompt = buildSummaryPrompt(results, feedback);
		let resolved: Awaited<ReturnType<typeof resolveSummaryModelCandidates>>;
		try {
			resolved = await raceSummaryOperation(resolveSummaryModelCandidates(ctx, modelOverride));
		} catch (err) {
			if (signal?.aborted) throw new Error("Aborted");
			if (err === deadlineMarker || deadlineController.signal.aborted) {
				return buildFallbackSummary(results, "summary-generation-timeout", Date.now() - generationStartedAt);
			}
			const message = err instanceof Error ? err.message : String(err);
			return buildFallbackSummary(results, `summary-model-settings-error: ${message}`, Date.now() - generationStartedAt);
		}

		let lastError = resolved.errors.at(-1);
		for (const { model, apiKey, headers, thinkingLevel } of resolved.candidates) {
			const startedAt = Date.now();
			try {
				const userMessage: Message = {
					role: "user",
					content: [{ type: "text", text: prompt }],
					timestamp: Date.now(),
				};
				const requestedThinkingLevel = resolveThinkingLevel(model, thinkingLevel);
				const enabledThinkingLevel: ThinkingLevel | undefined = requestedThinkingLevel && requestedThinkingLevel !== "off"
					? requestedThinkingLevel
					: undefined;
				const completionOptions: CompleteOptions = { signal: completionSignal };
				if (!usesRegistryComplete) {
					completionOptions.apiKey = apiKey;
					completionOptions.headers = headers;
				}
				if (requestedThinkingLevel) completionOptions.reasoning = requestedThinkingLevel;
				if (enabledThinkingLevel) completionOptions.reasoningEffort = enabledThinkingLevel;

				const simpleOptions: CompleteSimpleOptions = { apiKey, headers, signal: completionSignal };
				if (enabledThinkingLevel) simpleOptions.reasoning = enabledThinkingLevel;
				const completion = thinkingLevel !== undefined && suppliedCompleteFn === undefined && registryComplete === undefined
					? completeSimple(model, { messages: [userMessage] }, simpleOptions)
					: suppliedCompleteFn !== undefined
						? suppliedCompleteFn(model, { messages: [userMessage] }, completionOptions)
						: registryComplete !== undefined
							? registryComplete.call(ctx.modelRegistry, model, { messages: [userMessage] }, completionOptions)
							: complete(model, { messages: [userMessage] }, completionOptions);

				const response = await raceSummaryOperation(Promise.resolve(completion));
				if (response.stopReason === "aborted") {
					throw new Error("Aborted");
				}

				const contentParts = Array.isArray(response.content) ? response.content : [];
				const summary = contentParts
					.map(getTextFromContentPart)
					.filter(text => text.trim().length > 0)
					.join("\n")
					.trim();

				if (summary.length === 0) {
					const partTypes = contentParts.map(getContentPartType);
					const typesLabel = partTypes.length > 0 ? partTypes.join(", ") : "none";
					throw new Error(`Summary model returned empty response (content parts: ${typesLabel})`);
				}

				return {
					summary,
					meta: {
						model: `${model.provider}/${model.id}`,
						durationMs: Math.max(0, Date.now() - startedAt),
						tokenEstimate: estimateTokens(summary),
						fallbackUsed: false,
						phase: "summary-model",
						edited: false,
					},
				};
			} catch (err) {
				if (signal?.aborted) throw new Error("Aborted");
				if (err === deadlineMarker || deadlineController.signal.aborted) {
					return buildFallbackSummary(results, "summary-generation-timeout", Date.now() - generationStartedAt);
				}
				if (isAbortError(err)) throw err;
				lastError = err instanceof Error ? err.message : String(err);
			}
		}

		return buildFallbackSummary(
			results,
			lastError ? `summary-model-unavailable: ${lastError}` : "summary-model-unavailable",
			Date.now() - generationStartedAt,
		);
	} finally {
		if (deadlineTimer) clearTimeout(deadlineTimer);
		if (signal && callerAbortListener) signal.removeEventListener("abort", callerAbortListener);
	}
}
