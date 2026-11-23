import { Readability } from "@mozilla/readability";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import pLimit from "p-limit";
import { activityMonitor } from "./activity.ts";
import { getCachedWebSearchConfig, isConfigObject, type ConfigValue } from "./config-loader.ts";
import {
  getWebAccessScope,
  type ContentExtractor,
  type ContentExtractorContext,
  type FetchTransport,
  type WebAccessScope,
} from "./fetch-registry.ts";
import { isAbortError } from "./value-guards.ts";
import { extractRSCContent } from "./rsc-extract.ts";
import { extractPDFToMarkdown, isPDF, loadPDFConfig } from "./pdf-extract.ts";
import { extractGitHub } from "./github-extract.ts";
import { CredentialResolutionError } from "./credential-source.ts";
import { extractWithKagi, isKagiExtractAvailable } from "./kagi.ts";
import {
  appendDeclaredWebLinks,
  discoverDeclaredWebLinks,
  type DeclaredWebLink,
} from "./declared-web-links.ts";
import {
  fetchRemoteUrl,
  loadFetchContentDomainPolicy,
  loadSsrfConfig,
  validateRemoteUrl,
  type DomainPolicy,
  type Lookup,
  type SsrfConfig,
} from "./ssrf-protection.ts";
import { getWebSearchConfigPath } from "./utils.ts";
import { isImageEnabled } from "./feature-config.ts";
import { assertAuthFetchUrl, authFetchRedirectGuard, type AuthFetchProfile } from "./auth-fetch.ts";
import { getBrowserCookiesForHosts, getLastBrowserCookieDiagnostic } from "./chrome-cookies.ts";
import { sanitizeInlineDataUris } from "./data-uri-sanitize.ts";
import { discardResponse } from "./pinned-http.ts";

const DEFAULT_TIMEOUT_MS = 30000;
const CONCURRENT_LIMIT = 3;

const NON_RECOVERABLE_ERRORS = [
  "Unsupported content type",
  "Response too large",
  "PDF extraction is disabled",
  "Image fetching is disabled",
];
const MIN_USEFUL_CONTENT = 500;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const WEB_SEARCH_CONFIG_PATH = getWebSearchConfigPath();
type FetchRouting = { providers: string[]; allowRemoteHostedProviders: boolean };
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
  fetch?: typeof fetch;
}
interface AuthenticatedRequestInit extends RequestInit {
  headers: Record<string, string>;
}
const DEFAULT_BUILTIN_FETCH_ORDER = ["http", "kagi"] as const;

export { loadSsrfConfig } from "./ssrf-protection.ts";
export {
  createWebAccessScope,
  getWebAccessScope,
  registerContentExtractor,
  registerFetchTransport,
  WEB_ACCESS_SCOPE_SYMBOL,
  WebAccessScope,
  type ContentExtractor,
  type ContentExtractorContext,
  type ContentExtractorStage,
  type FetchTransport,
  type FetchTransportContext,
  type FetchTransportResult,
} from "./fetch-registry.ts";

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isConfigParseError(cause: unknown): boolean {
  return errorMessage(cause).startsWith("Failed to parse ");
}

function primitiveString(value: ConfigValue | undefined): string | null {
  return Object.prototype.toString.call(value) === "[object String]" && Object(value) !== value
    ? String(value)
    : null;
}

function remoteValidationOptions(
  ssrf: SsrfConfig,
  domainPolicy: DomainPolicy,
  lookup?: Lookup,
): RemoteValidationOptions {
  const validation: RemoteValidationOptions = {
    allowRanges: ssrf.allowRanges,
    trustEnvProxy: ssrf.trustEnvProxy,
    domainPolicy,
  };
  if (lookup) validation.lookup = lookup;
  return validation;
}

