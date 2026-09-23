import { randomUUID } from "node:crypto";
import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Cyclic, Ref, type Static, Type } from "typebox";
import { Check } from "typebox/value";

export const searchProviderFamilies = Object.freeze([
  "openai",
  "exa",
  "kagi",
  "synthetic",
  "brave",
] as const);
export const defaultSearchFamilyOrder: readonly SearchProviderFamily[] = searchProviderFamilies;
export const searchProviderSelections = Object.freeze([
  "auto",
  "all",
  ...searchProviderFamilies,
] as const);

export type SearchProviderFamily = (typeof searchProviderFamilies)[number];
export type SearchProviderName = (typeof searchProviderSelections)[number];
export type SearchProviderSelection = SearchProviderName | SearchProviderFamily[];
export type SearchAction = "search" | "image" | "open" | "click" | "find";
export type SearchErrorKind =
  | "auth"
  | "config"
  | "invalid-request"
  | "transient"
  | "quota"
  | "network"
  | "invalid-response"
  | "capability"
  | "stale-context"
  | "entitlement"
  | "conflict"
  | "deadline"
  | "cancelled";
export type SearchBilling = "subscription" | "api" | "free" | "unknown";
export type SearchCapability =
  | "url"
  | "lineno"
  | "numResults"
  | "recencyFilter"
  | "recencyDays"
  | "domainFilter"
  | "domainExclusions"
  | "includeContent"
  | "country"
  | "language"
  | "safesearch"
  | "offset"
  | "exaSearchType"
  | "answerMode"
  | "responseLength"
  | "searchContextSize";

const ProviderFamilySchema = Type.String({ enum: [...searchProviderFamilies] });
const ProviderNameSchema = Type.String({ enum: [...searchProviderSelections] });
const SearchActionSchema = Type.String({ enum: ["search", "image", "open", "click", "find"] });
const CapabilitySchema = Type.String({
  enum: [
    "url",
    "lineno",
    "numResults",
    "recencyFilter",
    "recencyDays",
    "domainFilter",
    "domainExclusions",
    "includeContent",
    "country",
    "language",
    "safesearch",
    "offset",
    "exaSearchType",
    "answerMode",
    "responseLength",
    "searchContextSize",
  ],
});

export function searchProviderSchema(description?: string) {
  return Type.Union(
    [ProviderNameSchema, Type.Array(ProviderFamilySchema, { minItems: 1, uniqueItems: true })],
    description ? { description } : {},
  );
}

