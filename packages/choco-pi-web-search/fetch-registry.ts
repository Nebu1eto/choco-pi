import type { DeclaredWebLink } from "./declared-web-links.ts";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";

/** Global symbol key for the shared `WebAccessScope` registry across jiti `moduleCache: false` extensions. */
export const WEB_ACCESS_SCOPE_SYMBOL = Symbol.for("choco-pi:web-access/v1");
export const WEB_ACCESS_SCOPE_VERSION = 1;

/** Pipeline stage at which a `ContentExtractor` runs: before fetching or on the HTTP response. */
export type ContentExtractorStage = "pre-fetch" | "response";

/** Stage-dependent request and response metadata passed to `ContentExtractor.match` and `extract`. */
export interface ContentExtractorContext {
  url: string;
  parsedUrl?: URL;
  signal?: AbortSignal;
  options?: ExtractOptions;
  stage: ContentExtractorStage;
  response?: Response;
  contentType?: string;
  mimeType?: string;
  html?: string;
  documentTitle?: string;
  declaredLinks?: DeclaredWebLink[];
  maxResponseSize?: number;
  activityId?: string;
}

/** Pluggable URL/response extractor contract ordered by ascending `priority` within a stage. */
export interface ContentExtractor {
  id: string;
  priority: number;
  stage?: ContentExtractorStage;
  match(ctx: ContentExtractorContext): boolean;
  extract(ctx: ContentExtractorContext): Promise<ExtractedContent | null>;
}

/** Request context and active `WebAccessScope` passed to a registered `FetchTransport`. */
export interface FetchTransportContext {
  url: string;
  remoteUrl: URL | null;
  signal?: AbortSignal;
  options?: ExtractOptions;
  declaredLinks: DeclaredWebLink[];
  scope: WebAccessScope;
}

/** Extracted page payload returned by a `FetchTransport`, with optional discovered links and retry hint. */
export interface FetchTransportResult {
  content: ExtractedContent;
  declaredLinks?: DeclaredWebLink[];
  /** When true, stops fallback to subsequent transports after this result. */
  nonRecoverable?: boolean;
}

/** Pluggable web fetch backend contract distinguishing hosted vs. local transports. */
export interface FetchTransport {
  id: string;
  hosted: boolean;
  available(): Promise<boolean> | boolean;
  fetch(ctx: FetchTransportContext): Promise<FetchTransportResult | null>;
}

/** Process-local registry holding content extractors and fetch transports for `choco-pi-web-access`. */
export class WebAccessScope {
  readonly scopeVersion: typeof WEB_ACCESS_SCOPE_VERSION = WEB_ACCESS_SCOPE_VERSION;
  readonly extractors = new Map<string, ContentExtractor>();
  readonly transports = new Map<string, FetchTransport>();

  registerContentExtractor(extractor: ContentExtractor): () => void {
    const id = extractor.id.trim();
    if (!id) throw new Error("ContentExtractor id must be non-empty");
    if (this.extractors.has(id)) {
      throw new Error(`ContentExtractor id is already registered: ${id}`);
    }
    this.extractors.set(id, extractor);
    return () => {
      if (this.extractors.get(id) === extractor) this.extractors.delete(id);
    };
  }

  registerFetchTransport(transport: FetchTransport): () => void {
    const id = transport.id.trim().toLowerCase();
    if (!id) throw new Error("FetchTransport id must be non-empty");
    if (this.transports.has(id)) {
      throw new Error(`FetchTransport id is already registered: ${id}`);
    }
    this.transports.set(id, transport);
    return () => {
      if (this.transports.get(id) === transport) this.transports.delete(id);
    };
  }

  listContentExtractors(stage?: ContentExtractorStage): ContentExtractor[] {
    const entries = [...this.extractors.values()];
    const filtered = stage
      ? entries.filter((entry) => (entry.stage ?? "pre-fetch") === stage)
      : entries;
    return filtered.sort((left, right) =>
      left.priority === right.priority
        ? left.id.localeCompare(right.id)
        : left.priority - right.priority,
    );
  }

  getFetchTransport(id: string): FetchTransport | undefined {
    return this.transports.get(id.trim().toLowerCase());
  }

  listFetchTransports(): FetchTransport[] {
    return [...this.transports.values()];
  }
}

/** Structural duck-type shape used to validate an existing `WebAccessScope` across module reloads. */
export interface WebAccessScopeCandidate {
  readonly scopeVersion?: number;
  readonly extractors?: object;
  readonly transports?: object;
  readonly registerContentExtractor?: object;
  readonly registerFetchTransport?: object;
  readonly listContentExtractors?: object;
  readonly getFetchTransport?: object;
  readonly listFetchTransports?: object;
}

interface WebAccessGlobalHost {
  [WEB_ACCESS_SCOPE_SYMBOL]?: WebAccessScopeCandidate;
}

export function isWebAccessScopeLike(
  candidate: WebAccessScopeCandidate | undefined,
): candidate is WebAccessScope {
  return (
    candidate instanceof Object &&
    candidate.scopeVersion === WEB_ACCESS_SCOPE_VERSION &&
    candidate.extractors instanceof Map &&
    candidate.transports instanceof Map &&
    candidate.registerContentExtractor instanceof Function &&
    candidate.registerFetchTransport instanceof Function &&
    candidate.listContentExtractors instanceof Function &&
    candidate.getFetchTransport instanceof Function &&
    candidate.listFetchTransports instanceof Function
  );
}

export function createWebAccessScope(): WebAccessScope {
  return new WebAccessScope();
}

/** Returns the singleton `WebAccessScope` from `globalThis`, creating it on first access. */
export function getWebAccessScope(): WebAccessScope {
  // SAFETY: Process-local typed slot keyed by WEB_ACCESS_SCOPE_SYMBOL on globalThis.
  const host = globalThis as WebAccessGlobalHost;
  const existing = host[WEB_ACCESS_SCOPE_SYMBOL];
  if (isWebAccessScopeLike(existing)) return existing;
  const scope = createWebAccessScope();
  host[WEB_ACCESS_SCOPE_SYMBOL] = scope;
  return scope;
}

/** Registers a `ContentExtractor` in the active `WebAccessScope` and returns its disposer. */
export function registerContentExtractor(
  extractor: ContentExtractor,
  scope: WebAccessScope = getWebAccessScope(),
): () => void {
  return scope.registerContentExtractor(extractor);
}

/** Registers a `FetchTransport` in the active `WebAccessScope` and returns its disposer. */
export function registerFetchTransport(
  transport: FetchTransport,
  scope: WebAccessScope = getWebAccessScope(),
): () => void {
  return scope.registerFetchTransport(transport);
}
