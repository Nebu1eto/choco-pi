import { existsSync, readFileSync } from "node:fs";
import { Readability } from "@mozilla/readability";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import pLimit from "p-limit";
import { activityMonitor } from "./activity.ts";
import { extractRSCContent } from "./rsc-extract.ts";
import { extractPDFToMarkdown, isPDF, loadPDFConfig } from "./pdf-extract.ts";
import { extractGitHub } from "./github-extract.ts";
import { CredentialResolutionError } from "./credential-source.ts";
import { extractWithKagi, isKagiExtractAvailable } from "./kagi.ts";
import { appendDeclaredWebLinks, discoverDeclaredWebLinks, type DeclaredWebLink } from "./declared-web-links.ts";
import { fetchRemoteUrl, loadFetchContentDomainPolicy, loadSsrfConfig, validateRemoteUrl, type DomainPolicy, type Lookup, type SsrfConfig } from "./ssrf-protection.ts";
import { getWebSearchConfigPath } from "./utils.ts";
import { isImageEnabled } from "./feature-config.ts";
import { assertAuthFetchUrl, authFetchRedirectGuard, type AuthFetchProfile } from "./auth-fetch.ts";
import { getBrowserCookiesForHosts, getLastBrowserCookieDiagnostic } from "./chrome-cookies.ts";
import { sanitizeInlineDataUris } from "./data-uri-sanitize.ts";

const DEFAULT_TIMEOUT_MS = 30000;
const CONCURRENT_LIMIT = 3;

const NON_RECOVERABLE_ERRORS = ["Unsupported content type", "Response too large", "PDF extraction is disabled", "Image fetching is disabled"];
const MIN_USEFUL_CONTENT = 500;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const WEB_SEARCH_CONFIG_PATH = getWebSearchConfigPath();
const FETCH_PROVIDERS = ["http", "kagi"] as const;
type FetchProvider = typeof FETCH_PROVIDERS[number];
type FetchRouting = { providers: FetchProvider[]; allowRemoteHostedProviders: boolean };
type ConfigValue = null | boolean | number | string | ConfigValue[] | ConfigObject;
interface ConfigObject { [key: string]: ConfigValue | undefined }
interface RemoteValidationOptions {
	allowRanges: string[];
	trustEnvProxy: boolean;
	domainPolicy: DomainPolicy;
	lookup?: Lookup;
}
interface AuthRemoteValidationConfig {
	ssrf: SsrfConfig;
	domainPolicy: DomainPolicy;
	lookup?: Lookup;
}
interface AuthenticatedRequestInit extends RequestInit {
	headers: Record<string, string>;
}
const DEFAULT_FETCH_PROVIDER_ORDER: FetchProvider[] = ["http", "kagi"];
const REMOTE_HOSTED_FETCH_PROVIDERS = new Set<FetchProvider>(["kagi"]);

export { loadSsrfConfig } from "./ssrf-protection.ts";

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function isConfigParseError(cause: unknown): boolean {
	return errorMessage(cause).startsWith("Failed to parse ");
}

function isAbortError(cause: unknown): boolean {
	return errorMessage(cause).toLowerCase().includes("abort");
}

function isConfigObject(value: ConfigValue | undefined): value is ConfigObject {
	return value !== null && value !== undefined && Object.prototype.toString.call(value) === "[object Object]";
}

function primitiveString(value: ConfigValue | undefined): string | null {
	return Object.prototype.toString.call(value) === "[object String]" && Object(value) !== value
		? String(value)
		: null;
}

function remoteValidationOptions(ssrf: SsrfConfig, domainPolicy: DomainPolicy, lookup?: Lookup): RemoteValidationOptions {
	const validation: RemoteValidationOptions = {
		allowRanges: ssrf.allowRanges,
		trustEnvProxy: ssrf.trustEnvProxy,
		domainPolicy,
	};
	if (lookup) validation.lookup = lookup;
	return validation;
}

function isRedirectPolicyError(message: string): boolean {
	return message.startsWith("Authenticated fetch refused cross-origin redirect") ||
		message.startsWith("Blocked internal ") ||
		message.startsWith("Blocked hostname by fetch_content domain policy") ||
		message.startsWith("Hostname not allowed by fetch_content domain policy") ||
		message.startsWith("Too many redirects fetching ") ||
		message === "Only HTTP and HTTPS URLs can be fetched remotely" ||
		message === "URL must include a hostname" ||
		message.startsWith("Failed to resolve ");
}

