import type { DeclaredWebLink } from "./declared-web-links.ts";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";

export const WEB_ACCESS_SCOPE_SYMBOL = Symbol.for("choco-pi:web-access/v1");

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

interface WebAccessGlobalHost {
  [WEB_ACCESS_SCOPE_SYMBOL]?: WebAccessScope;
}

export function createWebAccessScope(): WebAccessScope {
  return new WebAccessScope();
}

export function getWebAccessScope(): WebAccessScope {
  // SAFETY: Process-local typed slot keyed by WEB_ACCESS_SCOPE_SYMBOL on globalThis.
  const host = globalThis as WebAccessGlobalHost;
  let scope = host[WEB_ACCESS_SCOPE_SYMBOL];
  if (!(scope instanceof WebAccessScope)) {
    scope = createWebAccessScope();
    host[WEB_ACCESS_SCOPE_SYMBOL] = scope;
  }
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