function isRedirectPolicyError(message: string): boolean {
  return (
    message.startsWith("Authenticated fetch refused cross-origin redirect") ||
    message.startsWith("Blocked internal ") ||
    message.startsWith("Blocked hostname by fetch_content domain policy") ||
    message.startsWith("Hostname not allowed by fetch_content domain policy") ||
    message.startsWith("Too many redirects fetching ") ||
    message === "Only HTTP and HTTPS URLs can be fetched remotely" ||
    message === "URL must include a hostname" ||
    message.startsWith("Failed to resolve ")
  );
}

function imageGateError(): string | null {
  try {
    return isImageEnabled() ? null : "Image fetching is disabled by image.enabled";
  } catch (err) {
    return errorMessage(err);
  }
}

async function resolveAuthCookieHeader(
  url: string | URL,
  profile: AuthFetchProfile,
): Promise<string> {
  const parsed = assertAuthFetchUrl(profile, url.toString());
  const result = await getBrowserCookiesForHosts({
    hosts: [parsed.hostname],
    profile: profile.chromeProfile,
    requestUrl: parsed,
  });
  if (result?.cookieHeader) return result.cookieHeader;
  if (!result) {
    const diagnostic = getLastBrowserCookieDiagnostic();
    throw new Error(
      `Authenticated fetch profile ${profile.name} could not read browser cookies${diagnostic ? `: ${diagnostic}` : ""}`,
    );
  }
  throw new Error(`Authenticated fetch profile ${profile.name} could not build a cookie header`);
}

export async function fetchAuthenticatedRemoteUrl(
  url: string,
  init: AuthenticatedRequestInit,
  validationOptions: AuthRemoteValidationConfig,
  profile: AuthFetchProfile,
  cookieProvider: typeof resolveAuthCookieHeader = resolveAuthCookieHeader,
): Promise<Response> {
  const validation = remoteValidationOptions(
    validationOptions.ssrf,
    validationOptions.domainPolicy,
    validationOptions.lookup,
  );
  const authProfile = { ...profile, hosts: [...profile.hosts] };
  const signal = init.signal;
  return fetchRemoteUrl(url, init, {
    ...validation,
    fetch: validationOptions.fetch,
    async prepareRequest(current, requestInit) {
      const cookieHeader = await cookieProvider(current, authProfile);
      signal?.throwIfAborted();
      const headers = new Headers(requestInit.headers);
      headers.set("cookie", cookieHeader);
      return { ...requestInit, headers };
    },
    onRedirect({ from, to, init: nextInit }) {
      authFetchRedirectGuard(authProfile, from, to);
      return nextInit;
    },
  });
}

function defaultFetchOrder(scope: WebAccessScope): string[] {
  const builtin = new Set<string>(DEFAULT_BUILTIN_FETCH_ORDER);
  const custom = scope
    .listFetchTransports()
    .map((transport) => transport.id)
    .filter((id) => !builtin.has(id));
  return [...DEFAULT_BUILTIN_FETCH_ORDER.filter((id) => scope.getFetchTransport(id)), ...custom];
}