const ReferenceInputSchema = Type.Object(
  { id: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const canonicalSearchParams = Type.Object(
  {
    query: Type.Optional(Type.String({ minLength: 1 })),
    queries: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 20 }),
    ),
    action: Type.Optional(SearchActionSchema),
    imageQuery: Type.Optional(Type.String({ minLength: 1 })),
    url: Type.Optional(Type.String({ minLength: 1 })),
    lineno: Type.Optional(Type.Integer({ minimum: 0 })),
    open: Type.Optional(Type.Boolean()),
    click: Type.Optional(
      Type.Object({ id: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
    ),
    find: Type.Optional(
      Type.Object({ pattern: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    ),
    reference: Type.Optional(ReferenceInputSchema),
    responseLength: Type.Optional(Type.String({ enum: ["short", "medium", "long"] })),
    numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    recencyFilter: Type.Optional(Type.String({ enum: ["day", "week", "month", "year"] })),
    recencyDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
    domainFilter: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 100 }),
    ),
    includeContent: Type.Optional(Type.Boolean()),
    country: Type.Optional(Type.String({ minLength: 2, maxLength: 2 })),
    language: Type.Optional(Type.String({ minLength: 2, maxLength: 35 })),
    safesearch: Type.Optional(Type.String({ enum: ["off", "moderate", "strict"] })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    exaSearchType: Type.Optional(
      Type.String({ enum: ["auto", "fast", "instant", "deep-lite", "deep", "deep-reasoning"] }),
    ),
    answerMode: Type.Optional(Type.String({ enum: ["answer", "results", "both"] })),
    searchContextSize: Type.Optional(Type.String({ enum: ["low", "medium", "high"] })),
    provider: Type.Optional(searchProviderSchema()),
    requiredCapabilities: Type.Optional(Type.Array(CapabilitySchema, { uniqueItems: true })),
  },
  { additionalProperties: false },
);

export interface SearchRequest {
  query?: string;
  queries?: string[];
  action?: SearchAction;
  imageQuery?: string;
  url?: string;
  lineno?: number;
  open?: boolean;
  click?: { id: number };
  find?: { pattern: string };
  reference?: { id: string };
  responseLength?: "short" | "medium" | "long";
  numResults?: number;
  recencyFilter?: "day" | "week" | "month" | "year";
  recencyDays?: number;
  domainFilter?: string[];
  includeContent?: boolean;
  country?: string;
  language?: string;
  safesearch?: "off" | "moderate" | "strict";
  offset?: number;
  exaSearchType?: "auto" | "fast" | "instant" | "deep-lite" | "deep" | "deep-reasoning";
  answerMode?: "answer" | "results" | "both";
  searchContextSize?: "low" | "medium" | "high";
  provider?: SearchProviderSelection;
  requiredCapabilities?: SearchCapability[];
}

type ReadonlySessionManager = ExtensionContext["sessionManager"];
export interface SearchBindingContext {
  sessionManager: ReadonlySessionManager;
}

export interface SearchCapabilities {
  actions: readonly SearchAction[];
  constraints?: Partial<Record<SearchCapability, boolean>>;
}

export interface SearchAvailability {
  status: "available" | "unavailable" | "disabled" | "error";
  reason?: string;
  transport?: string;
  billing?: SearchBilling;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchInlineContent {
  url: string;
  title: string;
  content: string;
  error: string | null;
  thumbnail?: { data: string; mimeType: string };
  mimeType?: string;
  status?: number;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface SearchNativeReference {
  id: string;
  kind: string;
  native?: JsonValue;
}

export interface SearchAdapterResponse {
  answer: string;
  results: SearchResult[];
  inlineContent?: SearchInlineContent[];
  warnings?: string[];
  native?: JsonValue;
  references?: SearchNativeReference[];
}

export interface SearchReference {
  id: string;
  kind: string;
  adapterId: string;
  transport: string;
}

export interface SearchAttemptDiagnostic {
  adapterId: string;
  family: SearchProviderFamily;
  transport: string;
  outcome: "success" | "unavailable" | "disabled" | "incompatible" | "error";
  errorKind?: SearchErrorKind;
  reason?: string;
}

export interface SearchResponse extends SearchAdapterResponse {
  provider: SearchProviderFamily | "all";
  adapterId: string | "all";
  transport: string | "multiple";
  billing?: SearchBilling;
  attempts: SearchAttemptDiagnostic[];
  references?: SearchReference[];
  providerResponses?: SearchResponse[];
  providerErrors?: Array<{ provider: SearchProviderFamily; error: string; kind: SearchErrorKind }>;
}

interface StoredReference {
  publicReference: SearchReference;
  nativeReference: SearchNativeReference;
}

export class SearchSession {
  readonly id: string;
  readonly generation: number;
  readonly manager: ReadonlySessionManager;
  readonly signal: AbortSignal;
  readonly #controller: AbortController;
  readonly #references = new Map<string, StoredReference>();
  #active = true;

  constructor(id: string, generation: number, manager: ReadonlySessionManager) {
    this.id = id;
    this.generation = generation;
    this.manager = manager;
    this.#controller = new AbortController();
    this.signal = this.#controller.signal;
    sharedSearchDirectory.brandSession(this);
  }

  get active(): boolean {
    return this.#active;
  }

  invalidate(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#references.clear();
    this.#controller.abort(new Error("Search session invalidated"));
  }

  storeReference(reference: StoredReference): void {
    this.#references.set(reference.publicReference.id, reference);
  }

  getReference(id: string): StoredReference | undefined {
    return this.#references.get(id);
  }
}

export class SearchScope {
  canonical = false;
  canonicalRequested = false;
  canonicalRegistered = false;
  generation = 0;
  sequence = 0;
  readonly adapters = new Map<string, SearchAdapter>();
  session: SearchSession | undefined;

  constructor() {
    sharedSearchDirectory.brandScope(this);
  }
}

export interface SearchAdapterContext {
  context?: ExtensionContext;
  session: SearchSession;
  generation: number;
  signal: AbortSignal;
  reference?: SearchNativeReference;
}

export interface SearchAdapter {
  id: string;
  family: SearchProviderFamily;
  transport: string;
  priority?: number;
  billing?: SearchBilling;
  capabilities: SearchCapabilities;
  availability(context: SearchAdapterContext): SearchAvailability | Promise<SearchAvailability>;
  execute(request: SearchRequest, context: SearchAdapterContext): Promise<SearchAdapterResponse>;
}

export interface SearchRouting {
  providers: SearchProviderFamily[];
  fallbackOn?: SearchErrorKind[];
}

export interface SearchOptions {
  scope?: SearchScope;
  context?: ExtensionContext;
  session?: SearchSession;
  routing?: SearchRouting;
  fallbackOn?: SearchErrorKind[];
  allowBilledApiFallback?: boolean;
  totalDeadlineMs?: number;
  attemptDeadlineMs?: number;
  signal?: AbortSignal;
}

export interface SearchErrorOptions {
  family?: SearchProviderFamily;
  adapterId?: string;
  transport?: string;
  billing?: SearchBilling;
  status?: number;
  retryable?: boolean;
  deadlineKind?: "total" | "attempt";
  attempts?: readonly SearchAttemptDiagnostic[];
  cause?: unknown;
}

export class SearchError extends Error {
  readonly kind: SearchErrorKind;
  readonly family?: SearchProviderFamily;
  readonly adapterId?: string;
  readonly transport?: string;
  readonly billing?: SearchBilling;
  readonly status?: number;
  readonly retryable?: boolean;
  readonly deadlineKind?: "total" | "attempt";
  readonly attempts?: readonly SearchAttemptDiagnostic[];

  constructor(kind: SearchErrorKind, message: string, options: SearchErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "SearchError";
    this.kind = kind;
    sharedSearchDirectory.brandError(this);
    if (options.family !== undefined) this.family = options.family;
    if (options.adapterId !== undefined) this.adapterId = options.adapterId;
    if (options.transport !== undefined) this.transport = options.transport;
    if (options.billing !== undefined) this.billing = options.billing;
    if (options.status !== undefined) this.status = options.status;
    if (options.retryable !== undefined) this.retryable = options.retryable;
    if (options.deadlineKind !== undefined) this.deadlineKind = options.deadlineKind;
    if (options.attempts !== undefined) {
      this.attempts = Object.freeze(
        options.attempts.map((attempt) => Object.freeze({ ...attempt })),
      );
    }
  }
}

class SearchRouteMiss extends SearchError {
  constructor(family: SearchProviderFamily, message: string) {
    super("capability", message, { family });
  }
}

const SHARED_DIRECTORY_VERSION = 1 as const;
const ProcessObjectSchema = Type.Object({}, { additionalProperties: true });
type ProcessObject = Static<typeof ProcessObjectSchema>;
const SharedSearchDirectorySchema = Type.Object(
  {
    version: Type.Literal(SHARED_DIRECTORY_VERSION),
    getScopeByEvents: Type.Function(
      [ProcessObjectSchema],
      Type.Union([ProcessObjectSchema, Type.Undefined()]),
    ),
    setScopeByEvents: Type.Function([ProcessObjectSchema, ProcessObjectSchema], Type.Void()),
    getScopeByManager: Type.Function(
      [ProcessObjectSchema],
      Type.Union([ProcessObjectSchema, Type.Undefined()]),
    ),
    setScopeByManager: Type.Function([ProcessObjectSchema, ProcessObjectSchema], Type.Void()),
    deleteScopeByManager: Type.Function([ProcessObjectSchema], Type.Void()),
    brandScope: Type.Function([ProcessObjectSchema], Type.Void()),
    brandSession: Type.Function([ProcessObjectSchema], Type.Void()),
    brandError: Type.Function([ProcessObjectSchema], Type.Void()),
    isScope: Type.Function([ProcessObjectSchema], Type.Boolean()),
    isSession: Type.Function([ProcessObjectSchema], Type.Boolean()),
    isError: Type.Function([ProcessObjectSchema], Type.Boolean()),
  },
  { additionalProperties: false },
);
type SharedSearchDirectory = Static<typeof SharedSearchDirectorySchema>;

declare global {
  var __chocoPiWebSearchDirectoryV1: unknown;
}

function getSharedSearchDirectory(): SharedSearchDirectory {
  const current: unknown = Object.getOwnPropertyDescriptor(
    globalThis,
    "__chocoPiWebSearchDirectoryV1",
  )?.value;
  if (current !== undefined) {
    if (!Check(SharedSearchDirectorySchema, current)) {
      throw new Error("Invalid choco-pi web-search shared directory");
    }
    return current;
  }
  const scopesByEvents = new WeakMap<ProcessObject, ProcessObject>();
  const scopesByManagers = new WeakMap<ProcessObject, ProcessObject>();
  const scopeBrands = new WeakSet<ProcessObject>();
  const sessionBrands = new WeakSet<ProcessObject>();
  const errorBrands = new WeakSet<ProcessObject>();
  const created: SharedSearchDirectory = Object.freeze({
    version: SHARED_DIRECTORY_VERSION,
    getScopeByEvents: (owner) => scopesByEvents.get(owner),
    setScopeByEvents: (owner, scope) => {
      scopesByEvents.set(owner, scope);
    },
    getScopeByManager: (owner) => scopesByManagers.get(owner),
    setScopeByManager: (owner, scope) => {
      scopesByManagers.set(owner, scope);
    },
    deleteScopeByManager: (owner) => {
      scopesByManagers.delete(owner);
    },
    brandScope: (scope) => {
      scopeBrands.add(scope);
    },
    brandSession: (session) => {
      sessionBrands.add(session);
    },
    brandError: (error) => {
      errorBrands.add(error);
    },
    isScope: (scope) => scopeBrands.has(scope),
    isSession: (session) => sessionBrands.has(session),
    isError: (error) => errorBrands.has(error),
  });
  Object.defineProperty(globalThis, "__chocoPiWebSearchDirectoryV1", {
    value: created,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return created;
}

const sharedSearchDirectory = getSharedSearchDirectory();
const SharedSearchErrorSchema = Type.Object(
  {
    name: Type.Literal("SearchError"),
    message: Type.String(),
    kind: Type.String({
      enum: [
        "auth",
        "config",
        "invalid-request",
        "transient",
        "quota",
        "network",
        "invalid-response",
        "capability",
        "stale-context",
        "entitlement",
        "conflict",
        "deadline",
        "cancelled",
      ],
    }),
    family: Type.Optional(ProviderFamilySchema),
    adapterId: Type.Optional(Type.String()),
    transport: Type.Optional(Type.String()),
    billing: Type.Optional(Type.String({ enum: ["subscription", "api", "free", "unknown"] })),
    status: Type.Optional(Type.Integer()),
    retryable: Type.Optional(Type.Boolean()),
    deadlineKind: Type.Optional(Type.String({ enum: ["total", "attempt"] })),
    attempts: Type.Optional(
      Type.Array(
        Type.Object(
          {
            adapterId: Type.String(),
            family: ProviderFamilySchema,
            transport: Type.String(),
            outcome: Type.String({
              enum: ["success", "unavailable", "disabled", "incompatible", "error"],
            }),
            errorKind: Type.Optional(
              Type.String({
                enum: [
                  "auth",
                  "config",
                  "invalid-request",
                  "transient",
                  "quota",
                  "network",
                  "invalid-response",
                  "capability",
                  "stale-context",
                  "entitlement",
                  "conflict",
                  "deadline",
                  "cancelled",
                ],
              }),
            ),
            reason: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: true },
);

function isSearchScope(value: ProcessObject | undefined): value is SearchScope {
  return value !== undefined && sharedSearchDirectory.isScope(value);
}

function isSearchSession(value: ProcessObject | undefined): value is SearchSession {
  return value !== undefined && sharedSearchDirectory.isSession(value);
}

export function isSearchError<Value>(value: Value): value is Value & SearchError {
  return (
    Check(ProcessObjectSchema, value) &&
    sharedSearchDirectory.isError(value) &&
    Check(SharedSearchErrorSchema, value)
  );
}

const SCOPE_RENDEZVOUS_CHANNEL = "choco-pi-web-search:scope-rendezvous:v1";
const ScopeRendezvousSchema = Type.Object({
  kind: Type.Literal("choco-pi-web-search-scope-request"),
  accept: Type.Function([Type.Unknown()], Type.Undefined()),
});
const AvailabilitySchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("available"),
      Type.Literal("unavailable"),
      Type.Literal("disabled"),
      Type.Literal("error"),
    ]),
    reason: Type.Optional(Type.String()),
    transport: Type.Optional(Type.String({ minLength: 1 })),
    billing: Type.Optional(
      Type.Union([
        Type.Literal("subscription"),
        Type.Literal("api"),
        Type.Literal("free"),
        Type.Literal("unknown"),
      ]),
    ),
  },
  { additionalProperties: false },
);
const SearchResultSchema = Type.Object(
  { title: Type.String(), url: Type.String(), snippet: Type.String() },
  { additionalProperties: false },
);
const InlineContentSchema = Type.Object(
  {
    url: Type.String(),
    title: Type.String(),
    content: Type.String(),
    error: Type.Union([Type.String(), Type.Null()]),
    thumbnail: Type.Optional(
      Type.Object(
        { data: Type.String(), mimeType: Type.String() },
        { additionalProperties: false },
      ),
    ),
    mimeType: Type.Optional(Type.String()),
    status: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);
const JsonValueSchema = Cyclic(
  {
    JsonValue: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Ref("JsonValue")),
      Type.Record(Type.String(), Ref("JsonValue")),
    ]),
  },
  "JsonValue",
);
const NativeReferenceSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    kind: Type.String({ minLength: 1 }),
    native: Type.Optional(JsonValueSchema),
  },
  { additionalProperties: false },
);
const AdapterResponseSchema = Type.Object(
  {
    answer: Type.String(),
    results: Type.Array(SearchResultSchema),
    inlineContent: Type.Optional(Type.Array(InlineContentSchema)),
    warnings: Type.Optional(Type.Array(Type.String())),
    native: Type.Optional(JsonValueSchema),
    references: Type.Optional(Type.Array(NativeReferenceSchema)),
  },
  { additionalProperties: false },
);

export function createSearchScope(): SearchScope {
  return new SearchScope();
}

export function getSearchScope(events: EventBus): SearchScope {
  const existing = sharedSearchDirectory.getScopeByEvents(events);
  if (isSearchScope(existing)) return existing;
  let shared: SearchScope | undefined;
  const request: Static<typeof ScopeRendezvousSchema> = {
    kind: "choco-pi-web-search-scope-request",
    accept(candidate) {
      if (Check(ProcessObjectSchema, candidate) && isSearchScope(candidate)) shared = candidate;
    },
  };
  events.emit(SCOPE_RENDEZVOUS_CHANNEL, request);
  if (shared) {
    sharedSearchDirectory.setScopeByEvents(events, shared);
    return shared;
  }
  const scope = createSearchScope();
  events.on(SCOPE_RENDEZVOUS_CHANNEL, (data) => {
    if (Check(ScopeRendezvousSchema, data)) data.accept(scope);
  });
  sharedSearchDirectory.setScopeByEvents(events, scope);
  return scope;
}

export function markCanonicalSearch(scope: SearchScope): void {
  scope.canonicalRequested = true;
  scope.canonicalRegistered = true;
  scope.canonical = true;
}

function updateCanonicalSearch(scope: SearchScope): void {
  scope.canonical = scope.canonicalRequested && scope.canonicalRegistered;
}

export function requestCanonicalSearchIntegration(scope: SearchScope): void {
  scope.canonicalRequested = true;
  updateCanonicalSearch(scope);
}

export function confirmCanonicalSearchRegistration(scope: SearchScope): void {
  scope.canonicalRegistered = true;
  updateCanonicalSearch(scope);
}

type CanonicalTarget = SearchScope | EventBus | SearchBindingContext;

export function hasCanonicalSearch(target: CanonicalTarget): boolean {
  if (isSearchScope(target)) return target.canonical;
  if ("sessionManager" in target) return resolveSearchScope(target)?.canonical ?? false;
  return getSearchScope(target).canonical;
}

export function bindSearchSession(
  scope: SearchScope,
  sessionManager: ReadonlySessionManager,
): SearchSession {
  const previousSession = scope.session;
  if (isSearchSession(previousSession)) {
    previousSession.invalidate();
    if (sharedSearchDirectory.getScopeByManager(previousSession.manager) === scope) {
      sharedSearchDirectory.deleteScopeByManager(previousSession.manager);
    }
  }
  const previousScope = sharedSearchDirectory.getScopeByManager(sessionManager);
  if (isSearchScope(previousScope) && previousScope !== scope) {
    invalidateSearchSession(previousScope, sessionManager);
  }
  scope.generation += 1;
  scope.sequence += 1;
  const hostSessionId = sessionManager.getSessionId();
  const session = new SearchSession(
    `${encodeURIComponent(hostSessionId)}:${randomUUID()}`,
    scope.generation,
    sessionManager,
  );
  scope.session = session;
  sharedSearchDirectory.setScopeByManager(sessionManager, scope);
  return session;
}

export function invalidateSearchSession(
  scope: SearchScope,
  sessionManager?: ReadonlySessionManager,
): void {
  const session = scope.session;
  if (!isSearchSession(session) || (sessionManager && session.manager !== sessionManager)) return;
  session.invalidate();
  if (sharedSearchDirectory.getScopeByManager(session.manager) === scope) {
    sharedSearchDirectory.deleteScopeByManager(session.manager);
  }
  scope.session = undefined;
  scope.generation += 1;
}

export function resolveSearchScope(context: SearchBindingContext): SearchScope | undefined {
  const scope = sharedSearchDirectory.getScopeByManager(context.sessionManager);
  return isSearchScope(scope) ? scope : undefined;
}

export function resolveSearchSession(context: SearchBindingContext): SearchSession | undefined {
  const session = resolveSearchScope(context)?.session;
  return isSearchSession(session) ? session : undefined;
}

export function registerSearchAdapter(scope: SearchScope, adapter: SearchAdapter): () => void {
  if (!adapter.id.trim() || !adapter.transport.trim()) {
    throw new SearchError("config", "Search adapter id and transport must be non-empty");
  }
  if (scope.adapters.has(adapter.id)) {
    throw new SearchError("conflict", `Search adapter id is already registered: ${adapter.id}`, {
      family: adapter.family,
      adapterId: adapter.id,
    });
  }
  scope.adapters.set(adapter.id, adapter);
  return () => {
    if (scope.adapters.get(adapter.id) === adapter) scope.adapters.delete(adapter.id);
  };
}

interface SearchInvocation {
  scope: SearchScope;
  session: SearchSession;
  context: ExtensionContext | undefined;
}

function resolveInvocation(options: SearchOptions): SearchInvocation {
  const contextScope = options.context ? resolveSearchScope(options.context) : undefined;
  const sessionScope =
    !options.scope && !options.context && isSearchSession(options.session)
      ? resolveSearchScope({ sessionManager: options.session.manager })
      : undefined;
  const scope = options.scope ?? contextScope ?? sessionScope;
  const session =
    options.session ?? (options.context ? resolveSearchSession(options.context) : scope?.session);
  if (
    !isSearchScope(scope) ||
    !isSearchSession(session) ||
    scope.session !== session ||
    !session.active
  ) {
    throw new SearchError("stale-context", "Search requires a live bound session");
  }
  if (options.context && session.manager !== options.context.sessionManager) {
    throw new SearchError("stale-context", "Search context belongs to another session");
  }
  return { scope, session, context: options.context };
}

function assertCurrent(scope: SearchScope, session: SearchSession, generation: number): void {
  if (!session.active || scope.session !== session || scope.generation !== generation) {
    throw new SearchError("stale-context", "Search session changed while the request was running");
  }
}

function actionFor(request: SearchRequest): SearchAction {
  if (request.action) return request.action;
  if (request.imageQuery) return "image";
  if (request.open || request.url) return "open";
  if (request.click) return "click";
  if (request.find) return "find";
  return "search";
}

function validateRequest(request: SearchRequest): void {
  if (!Check(canonicalSearchParams, request)) {
    throw new SearchError("invalid-request", "Search request does not match canonicalSearchParams");
  }
  const action = actionFor(request);
  if (action === "search" && !request.query && !request.queries?.length) {
    throw new SearchError("invalid-request", "Search requires query or queries");
  }
  if (action === "image" && !request.imageQuery && !request.query) {
    throw new SearchError("invalid-request", "Image search requires imageQuery or query");
  }
  if (action === "open" && !request.url && !request.reference) {
    throw new SearchError("invalid-request", "open requires an http(s) URL or owned reference");
  }
  if ((action === "click" || action === "find") && !request.reference) {
    throw new SearchError("invalid-request", `${action} requires an owned reference`);
  }
  if (request.url) {
    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch (cause) {
      throw new SearchError("invalid-request", "url must be a valid absolute http(s) URL", {
        cause,
      });
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password
    ) {
      throw new SearchError(
        "invalid-request",
        "url must be an http(s) URL without embedded credentials",
      );
    }
  }
  for (const domain of request.domainFilter ?? []) {
    if (!isValidDomain(domain)) {
      throw new SearchError(
        "invalid-request",
        `domainFilter contains an invalid domain: ${domain}`,
      );
    }
  }
  if (request.lineno !== undefined && action !== "open") {
    throw new SearchError("invalid-request", "lineno is only valid for open");
  }
}

function isValidDomain(domain: string): boolean {
  const bareDomain = domain.startsWith("-") ? domain.slice(1) : domain;
  if (bareDomain.length > 253 || bareDomain.endsWith(".")) return false;
  const labels = bareDomain.split(".");
  if (labels.length < 2) return false;
  return labels.every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
  );
}

