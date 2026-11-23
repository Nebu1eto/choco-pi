import type { DeclaredWebLink } from "./declared-web-links.ts";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";

export const WEB_ACCESS_SCOPE_SYMBOL = Symbol.for("choco-pi:web-access/v1");
/**
 * Structural protocol version of the shared scope. Pi loads extensions through jiti with
 * `moduleCache: false`, so separate copies of this module define distinct `WebAccessScope`
 * classes; the shared slot is therefore recognized structurally, never with `instanceof`.
 */
export const WEB_ACCESS_SCOPE_VERSION = 1;

export type ContentExtractorStage = "pre-fetch" | "response";

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

export interface ContentExtractor {
  id: string;
  /** Lower numbers run first. */
  priority: number;
  stage?: ContentExtractorStage;
  match(ctx: ContentExtractorContext): boolean;
  extract(ctx: ContentExtractorContext): Promise<ExtractedContent | null>;
}

export interface FetchTransportContext {
  url: string;
  remoteUrl: URL | null;
  signal?: AbortSignal;
  options?: ExtractOptions;
  declaredLinks: DeclaredWebLink[];
  scope: WebAccessScope;
}

export interface FetchTransportResult {
  content: ExtractedContent;
  declaredLinks?: DeclaredWebLink[];
  nonRecoverable?: boolean;
}

export interface FetchTransport {
  id: string;
  hosted: boolean;
  available(): Promise<boolean> | boolean;
  fetch(ctx: FetchTransportContext): Promise<FetchTransportResult | null>;
}

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

/**
 * What the shared slot may hold: a scope from any module copy or protocol version. Every member
 * is optional and loosely typed until `isWebAccessScopeLike` confirms the version-1 shape.
 */
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

/**
 * True when `candidate` carries every public member of a version-1 `WebAccessScope`, including
 * one created by another module copy. `WebAccessScope` has no private members, so this
 * structural check matches its TypeScript type.
 */
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

export function getWebAccessScope(): WebAccessScope {
  // SAFETY: Process-local typed slot keyed by WEB_ACCESS_SCOPE_SYMBOL on globalThis.
  const host = globalThis as WebAccessGlobalHost;
  const existing = host[WEB_ACCESS_SCOPE_SYMBOL];
  if (isWebAccessScopeLike(existing)) return existing;
  const scope = createWebAccessScope();
  host[WEB_ACCESS_SCOPE_SYMBOL] = scope;
  return scope;
}

export function registerContentExtractor(
  extractor: ContentExtractor,
  scope: WebAccessScope = getWebAccessScope(),
): () => void {
  return scope.registerContentExtractor(extractor);
}

export function registerFetchTransport(
  transport: FetchTransport,
  scope: WebAccessScope = getWebAccessScope(),
): () => void {
  return scope.registerFetchTransport(transport);
}