function loadFetchRouting(scope: WebAccessScope): FetchRouting {
  const raw = getCachedWebSearchConfig();
  const defaultOrder = defaultFetchOrder(scope);

  if (!Object.hasOwn(raw, "fetchRouting")) {
    return { providers: defaultOrder, allowRemoteHostedProviders: false };
  }
  const routing = raw.fetchRouting;
  if (!isConfigObject(routing)) {
    throw new Error(`fetchRouting in ${WEB_SEARCH_CONFIG_PATH} must be an object`);
  }

  const routingConfig = routing;
  const providersValue = routingConfig.providers;
  let providers = defaultOrder;
  if (providersValue !== undefined) {
    if (!Array.isArray(providersValue) || providersValue.length === 0) {
      throw new Error(
        `fetchRouting.providers in ${WEB_SEARCH_CONFIG_PATH} must be a non-empty array`,
      );
    }

    providers = [];
    for (const provider of providersValue) {
      const normalized = primitiveString(provider)?.trim().toLowerCase() ?? "";
      if (!normalized || !scope.getFetchTransport(normalized)) {
        throw new Error(
          `fetchRouting.providers in ${WEB_SEARCH_CONFIG_PATH} contains an invalid provider: ${String(provider)}`,
        );
      }
      if (providers.includes(normalized)) {
        throw new Error(
          `fetchRouting.providers in ${WEB_SEARCH_CONFIG_PATH} must not contain duplicates: ${normalized}`,
        );
      }
      providers.push(normalized);
    }
  }

  const allowRemoteHostedProvidersValue = routingConfig.allowRemoteHostedProviders;
  if (
    allowRemoteHostedProvidersValue !== undefined &&
    allowRemoteHostedProvidersValue !== true &&
    allowRemoteHostedProvidersValue !== false
  ) {
    throw new Error(
      `fetchRouting.allowRemoteHostedProviders in ${WEB_SEARCH_CONFIG_PATH} must be a boolean`,
    );
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
  /** Explicit transport fixture seam; direct requests otherwise use approved DNS snapshots. */
  fetch?: typeof fetch;
  /** Optional isolated web-access registry scope (defaults to process-shared scope). */
  scope?: WebAccessScope;
}

function createBuiltinExtractors(): ContentExtractor[] {
  return [
    {
      id: "github",
      priority: 10,
      stage: "pre-fetch",
      match: () => true,
      extract: (ctx) => extractGitHub(ctx.url, ctx.signal, ctx.options?.forceClone),
    },
    {
      id: "pdf",
      priority: 10,
      stage: "response",
      match: (ctx) => isPDF(ctx.url, ctx.contentType ?? ""),
      extract: async (ctx) => {
        const response = ctx.response;
        if (!response) return null;
        const pdfConfig = loadPDFConfig();
        if (!pdfConfig.enabled) {
          if (ctx.activityId !== undefined)
            activityMonitor.logComplete(ctx.activityId, response.status);
          return {
            url: ctx.url,
            title: "",
            content: "",
            error: "PDF extraction is disabled by pdf.enabled",
            mimeType: ctx.mimeType,
            status: response.status,
          };
        }
        try {
          const buffer = await readPDFResponseBuffer(response, pdfConfig.maxSizeMB);
          if (ctx.signal?.aborted) return abortedResult(ctx.url);
          const result = await extractPDFToMarkdown(buffer, ctx.url, { signal: ctx.signal });
          if (ctx.activityId !== undefined)
            activityMonitor.logComplete(ctx.activityId, response.status);
          return {
            url: ctx.url,
            title: result.title,
            content: `PDF extracted and saved to: ${result.outputPath}\n\nPages: ${result.pages}\nCharacters: ${result.chars}`,
            error: null,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (ctx.activityId !== undefined) activityMonitor.logError(ctx.activityId, message);
          if (message.startsWith("PDF exceeds configured pdf.maxSizeMB limit")) {
            return { url: ctx.url, title: "", content: "", error: message };
          }
          if (err instanceof CredentialResolutionError || isConfigParseError(err)) {
            return { url: ctx.url, title: "", content: "", error: message };
          }
          return {
            url: ctx.url,
            title: "",
            content: "",
            error: `PDF extraction failed: ${message}`,
          };
        }
      },
    },
    {
      id: "readability",
      priority: 50,
      stage: "response",
      match: (ctx) => Boolean(ctx.html),
      extract: async (ctx) => {
        const text = ctx.html;
        if (!text) return null;
        const declaredLinks = ctx.declaredLinks ?? [];
        const { document } = parseHTML(text);
        const documentTitle = ctx.documentTitle ?? document.title?.trim() ?? "";
        // SAFETY: linkedom implements the DOM Document API consumed by Readability.
        const reader = new Readability(document as Document);
        const article = reader.parse();
        if (!article) return null;
        const articleContent =
          Object.prototype.toString.call(article.content) === "[object String]" &&
          Object(article.content) !== article.content
            ? String(article.content)
            : null;
        if (articleContent === null) {
          throw new Error("Readability returned invalid article content");
        }
        const markdown = turndown.turndown(articleContent);
        if (markdown.length < MIN_USEFUL_CONTENT) return null;
        if (ctx.activityId !== undefined && ctx.response) {
          activityMonitor.logComplete(ctx.activityId, ctx.response.status);
        }
        return {
          url: ctx.url,
          title: article.title || documentTitle,
          content: appendDeclaredWebLinks(markdown, declaredLinks),
          error: null,
        };
      },
    },
    {
      id: "rsc",
      priority: 60,
      stage: "response",
      match: (ctx) => Boolean(ctx.html),
      extract: async (ctx) => {
        const text = ctx.html;
        if (!text) return null;
        const declaredLinks = ctx.declaredLinks ?? [];
        const rscResult = extractRSCContent(text);
        if (!rscResult || rscResult.content.length < MIN_USEFUL_CONTENT) return null;
        if (ctx.activityId !== undefined && ctx.response) {
          activityMonitor.logComplete(ctx.activityId, ctx.response.status);
        }
        return {
          url: ctx.url,
          title: rscResult.title,
          content: appendDeclaredWebLinks(rscResult.content, declaredLinks),
          error: null,
        };
      },
    },
  ];
}

function createBuiltinTransports(): FetchTransport[] {
  return [
    {
      id: "http",
      hosted: false,
      available: () => true,
      fetch: async (ctx) => {
        const { declaredLinks: discoveredLinks = [], ...result } = await extractViaHttp(
          ctx.url,
          ctx.signal,
          ctx.options,
          ctx.scope,
        );
        const nonRecoverable = Boolean(
          result.error &&
          (NON_RECOVERABLE_ERRORS.some((prefix) => result.error!.startsWith(prefix)) ||
            isRedirectPolicyError(result.error) ||
            isConfigParseError(result.error)),
        );
        return { content: result, declaredLinks: discoveredLinks, nonRecoverable };
      },
    },
    {
      id: "kagi",
      hosted: true,
      available: () => isKagiExtractAvailable(),
      fetch: async (ctx) => {
        const ssrf = loadSsrfConfig();
        const kagiOptions: Parameters<typeof extractWithKagi>[2] = {
          timeoutMs: ctx.options?.timeoutMs,
          ssrf,
        };
        if (ctx.options?.lookup) kagiOptions.lookup = ctx.options.lookup;
        const result = await extractWithKagi(ctx.url, ctx.signal, kagiOptions);
        if (!result) return null;
        return {
          content: {
            ...result,
            content: appendDeclaredWebLinks(result.content, ctx.declaredLinks),
          },
        };
      },
    },
  ];
}

export function ensureBuiltinFetchRegistry(
  scope: WebAccessScope = getWebAccessScope(),
): WebAccessScope {
  for (const extractor of createBuiltinExtractors()) {
    if (!scope.extractors.has(extractor.id)) scope.registerContentExtractor(extractor);
  }
  for (const transport of createBuiltinTransports()) {
    if (!scope.transports.has(transport.id)) scope.registerFetchTransport(transport);
  }
  return scope;
}

ensureBuiltinFetchRegistry(getWebAccessScope());

export async function extractContent(
  url: string,
  signal?: AbortSignal,
  options?: ExtractOptions,
): Promise<ExtractedContent> {
  if (signal?.aborted) {
    return { url, title: "", content: "", error: "Aborted" };
  }
  const scope = ensureBuiltinFetchRegistry(options?.scope ?? getWebAccessScope());

  let remoteUrl: URL | null = null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") remoteUrl = parsed;
  } catch {
    remoteUrl = null;
  }
  if (remoteUrl) {
    try {
      const ssrf = loadSsrfConfig();
      const domainPolicy = loadFetchContentDomainPolicy();
      await validateRemoteUrl(
        remoteUrl,
        remoteValidationOptions(ssrf, domainPolicy, options?.lookup),
      );
    } catch (err) {
      return { url, title: "", content: "", error: errorMessage(err) };
    }
  }

  if (options?.authFetchProfile) {
    try {
      return await extractViaHttp(url, signal, options, scope);
    } catch (err) {
      return { url, title: "", content: "", error: errorMessage(err) };
    }
  }

  if (options?.mode === "raw") {
    return extractViaHttp(url, signal, options, scope);
  }

  try {
    if (!remoteUrl) new URL(url);
  } catch (err) {
    return { url, title: "", content: "", error: errorMessage(err) };
  }

  const preFetchCtx: ContentExtractorContext = {
    url,
    stage: "pre-fetch",
  };
  if (remoteUrl) preFetchCtx.parsedUrl = remoteUrl;
  if (signal) preFetchCtx.signal = signal;
  if (options) preFetchCtx.options = options;
  for (const extractor of scope.listContentExtractors("pre-fetch")) {
    if (!extractor.match(preFetchCtx)) continue;
    try {
      const extracted = await extractor.extract(preFetchCtx);
      if (extracted) return extracted;
      if (signal?.aborted) return abortedResult(url);
    } catch (err) {
      const message = errorMessage(err);
      if (isAbortError(err)) return abortedResult(url);
      if (isConfigParseError(err)) {
        return { url, title: "", content: "", error: message };
      }
    }
  }

  if (signal?.aborted) return abortedResult(url);

  let fetchRouting: FetchRouting;
  try {
    fetchRouting = loadFetchRouting(scope);
  } catch (err) {
    return { url, title: "", content: "", error: errorMessage(err) };
  }
  const providerOrder =
    remoteUrl && !fetchRouting.allowRemoteHostedProviders
      ? fetchRouting.providers.filter((provider) => !scope.getFetchTransport(provider)?.hosted)
      : fetchRouting.providers;
  if (providerOrder.length === 0) {
    return {
      url,
      title: "",
      content: "",
      error:
        "Remote hosted fetch providers are disabled unless fetchRouting.allowRemoteHostedProviders is true",
    };
  }

  let httpResult: ExtractedContent | null = null;
  let declaredLinks: DeclaredWebLink[] = [];
  const parseErrorResult = (message: string): ExtractedContent =>
    httpResult
      ? { ...httpResult, error: message }
      : { url, title: "", content: "", error: message };
  const runTransport = async (transport: FetchTransport): Promise<ExtractedContent | null> => {
    const transportResult = await transport.fetch({
      url,
      remoteUrl,
      signal,
      options,
      declaredLinks,
      scope,
    });
    if (signal?.aborted) return abortedResult(url);
    if (!transportResult) return null;
    if (transport.id === "http") {
      httpResult = transportResult.content;
      declaredLinks = transportResult.declaredLinks ?? [];
    }
    if (!transportResult.content.error || transportResult.nonRecoverable) {
      return transportResult.content;
    }
    return null;
  };

  const transportErrors: Array<{ id: string; message: string }> = [];

  if (remoteUrl && providerOrder[0] !== "http") {
    const httpTransport = scope.getFetchTransport("http");
    if (httpTransport) {
      const httpGateResult = await runTransport(httpTransport);
      if (httpGateResult) return httpGateResult;
    }
  }

  for (const provider of providerOrder) {
    if (signal?.aborted) return abortedResult(url);
    const transport = scope.getFetchTransport(provider);
    if (!transport) continue;
    try {
      if (!(await transport.available())) continue;
      const result = await runTransport(transport);
      if (result) return result;
    } catch (err) {
      if (isAbortError(err)) return abortedResult(url);
      const message = errorMessage(err);
      transportErrors.push({ id: provider, message });
      if (isConfigParseError(err)) return parseErrorResult(message);
    }
  }

  if (signal?.aborted) return abortedResult(url);
  const getHttpResult = (): ExtractedContent | null => httpResult;
  const finalHttpResult = getHttpResult();
  if (finalHttpResult && declaredLinks.length > 0) return { ...finalHttpResult, error: null };
  const kagiError = transportErrors.find((entry) => entry.id === "kagi")?.message ?? null;
  const otherErrors = transportErrors
    .filter((entry) => entry.id !== "kagi")
    .map((entry) => `${entry.id} fallback failed: ${entry.message}`);
  const guidance = [
    finalHttpResult?.error ?? "No fetch_content provider returned content",
    ...(kagiError ? [`Kagi fallback failed: ${kagiError}`] : []),
    ...otherErrors,
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

export async function readPDFResponseBuffer(
  response: Response,
  maxSizeMB: number,
): Promise<ArrayBuffer> {
  const maxBytes = maxSizeMB * 1024 * 1024;
  return readResponseBufferWithLimit(response, maxBytes, () => pdfSizeLimitError(maxSizeMB));
}

async function readTextResponseWithLimit(response: Response, maxBytes: number): Promise<string> {
  const buffer = await readResponseBufferWithLimit(response, maxBytes, () =>
    responseSizeLimitError(maxBytes),
  );
  const charset = response.headers
    .get("content-type")
    ?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
  try {
    return new TextDecoder(charset || "utf-8").decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

function isTextContentType(contentType: string): boolean {
  const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/ld+json" ||
    mimeType === "application/xml" ||
    mimeType === "application/xhtml+xml" ||
    mimeType === "application/javascript" ||
    mimeType === "application/x-javascript" ||
    mimeType.endsWith("+json") ||
    mimeType.endsWith("+xml")
  );
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
  scope: WebAccessScope = ensureBuiltinFetchRegistry(),
): Promise<HttpExtractedContent> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const activityId = activityMonitor.logStart({ type: "fetch", url });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response: Response | undefined;

  try {
    const ssrf = loadSsrfConfig();
    const domainPolicy = loadFetchContentDomainPolicy();
    const authProfile = options?.authFetchProfile;
    const requestInit = {
      signal: controller.signal,
      headers: {
        "User-Agent": "choco-pi-web-access/0.24.1",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
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
    authValidation.fetch = options?.fetch;
    response = authProfile
      ? await fetchAuthenticatedRemoteUrl(url, requestInit, authValidation, authProfile)
      : await fetchRemoteUrl(url, requestInit, { ...validation, fetch: options?.fetch });

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
      return {
        url,
        title: "",
        content: "",
        error: "PDF extraction is disabled by pdf.enabled",
        mimeType,
        status: response.status,
      };
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
        return {
          url,
          title: "",
          content: "",
          error: `Unsupported content type in raw mode: ${mimeType || "missing"}`,
          mimeType,
          status: response.status,
        };
      }
      const text = await readTextResponseWithLimit(response, maxResponseSize);
      activityMonitor.logComplete(activityId, response.status);
      return {
        url,
        title: extractTextTitle(text, url),
        content: text,
        error: null,
        mimeType,
        status: response.status,
      };
    }

    if (SUPPORTED_IMAGE_TYPES.has(mimeType)) {
      const disabled = imageGateError();
      if (disabled) {
        activityMonitor.logComplete(activityId, response.status);
        return { url, title: "", content: "", error: disabled, mimeType, status: response.status };
      }
      try {
        const buffer = await readResponseBufferWithLimit(response, maxResponseSize, () =>
          responseSizeLimitError(maxResponseSize),
        );
        const resized = await resizeImage(new Uint8Array(buffer), mimeType, {
          maxWidth: 2000,
          maxHeight: 2000,
        });
        activityMonitor.logComplete(activityId, response.status);
        if (!resized)
          return {
            url,
            title: "",
            content: "",
            error: `Could not decode image: ${mimeType}`,
            mimeType,
            status: response.status,
          };
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
      const pdfCtx: ContentExtractorContext = {
        url,
        stage: "response",
        response,
        contentType,
        mimeType,
        maxResponseSize,
        activityId,
      };
      if (signal) pdfCtx.signal = signal;
      if (options) pdfCtx.options = options;
      for (const extractor of scope.listContentExtractors("response")) {
        if (!extractor.match(pdfCtx)) continue;
        const extracted = await extractor.extract(pdfCtx);
        if (extracted) return extracted;
      }
    }

    const isHTML =
      contentType.includes("text/html") || contentType.includes("application/xhtml+xml");

    // Registered response-stage extractors get the first claim on non-HTML, non-PDF responses
    // (for example application/json) before the generic unsupported-type and plain-text paths.
    // Built-in response extractors match only PDFs or parsed HTML, so they never claim here.
    if (!isPDFContent && !isHTML) {
      const responseCtx: ContentExtractorContext = {
        url,
        stage: "response",
        response,
        contentType,
        mimeType,
        maxResponseSize,
        activityId,
      };
      if (signal) responseCtx.signal = signal;
      if (options) responseCtx.options = options;
      for (const extractor of scope.listContentExtractors("response")) {
        if (!extractor.match(responseCtx)) continue;
        const extracted = await extractor.extract(responseCtx);
        if (extracted) return extracted;
      }
    }

    if (
      contentType.includes("application/octet-stream") ||
      contentType.includes("image/") ||
      contentType.includes("audio/") ||
      contentType.includes("video/") ||
      contentType.includes("application/zip")
    ) {
      activityMonitor.logComplete(activityId, response.status);
      return {
        url,
        title: "",
        content: "",
        error: `Unsupported content type: ${contentType.split(";")[0]}`,
      };
    }

    const text = await readTextResponseWithLimit(response, maxResponseSize);

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
    const htmlCtx: ContentExtractorContext = {
      url,
      stage: "response",
      response,
      contentType,
      mimeType,
      html: text,
      documentTitle,
      declaredLinks,
      maxResponseSize,
      activityId,
    };
    if (signal) htmlCtx.signal = signal;
    if (options) htmlCtx.options = options;
    for (const extractor of scope.listContentExtractors("response")) {
      if (!extractor.match(htmlCtx)) continue;
      const extracted = await extractor.extract(htmlCtx);
      if (extracted) return { ...extracted, declaredLinks };
    }

    activityMonitor.logComplete(activityId, response.status);
    const jsRendered = isLikelyJSRendered(text);
    const reader = new Readability(domDocument);
    const article = reader.parse();
    const partialMarkdown =
      article &&
      Object.prototype.toString.call(article.content) === "[object String]" &&
      Object(article.content) !== article.content
        ? turndown.turndown(String(article.content))
        : "";
    const errorMsg = jsRendered
      ? "Page appears to be JavaScript-rendered (content loads dynamically)"
      : article
        ? "Extracted content appears incomplete"
        : "Could not extract readable content from HTML structure";
    return {
      url,
      title: article?.title || documentTitle,
      content: appendDeclaredWebLinks(partialMarkdown, declaredLinks),
      error: errorMsg,
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
    if (response?.body && !response.bodyUsed) await discardResponse(response);
  }
}

export function extractHeadingTitle(text: string): string | null {
  const match = text.match(/^#{1,2}\s+(.+)/m);
  if (!match) return null;
  const cleaned = match[1].replace(/\*+/g, "").trim();
  return cleaned || null;
}

function extractTextTitle(text: string, url: string): string {
  const heading = extractHeadingTitle(text);
  if (heading) return heading;
  try {
    return new URL(url).pathname.split("/").pop() || url;
  } catch {
    return url;
  }
}

export async function fetchAllContent(
  urls: string[],
  signal?: AbortSignal,
  options?: ExtractOptions,
): Promise<ExtractedContent[]> {
  const results = await Promise.all(
    urls.map((url) => fetchLimit(() => extractContent(url, signal, options))),
  );
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