function requiredCapabilities(request: SearchRequest): SearchCapability[] {
  const required = new Set(request.requiredCapabilities ?? []);
  if (request.url) required.add("url");
  if (request.lineno !== undefined) required.add("lineno");
  if (request.recencyFilter) required.add("recencyFilter");
  if (request.recencyDays !== undefined) required.add("recencyDays");
  if (request.domainFilter) required.add("domainFilter");
  if (request.domainFilter?.some((domain) => domain.startsWith("-"))) {
    required.add("domainExclusions");
  }
  if (request.includeContent) required.add("includeContent");
  if (request.country) required.add("country");
  if (request.language) required.add("language");
  if (request.safesearch) required.add("safesearch");
  if (request.offset !== undefined) required.add("offset");
  if (request.exaSearchType) required.add("exaSearchType");
  if (request.answerMode) required.add("answerMode");
  if (request.responseLength) required.add("responseLength");
  if (request.searchContextSize) required.add("searchContextSize");
  return [...required];
}

function incompatibility(adapter: SearchAdapter, request: SearchRequest): string | undefined {
  const action = actionFor(request);
  if (!adapter.capabilities.actions.includes(action)) return `action ${action} is unsupported`;
  for (const capability of requiredCapabilities(request)) {
    if (adapter.capabilities.constraints?.[capability] !== true)
      return `${capability} is unsupported`;
  }
  return undefined;
}