function imageGateError(): string | null {
	try {
		return isImageEnabled() ? null : "Image fetching is disabled by image.enabled";
	} catch (err) {
		return errorMessage(err);
	}
}

async function resolveAuthCookieHeader(url: string | URL, profile: AuthFetchProfile): Promise<string> {
	const parsed = assertAuthFetchUrl(profile, url.toString());
	const result = await getBrowserCookiesForHosts({ hosts: [parsed.hostname], profile: profile.chromeProfile, requestUrl: parsed });
	if (result?.cookieHeader) return result.cookieHeader;
	if (!result) {
		const diagnostic = getLastBrowserCookieDiagnostic();
		throw new Error(`Authenticated fetch profile ${profile.name} could not read browser cookies${diagnostic ? `: ${diagnostic}` : ""}`);
	}
	throw new Error(`Authenticated fetch profile ${profile.name} could not build a cookie header`);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function fetchAuthenticatedRemoteUrl(
	url: string,
	init: AuthenticatedRequestInit,
	validationOptions: AuthRemoteValidationConfig,
	profile: AuthFetchProfile,
): Promise<Response> {
	const validation = remoteValidationOptions(
		validationOptions.ssrf,
		validationOptions.domainPolicy,
		validationOptions.lookup,
	);
	let current = await validateRemoteUrl(url, validation);
	let requestInit = init;
	for (let redirects = 0; redirects <= 5; redirects++) {
		const cookieHeader = await resolveAuthCookieHeader(current, profile);
		const headers = { ...requestInit.headers, cookie: cookieHeader };
		const response = await fetch(current, { ...requestInit, headers, redirect: "manual" });
		if (!REDIRECT_STATUSES.has(response.status)) return response;
		const location = response.headers.get("location");
		if (!location) return response;
		if (redirects === 5) throw new Error(`Too many redirects fetching ${current.toString()}`);
		const from = current;
		current = await validateRemoteUrl(new URL(location, current), validation);
		authFetchRedirectGuard(profile, from, current);
		if (response.status === 303 || ((response.status === 301 || response.status === 302) && requestInit.method?.toUpperCase() === "POST")) {
			const { body: _body, ...nextInit } = requestInit;
			requestInit = { ...nextInit, method: "GET" };
		}
	}
	throw new Error(`Too many redirects fetching ${current.toString()}`);
}

function loadFetchRouting(): FetchRouting {
	if (!existsSync(WEB_SEARCH_CONFIG_PATH)) {
		return { providers: DEFAULT_FETCH_PROVIDER_ORDER, allowRemoteHostedProviders: false };
	}

	let raw: ConfigObject;
	try {
		// SAFETY: JSON.parse accepts only JSON syntax, whose runtime values are exactly ConfigValue.
		const parsed = JSON.parse(readFileSync(WEB_SEARCH_CONFIG_PATH, "utf-8")) as ConfigValue;
		if (!isConfigObject(parsed)) throw new Error("expected a JSON object");
		raw = parsed;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${WEB_SEARCH_CONFIG_PATH}: ${message}`);
	}

	if (!Object.hasOwn(raw, "fetchRouting")) {
		return { providers: DEFAULT_FETCH_PROVIDER_ORDER, allowRemoteHostedProviders: false };
	}
	const routing = raw.fetchRouting;
	if (!isConfigObject(routing)) {
		throw new Error(`fetchRouting in ${WEB_SEARCH_CONFIG_PATH} must be an object`);
	}

	const routingConfig = routing;
	const providersValue = routingConfig.providers;
	let providers = DEFAULT_FETCH_PROVIDER_ORDER;
	if (providersValue !== undefined) {
		if (!Array.isArray(providersValue) || providersValue.length === 0) {
			throw new Error(`fetchRouting.providers in ${WEB_SEARCH_CONFIG_PATH} must be a non-empty array`);
		}

		providers = [];
		for (const provider of providersValue) {
			const normalized = primitiveString(provider)?.trim().toLowerCase() ?? "";
			if (normalized !== "http" && normalized !== "kagi") {
				throw new Error(`fetchRouting.providers in ${WEB_SEARCH_CONFIG_PATH} contains an invalid provider: ${String(provider)}`);
			}
			if (providers.includes(normalized)) {
				throw new Error(`fetchRouting.providers in ${WEB_SEARCH_CONFIG_PATH} must not contain duplicates: ${normalized}`);
			}
			providers.push(normalized);
		}
	}

	const allowRemoteHostedProvidersValue = routingConfig.allowRemoteHostedProviders;
	if (allowRemoteHostedProvidersValue !== undefined && allowRemoteHostedProvidersValue !== true && allowRemoteHostedProvidersValue !== false) {
		throw new Error(`fetchRouting.allowRemoteHostedProviders in ${WEB_SEARCH_CONFIG_PATH} must be a boolean`);
	}

	return { providers, allowRemoteHostedProviders: allowRemoteHostedProvidersValue === true };
}

function abortedResult(url: string): ExtractedContent {
	return { url, title: "", content: "", error: "Aborted" };
}

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});

const fetchLimit = pLimit(CONCURRENT_LIMIT);

export interface ExtractedContent {
	url: string;
	title: string;
	content: string;
	error: string | null;
	thumbnail?: { data: string; mimeType: string };
	mimeType?: string;
	status?: number;
}

type HttpExtractedContent = ExtractedContent & { declaredLinks?: DeclaredWebLink[] };

export interface ExtractOptions {
	timeoutMs?: number;
	forceClone?: boolean;
	mode?: "readable" | "raw" | "answer";
	answerModel?: string;
	authFetchProfile?: AuthFetchProfile;
	/** Custom DNS resolver used for SSRF validation. Primarily a test seam. */
	lookup?: Lookup;
}

export async function extractContent(
	url: string,
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent> {
	if (signal?.aborted) {
		return { url, title: "", content: "", error: "Aborted" };
	}

	let remoteUrl: URL | null = null;
	try {
		const parsed = new URL(url);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") remoteUrl = parsed;
	} catch {
	}
	if (remoteUrl) {
		try {
			const ssrf = loadSsrfConfig();
			const domainPolicy = loadFetchContentDomainPolicy();
			await validateRemoteUrl(remoteUrl, remoteValidationOptions(ssrf, domainPolicy, options?.lookup));
		} catch (err) {
			return { url, title: "", content: "", error: errorMessage(err) };
		}
	}

	if (options?.authFetchProfile) {
		try {
			return await extractViaHttp(url, signal, options);
		} catch (err) {
			return { url, title: "", content: "", error: errorMessage(err) };
		}
	}

	if (options?.mode === "raw") {
		return extractViaHttp(url, signal, options);
	}

	try {
		if (!remoteUrl) new URL(url);
	} catch (err) {
		return { url, title: "", content: "", error: errorMessage(err) };
	}

	try {
		const ghResult = await extractGitHub(url, signal, options?.forceClone);
		if (ghResult) return ghResult;
		if (signal?.aborted) return abortedResult(url);
	} catch (err) {
		const message = errorMessage(err);
		if (isAbortError(err)) return abortedResult(url);
		if (isConfigParseError(err)) {
			return { url, title: "", content: "", error: message };
		}
	}

	if (signal?.aborted) return abortedResult(url);

	let fetchRouting: FetchRouting;
	try {
		fetchRouting = loadFetchRouting();
	} catch (err) {
		return { url, title: "", content: "", error: errorMessage(err) };
	}
	const providerOrder = remoteUrl && !fetchRouting.allowRemoteHostedProviders
		? fetchRouting.providers.filter(provider => !REMOTE_HOSTED_FETCH_PROVIDERS.has(provider))
		: fetchRouting.providers;
	if (providerOrder.length === 0) {
		return {
			url,
			title: "",
			content: "",
			error: "Remote hosted fetch providers are disabled unless fetchRouting.allowRemoteHostedProviders is true",
		};
	}

	let httpResult: ExtractedContent | null = null;
	let declaredLinks: DeclaredWebLink[] = [];
	const withDeclaredLinks = (result: ExtractedContent): ExtractedContent => ({
		...result,
		content: appendDeclaredWebLinks(result.content, declaredLinks),
	});
	const parseErrorResult = (message: string): ExtractedContent => httpResult
		? { ...httpResult, error: message }
		: { url, title: "", content: "", error: message };
	const runHttpProvider = async (): Promise<ExtractedContent | null> => {
		const { declaredLinks: discoveredLinks = [], ...result } = await extractViaHttp(url, signal, options);
		httpResult = result;
		declaredLinks = discoveredLinks;
		if (signal?.aborted) return abortedResult(url);
		if (!httpResult.error) return httpResult;
		if (NON_RECOVERABLE_ERRORS.some(prefix => httpResult!.error!.startsWith(prefix)) || isRedirectPolicyError(httpResult.error) || isConfigParseError(httpResult.error)) {
			return httpResult;
		}
		return null;
	};

	let kagiError: string | null = null;

	if (remoteUrl && providerOrder[0] !== "http") {
		const httpGateResult = await runHttpProvider();
		if (httpGateResult) return httpGateResult;
	}

	for (const provider of providerOrder) {
		if (signal?.aborted) return abortedResult(url);
		if (provider === "http") {
			const result = await runHttpProvider();
			if (result) return result;
			continue;
		}
		try {
			if (isKagiExtractAvailable()) {
				const ssrf = loadSsrfConfig();
				const kagiOptions: Parameters<typeof extractWithKagi>[2] = {
					timeoutMs: options?.timeoutMs,
					ssrf,
				};
				if (options?.lookup) kagiOptions.lookup = options.lookup;
				const result = await extractWithKagi(url, signal, kagiOptions);
				if (result) return withDeclaredLinks(result);
			}
		} catch (err) {
			if (isAbortError(err)) return abortedResult(url);
			kagiError = errorMessage(err);
			if (isConfigParseError(err)) return parseErrorResult(kagiError);
		}
	}

	if (signal?.aborted) return abortedResult(url);
	const getHttpResult = (): ExtractedContent | null => httpResult;
	const finalHttpResult = getHttpResult();
	if (finalHttpResult && declaredLinks.length > 0) return { ...finalHttpResult, error: null };
	const guidance = [
		finalHttpResult?.error ?? "No fetch_content provider returned content",
		...(kagiError ? [`Kagi fallback failed: ${kagiError}`] : []),
		"",
		"Fallback options:",
		`  • Set kagiApiKey in ${WEB_SEARCH_CONFIG_PATH} or KAGI_API_KEY`,
		"  • Use web_search to find content about this topic",
	].join("\n");
	return { ...(finalHttpResult ?? { url, title: "", content: "", error: null }), error: guidance };
}

function isLikelyJSRendered(html: string): boolean {
	// Extract body content
	const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	if (!bodyMatch) return false;

	const bodyHtml = bodyMatch[1];

	// Strip tags to get text content
	const textContent = bodyHtml
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();

	// Count scripts
	const scriptCount = (html.match(/<script/gi) || []).length;

	// Heuristic: little text content but many scripts suggests JS rendering
	return textContent.length < 500 && scriptCount > 3;
}

export async function readPDFResponseBuffer(response: Response, maxSizeMB: number): Promise<ArrayBuffer> {
	const maxBytes = maxSizeMB * 1024 * 1024;
	return readResponseBufferWithLimit(response, maxBytes, () => pdfSizeLimitError(maxSizeMB));
}

async function readTextResponseWithLimit(response: Response, maxBytes: number): Promise<string> {
	const buffer = await readResponseBufferWithLimit(response, maxBytes, () => responseSizeLimitError(maxBytes));
	const charset = response.headers.get("content-type")?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
	try {
		return new TextDecoder(charset || "utf-8").decode(buffer);
	} catch {
		return new TextDecoder("utf-8").decode(buffer);
	}
}

function isTextContentType(contentType: string): boolean {
	const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	return mimeType.startsWith("text/") ||
		mimeType === "application/json" ||
		mimeType === "application/ld+json" ||
		mimeType === "application/xml" ||
		mimeType === "application/xhtml+xml" ||
		mimeType === "application/javascript" ||
		mimeType === "application/x-javascript" ||
		mimeType.endsWith("+json") ||
		mimeType.endsWith("+xml");
}

async function readResponseBufferWithLimit(
	response: Response,
	maxBytes: number,
	buildError: () => Error,
): Promise<ArrayBuffer> {
	const reader = response.body?.getReader();
	if (!reader) {
		const buffer = await response.arrayBuffer();
		if (buffer.byteLength > maxBytes) throw buildError();
		return buffer;
	}

	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel();
				throw buildError();
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const combined = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return combined.buffer;
}

function pdfSizeLimitError(maxSizeMB: number): Error {
	return new Error(`PDF exceeds configured pdf.maxSizeMB limit (${maxSizeMB} MB)`);
}

function responseSizeLimitError(maxBytes: number): Error {
	return new Error(`Response too large (${Math.round(maxBytes / 1024 / 1024)}MB)`);
}

async function extractViaHttp(
	url: string,
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<HttpExtractedContent> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const activityId = activityMonitor.logStart({ type: "fetch", url });

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort);

	try {
		const ssrf = loadSsrfConfig();
		const domainPolicy = loadFetchContentDomainPolicy();
		const authProfile = options?.authFetchProfile;
		const requestInit = {
			signal: controller.signal,
			headers: {
				"User-Agent": "choco-pi-web-access/0.24.1",
				"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
				"Cache-Control": "no-cache",
				"Sec-Fetch-Dest": "document",
				"Sec-Fetch-Mode": "navigate",
				"Sec-Fetch-Site": "none",
				"Sec-Fetch-User": "?1",
				"Upgrade-Insecure-Requests": "1",
			},
		};
		const validation = remoteValidationOptions(ssrf, domainPolicy, options?.lookup);
		const authValidation: AuthRemoteValidationConfig = { ssrf, domainPolicy };
		if (options?.lookup) authValidation.lookup = options.lookup;
		const response = authProfile
			? await fetchAuthenticatedRemoteUrl(url, requestInit, authValidation, authProfile)
			: await fetchRemoteUrl(url, requestInit, validation);

		if (!response.ok && options?.mode !== "raw") {
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: `HTTP ${response.status}: ${response.statusText}`,
				status: response.status,
			};
		}

		const contentLengthHeader = response.headers.get("content-length");
		const contentType = response.headers.get("content-type") || "";
		const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
		const isPDFContent = isPDF(url, contentType);
		const pdfConfig = isPDFContent ? loadPDFConfig() : null;
		if (isPDFContent && pdfConfig && !pdfConfig.enabled) {
			activityMonitor.logComplete(activityId, response.status);
			return { url, title: "", content: "", error: "PDF extraction is disabled by pdf.enabled", mimeType, status: response.status };
		}
		const maxResponseSize = (pdfConfig?.maxSizeMB ?? 5) * 1024 * 1024;
		if (contentLengthHeader) {
			const contentLength = Number.parseInt(contentLengthHeader, 10);
			if (Number.isFinite(contentLength) && contentLength > maxResponseSize) {
				activityMonitor.logComplete(activityId, response.status);
				return {
					url,
					title: "",
					content: "",
					error: pdfConfig
						? pdfSizeLimitError(pdfConfig.maxSizeMB).message
						: `Response too large (${Math.round(contentLength / 1024 / 1024)}MB)`,
				};
			}
		}

		if (options?.mode === "raw") {
			if (!isTextContentType(contentType)) {
				activityMonitor.logComplete(activityId, response.status);
				return { url, title: "", content: "", error: `Unsupported content type in raw mode: ${mimeType || "missing"}`, mimeType, status: response.status };
			}
			const text = await readTextResponseWithLimit(response, maxResponseSize);
			activityMonitor.logComplete(activityId, response.status);
			return { url, title: extractTextTitle(text, url), content: text, error: null, mimeType, status: response.status };
		}

		if (SUPPORTED_IMAGE_TYPES.has(mimeType)) {
			const disabled = imageGateError();
			if (disabled) {
				activityMonitor.logComplete(activityId, response.status);
				return { url, title: "", content: "", error: disabled, mimeType, status: response.status };
			}
			try {
				const buffer = await readResponseBufferWithLimit(response, maxResponseSize, () => responseSizeLimitError(maxResponseSize));
				const resized = await resizeImage(new Uint8Array(buffer), mimeType, { maxWidth: 2000, maxHeight: 2000 });
				activityMonitor.logComplete(activityId, response.status);
				if (!resized) return { url, title: "", content: "", error: `Could not decode image: ${mimeType}`, mimeType, status: response.status };
				const title = new URL(response.url || url).pathname.split("/").pop() || url;
				return {
					url,
					title,
					content: `Image fetched (${resized.width}×${resized.height}, ${resized.mimeType})`,
					error: null,
					thumbnail: { data: resized.data, mimeType: resized.mimeType },
					mimeType: resized.mimeType,
					status: response.status,
				};
			} catch (err) {
				const message = errorMessage(err);
				activityMonitor.logError(activityId, message);
				return { url, title: "", content: "", error: message, mimeType, status: response.status };
			}
		}

		if (isPDFContent && pdfConfig) {
			try {
				const buffer = await readPDFResponseBuffer(response, pdfConfig.maxSizeMB);
				if (signal?.aborted) return abortedResult(url);
				const result = await extractPDFToMarkdown(buffer, url, { signal });
				activityMonitor.logComplete(activityId, response.status);
				return {
					url,
					title: result.title,
					content: `PDF extracted and saved to: ${result.outputPath}\n\nPages: ${result.pages}\nCharacters: ${result.chars}`,
					error: null,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				activityMonitor.logError(activityId, message);
				if (message.startsWith("PDF exceeds configured pdf.maxSizeMB limit")) {
					return { url, title: "", content: "", error: message };
				}
				if (err instanceof CredentialResolutionError || isConfigParseError(err)) {
					return { url, title: "", content: "", error: message };
				}
				return { url, title: "", content: "", error: `PDF extraction failed: ${message}` };
			}
		}

		if (contentType.includes("application/octet-stream") ||
			contentType.includes("image/") ||
			contentType.includes("audio/") ||
			contentType.includes("video/") ||
			contentType.includes("application/zip")) {
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: `Unsupported content type: ${contentType.split(";")[0]}`,
			};
		}

		const text = await readTextResponseWithLimit(response, maxResponseSize);
		const isHTML = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");

		if (!isHTML) {
			activityMonitor.logComplete(activityId, response.status);
			const title = extractTextTitle(text, url);
			return { url, title, content: text, error: null };
		}

		const { document } = parseHTML(text);
		const documentTitle = document.title?.trim() ?? "";
		// SAFETY: linkedom implements the DOM Document API consumed by Readability and link discovery; the packages use distinct nominal declarations.
		const domDocument = document as Document;
		const declaredLinks = discoverDeclaredWebLinks(
			domDocument,
			response.headers.get("link"),
			response.url || url,
		);
		const reader = new Readability(domDocument);
		const article = reader.parse();

		if (!article) {
			const rscResult = extractRSCContent(text);
			if (rscResult && rscResult.content.length >= MIN_USEFUL_CONTENT) {
				activityMonitor.logComplete(activityId, response.status);
				return {
					url,
					title: rscResult.title,
					content: appendDeclaredWebLinks(rscResult.content, declaredLinks),
					error: null,
					declaredLinks,
				};
			}

			activityMonitor.logComplete(activityId, response.status);
			const jsRendered = isLikelyJSRendered(text);
			const errorMsg = jsRendered
				? "Page appears to be JavaScript-rendered (content loads dynamically)"
				: "Could not extract readable content from HTML structure";

			return {
				url,
				title: documentTitle,
				content: appendDeclaredWebLinks("", declaredLinks),
				error: errorMsg,
				declaredLinks,
			};
		}

		const articleContent = Object.prototype.toString.call(article.content) === "[object String]" && Object(article.content) !== article.content
			? String(article.content)
			: null;
		if (articleContent === null) {
			throw new Error("Readability returned invalid article content");
		}
		const markdown = turndown.turndown(articleContent);
		activityMonitor.logComplete(activityId, response.status);

		if (markdown.length < MIN_USEFUL_CONTENT) {
			const rscResult = extractRSCContent(text);
			if (rscResult && rscResult.content.length >= MIN_USEFUL_CONTENT) {
				return {
					url,
					title: rscResult.title,
					content: appendDeclaredWebLinks(rscResult.content, declaredLinks),
					error: null,
					declaredLinks,
				};
			}
			return {
				url,
				title: article.title || documentTitle,
				content: appendDeclaredWebLinks(markdown, declaredLinks),
				error: isLikelyJSRendered(text)
					? "Page appears to be JavaScript-rendered (content loads dynamically)"
					: "Extracted content appears incomplete",
				declaredLinks,
			};
		}

		return {
			url,
			title: article.title || documentTitle,
			content: appendDeclaredWebLinks(markdown, declaredLinks),
			error: null,
			declaredLinks,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return { url, title: "", content: "", error: message };
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
	}
}

export function extractHeadingTitle(text: string): string | null {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (!match) return null;
	const cleaned = match[1].replace(/\*+/g, "").trim();
	return cleaned || null;
}

function extractTextTitle(text: string, url: string): string {
	return extractHeadingTitle(text) ?? (new URL(url).pathname.split("/").pop() || url);
}

export async function fetchAllContent(
	urls: string[],
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent[]> {
	const results = await Promise.all(urls.map((url) => fetchLimit(() => extractContent(url, signal, options))));
	if (options?.mode === "raw") return results;
	// Inline data: URIs in extracted markdown would otherwise flow into tool
	// results and the fetch cache as opaque base64; typed thumbnail/frame image
	// blocks are deliberate outputs and are left untouched.
	return results.map((result, index) => {
		if (!result.content) return result;
		const sanitized = sanitizeInlineDataUris(result.content, `urls[${index}].content`);
		return sanitized.omissions.length > 0 ? { ...result, content: sanitized.text } : result;
	});
}