function normalizeError(cause: unknown, adapter?: SearchAdapter): SearchError {
  if (isSearchError(cause)) return cause;
  const options: SearchErrorOptions = { cause };
  if (adapter) {
    options.family = adapter.family;
    options.adapterId = adapter.id;
  }
  if (cause instanceof DOMException && cause.name === "AbortError") {
    return new SearchError("cancelled", "Search was cancelled", options);
  }
  return new SearchError(
    "invalid-response",
    cause instanceof Error ? cause.message : "Search adapter failed",
    options,
  );
}

function errorWithAttempts(
  error: SearchError,
  attempts: readonly SearchAttemptDiagnostic[],
): SearchError {
  const options: SearchErrorOptions = {
    attempts: [...(error.attempts ?? []), ...attempts],
  };
  if (error.family !== undefined) options.family = error.family;
  if (error.adapterId !== undefined) options.adapterId = error.adapterId;
  if (error.transport !== undefined) options.transport = error.transport;
  if (error.billing !== undefined) options.billing = error.billing;
  if (error.status !== undefined) options.status = error.status;
  if (error.retryable !== undefined) options.retryable = error.retryable;
  if (error.deadlineKind !== undefined) options.deadlineKind = error.deadlineKind;
  if (error.cause !== undefined) options.cause = error.cause;
  return new SearchError(error.kind, error.message, options);
}

interface SearchPlan {
  families: SearchProviderFamily[];
  fanout: boolean;
  explicit: boolean;
}

function createSearchPlan(request: SearchRequest, options: SearchOptions): SearchPlan {
  if (request.provider === undefined || request.provider === "auto") {
    if (!options.routing) {
      return { families: [...defaultSearchFamilyOrder], fanout: false, explicit: false };
    }
    if (options.routing.providers.length === 0) {
      throw new SearchError("config", "search routing providers must be non-empty");
    }
    return { families: [...options.routing.providers], fanout: false, explicit: false };
  }
  if (request.provider === "all") {
    return { families: [...defaultSearchFamilyOrder], fanout: true, explicit: true };
  }
  if (Array.isArray(request.provider)) {
    if (request.provider.length === 0)
      throw new SearchError("config", "provider list must be non-empty");
    return { families: [...request.provider], fanout: true, explicit: true };
  }
  return { families: [request.provider], fanout: false, explicit: true };
}

function candidates(
  scope: SearchScope,
  families: readonly SearchProviderFamily[],
): SearchAdapter[] {
  const familyIndex = new Map(families.map((family, index) => [family, index]));
  return [...scope.adapters.values()]
    .filter((adapter) => familyIndex.has(adapter.family))
    .sort((left, right) => {
      const familyOrder =
        (familyIndex.get(left.family) ?? 0) - (familyIndex.get(right.family) ?? 0);
      if (familyOrder !== 0) return familyOrder;
      const priority = (left.priority ?? 100) - (right.priority ?? 100);
      return priority !== 0 ? priority : left.id.localeCompare(right.id);
    });
}

interface AttemptSignal {
  signal: AbortSignal;
  cleanup(): void;
  deadlineKind(): "total" | "attempt" | undefined;
}

function interruptionError(
  attempt: AttemptSignal,
  adapter: SearchAdapter,
  cause?: unknown,
): SearchError {
  const deadlineKind = attempt.deadlineKind();
  const options: SearchErrorOptions = {
    family: adapter.family,
    adapterId: adapter.id,
  };
  if (cause !== undefined) options.cause = cause;
  if (deadlineKind) {
    options.deadlineKind = deadlineKind;
    return new SearchError("deadline", `Search ${deadlineKind} deadline exceeded`, options);
  }
  return new SearchError("cancelled", "Search was cancelled", options);
}

function awaitWithAbort<Value>(
  operation: PromiseLike<Value> | Value,
  attempt: AttemptSignal,
  adapter: SearchAdapter,
): Promise<Value> {
  const promise = Promise.resolve(operation);
  if (attempt.signal.aborted) {
    promise.then(
      () => undefined,
      () => undefined,
    );
    return Promise.reject(interruptionError(attempt, adapter));
  }
  return new Promise<Value>((resolve, reject) => {
    const onAbort = () => reject(interruptionError(attempt, adapter));
    attempt.signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        attempt.signal.removeEventListener("abort", onAbort);
        if (attempt.signal.aborted) reject(interruptionError(attempt, adapter));
        else resolve(value);
      },
      (cause: Error) => {
        attempt.signal.removeEventListener("abort", onAbort);
        if (attempt.signal.aborted) reject(interruptionError(attempt, adapter, cause));
        else reject(cause);
      },
    );
  });
}

function ensureNotInterrupted(attempt: AttemptSignal, adapter: SearchAdapter): void {
  if (attempt.signal.aborted) throw interruptionError(attempt, adapter);
}

function createAttemptSignal(
  session: SearchSession,
  options: SearchOptions,
  totalSignal: AbortSignal,
): AttemptSignal {
  const controller = new AbortController();
  let deadline: "total" | "attempt" | undefined;
  const listeners: Array<{ signal: AbortSignal; handler: () => void }> = [];
  const forward = (signal: AbortSignal, kind?: "total" | "attempt") => {
    const handler = () => {
      if (kind) deadline = kind;
      controller.abort(signal.reason);
    };
    if (signal.aborted) handler();
    else {
      signal.addEventListener("abort", handler, { once: true });
      listeners.push({ signal, handler });
    }
  };
  forward(session.signal);
  forward(totalSignal, "total");
  if (options.signal) forward(options.signal);
  const timeout = setTimeout(() => {
    deadline = "attempt";
    controller.abort(new Error("Search attempt deadline exceeded"));
  }, options.attemptDeadlineMs ?? 120_000);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      for (const listener of listeners)
        listener.signal.removeEventListener("abort", listener.handler);
    },
    deadlineKind: () => deadline,
  };
}

interface TotalSignal {
  signal: AbortSignal;
  cleanup(): void;
}

function makeTotalSignal(options: SearchOptions): TotalSignal {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Search total deadline exceeded")),
    options.totalDeadlineMs ?? 360_000,
  );
  return { signal: controller.signal, cleanup: () => clearTimeout(timeout) };
}

function ownedReference(
  session: SearchSession,
  request: SearchRequest,
): StoredReference | undefined {
  if (!request.reference) return undefined;
  const reference = session.getReference(request.reference.id);
  if (!reference) {
    throw new SearchError("stale-context", "Search reference does not belong to this live session");
  }
  return reference;
}

function constrainPlanToReferenceOwner(
  plan: SearchPlan,
  request: SearchRequest,
  invocation: SearchInvocation,
): SearchPlan {
  const reference = ownedReference(invocation.session, request);
  if (!reference) return plan;
  const owner = invocation.scope.adapters.get(reference.publicReference.adapterId);
  if (!owner || owner.transport !== reference.publicReference.transport) {
    throw new SearchError("stale-context", "Search reference transport is no longer registered", {
      adapterId: reference.publicReference.adapterId,
    });
  }
  if (!plan.families.includes(owner.family)) {
    throw new SearchError(
      "capability",
      `Search reference owner ${owner.family} is excluded by the selected provider routing`,
      { family: owner.family, adapterId: owner.id },
    );
  }
  return { families: [owner.family], fanout: false, explicit: plan.explicit };
}

function retryKinds(options: SearchOptions): ReadonlySet<SearchErrorKind> {
  return new Set(
    options.fallbackOn ??
      options.routing?.fallbackOn ?? [
        "transient",
        "network",
        "invalid-response",
        "capability",
        "deadline",
      ],
  );
}

function shouldFallback(error: SearchError, allowed: ReadonlySet<SearchErrorKind>): boolean {
  if (
    [
      "auth",
      "config",
      "invalid-request",
      "cancelled",
      "stale-context",
      "entitlement",
      "conflict",
    ].includes(error.kind)
  ) {
    return false;
  }
  if (error.kind === "deadline" && error.deadlineKind !== "attempt") return false;
  return error.retryable !== false && allowed.has(error.kind);
}

function responseFromAdapter(
  adapter: SearchAdapter,
  availability: SearchAvailability,
  raw: SearchAdapterResponse,
  session: SearchSession,
  attempts: SearchAttemptDiagnostic[],
): SearchResponse {
  if (!Check(AdapterResponseSchema, raw)) {
    throw new SearchError(
      "invalid-response",
      `Adapter ${adapter.id} returned an invalid response`,
      {
        family: adapter.family,
        adapterId: adapter.id,
      },
    );
  }
  attempts.push({
    adapterId: adapter.id,
    family: adapter.family,
    transport: availability.transport ?? adapter.transport,
    outcome: "success",
  });
  const references: SearchReference[] = [];
  for (const nativeReference of raw.references ?? []) {
    const id = `${session.id}:${adapter.id}:${nativeReference.id}`;
    const publicReference = {
      id,
      kind: nativeReference.kind,
      adapterId: adapter.id,
      transport: availability.transport ?? adapter.transport,
    };
    session.storeReference({ publicReference, nativeReference });
    references.push(publicReference);
  }
  const { references: _nativeReferences, ...legacyResponse } = raw;
  const response: SearchResponse = {
    ...legacyResponse,
    provider: adapter.family,
    adapterId: adapter.id,
    transport: availability.transport ?? adapter.transport,
    attempts,
  };
  if (references.length > 0) response.references = references;
  const billing = availability.billing ?? adapter.billing;
  if (billing !== undefined) response.billing = billing;
  return response;
}

function resolvedAdapterError(
  cause: unknown,
  adapter: SearchAdapter,
  availability: SearchAvailability | undefined,
): SearchError {
  const error = normalizeError(cause, adapter);
  const billing = availability?.billing ?? adapter.billing;
  const options: SearchErrorOptions = {
    family: error.family ?? adapter.family,
    adapterId: error.adapterId ?? adapter.id,
    transport: availability?.transport ?? adapter.transport,
    cause: error,
  };
  if (billing !== undefined) options.billing = billing;
  if (error.status !== undefined) options.status = error.status;
  if (error.retryable !== undefined) options.retryable = error.retryable;
  if (error.deadlineKind !== undefined) options.deadlineKind = error.deadlineKind;
  if (error.attempts !== undefined) options.attempts = error.attempts;
  return new SearchError(error.kind, error.message, options);
}

async function attemptAdapter(
  adapter: SearchAdapter,
  request: SearchRequest,
  invocation: ReturnType<typeof resolveInvocation>,
  options: SearchOptions,
  totalSignal: AbortSignal,
  attempts: SearchAttemptDiagnostic[],
  billingState: { attemptedSubscription: boolean },
): Promise<SearchResponse | undefined> {
  const { scope, session, context } = invocation;
  const generation = session.generation;
  const incompatible = incompatibility(adapter, request);
  if (incompatible) {
    attempts.push({
      adapterId: adapter.id,
      family: adapter.family,
      transport: adapter.transport,
      outcome: "incompatible",
      reason: incompatible,
    });
    return undefined;
  }
  const storedReference = ownedReference(session, request);
  if (storedReference && storedReference.publicReference.adapterId !== adapter.id) return undefined;
  if (storedReference && storedReference.publicReference.transport !== adapter.transport) {
    throw new SearchError("stale-context", "Search reference transport is no longer registered", {
      family: adapter.family,
      adapterId: adapter.id,
    });
  }
  const attemptSignal = createAttemptSignal(session, options, totalSignal);
  const adapterContext: SearchAdapterContext = {
    session,
    generation,
    signal: attemptSignal.signal,
  };
  if (context !== undefined) adapterContext.context = context;
  if (storedReference) adapterContext.reference = storedReference.nativeReference;
  let resolvedAvailability: SearchAvailability | undefined;
  try {
    ensureNotInterrupted(attemptSignal, adapter);
    const availability = await awaitWithAbort(
      adapter.availability(adapterContext),
      attemptSignal,
      adapter,
    );
    resolvedAvailability = availability;
    assertCurrent(scope, session, generation);
    if (!Check(AvailabilitySchema, availability)) {
      throw new SearchError(
        "invalid-response",
        `Adapter ${adapter.id} returned invalid availability`,
        { family: adapter.family, adapterId: adapter.id },
      );
    }
    if (availability.status !== "available") {
      if (availability.status === "error") {
        throw new SearchError(
          "config",
          availability.reason ?? `Adapter ${adapter.id} availability failed`,
          {
            family: adapter.family,
            adapterId: adapter.id,
          },
        );
      }
      const diagnostic: SearchAttemptDiagnostic = {
        adapterId: adapter.id,
        family: adapter.family,
        transport: availability.transport ?? adapter.transport,
        outcome: availability.status === "disabled" ? "disabled" : "unavailable",
      };
      if (availability.reason !== undefined) diagnostic.reason = availability.reason;
      attempts.push(diagnostic);
      return undefined;
    }
    const resolvedBilling = availability.billing ?? adapter.billing;
    if (
      billingState.attemptedSubscription &&
      !options.allowBilledApiFallback &&
      resolvedBilling === "api"
    ) {
      attempts.push({
        adapterId: adapter.id,
        family: adapter.family,
        transport: availability.transport ?? adapter.transport,
        outcome: "disabled",
        reason: "billed API fallback is disabled after a subscription attempt",
      });
      return undefined;
    }
    if (
      storedReference &&
      storedReference.publicReference.transport !== (availability.transport ?? adapter.transport)
    ) {
      throw new SearchError("stale-context", "Search reference transport no longer matches", {
        family: adapter.family,
        adapterId: adapter.id,
      });
    }
    ensureNotInterrupted(attemptSignal, adapter);
    if (resolvedBilling === "subscription") billingState.attemptedSubscription = true;
    const raw = await awaitWithAbort(
      adapter.execute(request, adapterContext),
      attemptSignal,
      adapter,
    );
    assertCurrent(scope, session, generation);
    const numResultsWarning =
      request.numResults !== undefined &&
      !request.requiredCapabilities?.includes("numResults") &&
      adapter.capabilities.constraints?.numResults !== true
        ? [`${adapter.id} treats numResults as a non-binding hint`]
        : [];
    return responseFromAdapter(
      adapter,
      availability,
      { ...raw, warnings: [...(raw.warnings ?? []), ...numResultsWarning] },
      session,
      attempts,
    );
  } catch (cause) {
    if (!session.active || scope.session !== session || scope.generation !== generation) {
      throw new SearchError(
        "stale-context",
        "Search session changed while the adapter was running",
        { family: adapter.family, adapterId: adapter.id, cause },
      );
    }
    throw resolvedAdapterError(cause, adapter, resolvedAvailability);
  } finally {
    attemptSignal.cleanup();
  }
}

async function searchFamily(
  family: SearchProviderFamily,
  request: SearchRequest,
  invocation: ReturnType<typeof resolveInvocation>,
  options: SearchOptions,
  totalSignal: AbortSignal,
  attempts: SearchAttemptDiagnostic[],
  billingState: { attemptedSubscription: boolean },
): Promise<SearchResponse> {
  const familyCandidates = candidates(invocation.scope, [family]);
  if (familyCandidates.length === 0)
    throw new SearchRouteMiss(family, `No ${family} search adapter is registered`);
  const allowed = retryKinds(options);
  let lastError: SearchError | undefined;
  for (const adapter of familyCandidates) {
    try {
      const response = await attemptAdapter(
        adapter,
        request,
        invocation,
        options,
        totalSignal,
        attempts,
        billingState,
      );
      assertCurrent(invocation.scope, invocation.session, invocation.session.generation);
      if (response) return response;
    } catch (cause) {
      const error = normalizeError(cause, adapter);
      attempts.push({
        adapterId: adapter.id,
        family,
        transport: error.transport ?? adapter.transport,
        outcome: "error",
        errorKind: error.kind,
        reason: error.message,
      });
      lastError = error;
      if (!shouldFallback(error, allowed)) throw error;
    }
  }
  if (lastError) throw lastError;
  throw new SearchRouteMiss(family, `No compatible available ${family} search transport`);
}

function combineResponses(
  responses: SearchResponse[],
  failures: Array<{ provider: SearchProviderFamily; error: string; kind: SearchErrorKind }>,
  attempts: SearchAttemptDiagnostic[],
): SearchResponse {
  const seen = new Set<string>();
  const results = responses
    .flatMap((response) => response.results)
    .filter((result) => {
      if (seen.has(result.url)) return false;
      seen.add(result.url);
      return true;
    });
  const response: SearchResponse = {
    answer: responses
      .map((response) => response.answer)
      .filter(Boolean)
      .join("\n\n"),
    results,
    inlineContent: responses.flatMap((response) => response.inlineContent ?? []),
    warnings: responses.flatMap((response) => response.warnings ?? []),
    references: responses.flatMap((response) => response.references ?? []),
    provider: "all",
    adapterId: "all",
    transport: "multiple",
    attempts,
    providerResponses: responses,
  };
  if (failures.length > 0) response.providerErrors = failures;
  return response;
}

export async function search(
  request: SearchRequest,
  options: SearchOptions = {},
): Promise<SearchResponse> {
  validateRequest(request);
  const invocation = resolveInvocation(options);
  const generation = invocation.session.generation;
  const attempts: SearchAttemptDiagnostic[] = [];
  const total = makeTotalSignal(options);
  try {
    const plan = constrainPlanToReferenceOwner(
      createSearchPlan(request, options),
      request,
      invocation,
    );
    const { families, fanout } = plan;
    if (fanout) {
      const responses: SearchResponse[] = [];
      const failures: Array<{
        provider: SearchProviderFamily;
        error: string;
        kind: SearchErrorKind;
      }> = [];
      for (const family of families) {
        try {
          responses.push(
            await searchFamily(family, request, invocation, options, total.signal, attempts, {
              attemptedSubscription: false,
            }),
          );
          assertCurrent(invocation.scope, invocation.session, generation);
        } catch (cause) {
          const error = normalizeError(cause);
          if (
            error.kind === "cancelled" ||
            error.kind === "stale-context" ||
            (error.kind === "deadline" && error.deadlineKind !== "attempt")
          )
            throw error;
          failures.push({ provider: family, error: error.message, kind: error.kind });
        }
      }
      if (responses.length === 0) {
        throw new SearchError(
          "config",
          `No selected search provider succeeded: ${failures.map((failure) => `${failure.provider}: ${failure.error}`).join("; ")}`,
        );
      }
      return combineResponses(responses, failures, attempts);
    }
    if (plan.explicit) {
      const family = families[0];
      if (!family) throw new SearchError("config", "provider selection must be non-empty");
      return await searchFamily(family, request, invocation, options, total.signal, attempts, {
        attemptedSubscription: false,
      });
    }
    const billingState = { attemptedSubscription: false };
    let substantiveError: SearchError | undefined;
    let routeMiss: SearchError | undefined;
    for (const family of families) {
      try {
        return await searchFamily(
          family,
          request,
          invocation,
          options,
          total.signal,
          attempts,
          billingState,
        );
      } catch (cause) {
        const error = normalizeError(cause);
        if (error instanceof SearchRouteMiss) {
          routeMiss = error;
          continue;
        }
        substantiveError ??= error;
        if (!shouldFallback(error, retryKinds(options))) throw error;
      }
    }
    throw (
      substantiveError ?? routeMiss ?? new SearchError("config", "No search adapter is available")
    );
  } catch (cause) {
    throw errorWithAttempts(normalizeError(cause), attempts);
  } finally {
    total.cleanup();
  }
}
