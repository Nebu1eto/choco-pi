import { randomUUID } from "node:crypto";
import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  isValidSearchProviderFamily,
  type ReadonlySessionManager,
  type SearchAdapterResponse,
  type SearchAttemptDiagnostic,
  type SearchAvailability,
  type SearchBilling,
  type SearchBindingContext,
  type SearchCapabilities,
  type SearchErrorKind,
  type SearchErrorOptions,
  type SearchNativeReference,
  type SearchProviderFamily,
  type SearchRequest,
  type StoredReference,
} from "./contract.ts";
import { isObjectValue, isSharedSearchErrorSnapshot } from "./schema.ts";

const SHARED_DIRECTORY_VERSION = 1 as const;

/** Any non-array, non-function object shared across loaders of the same process. */
type ProcessObject = Record<never, never>;
/** Anything a host may hand to a shared-directory or rendezvous callback. */
type ProcessValue = {} | null | undefined;

function isProcessObject<Value>(value: Value): value is Value & ProcessObject {
  return isObjectValue(value);
}

/** True when `value` has a function-valued member `key` (functions are not JSON). */
function hasFunctionMember<Value extends ProcessObject, Key extends string>(
  value: Value,
  key: Key,
): value is Value & Record<Key, Function> {
  const member: ProcessValue = Object(value)[key];
  return member instanceof Function;
}

/** Reads member `key` (own or inherited, enumerable or not) without throwing for absent members. */
function memberOf<Owner extends ProcessObject>(owner: Owner, key: string): ProcessValue {
  return key in owner ? Object(owner)[key] : undefined;
}

interface SharedSearchDirectory {
  readonly version: typeof SHARED_DIRECTORY_VERSION;
  getScopeByEvents(owner: ProcessObject): ProcessObject | undefined;
  setScopeByEvents(owner: ProcessObject, scope: ProcessObject): void;
  getScopeByManager(owner: ProcessObject): ProcessObject | undefined;
  setScopeByManager(owner: ProcessObject, scope: ProcessObject): void;
  deleteScopeByManager(owner: ProcessObject): void;
  brandScope(scope: ProcessObject): void;
  brandSession(session: ProcessObject): void;
  brandError(error: ProcessObject): void;
  isScope(scope: ProcessObject): boolean;
  isSession(session: ProcessObject): boolean;
  isError(error: ProcessObject): boolean;
}

const SHARED_DIRECTORY_METHODS = [
  "getScopeByEvents",
  "setScopeByEvents",
  "getScopeByManager",
  "setScopeByManager",
  "deleteScopeByManager",
  "brandScope",
  "brandSession",
  "brandError",
  "isScope",
  "isSession",
  "isError",
] as const;

/** Closed object: `version` plus exactly the listed function members (functions are not JSON). */
function isSharedSearchDirectory<Value>(value: Value): value is Value & SharedSearchDirectory {
  if (!isProcessObject(value)) return false;
  if (Object.keys(value).length !== SHARED_DIRECTORY_METHODS.length + 1) return false;
  if (!("version" in value) || value.version !== SHARED_DIRECTORY_VERSION) return false;
  return SHARED_DIRECTORY_METHODS.every((method) => hasFunctionMember(value, method));
}

declare global {
  var __chocoPiWebSearchDirectoryV1: unknown;
}

function getSharedSearchDirectory(): SharedSearchDirectory {
  const current: unknown = Object.getOwnPropertyDescriptor(
    globalThis,
    "__chocoPiWebSearchDirectoryV1",
  )?.value;
  if (current !== undefined) {
    if (!isSharedSearchDirectory(current)) {
      throw new Error("Invalid choco-pi web-search shared directory");
    }
    return current;
  }
  const scopesByEvents = new WeakMap<ProcessObject, ProcessObject>();
  const scopesByManagers = new WeakMap<ProcessObject, ProcessObject>();
  const scopeBrands = new WeakSet<ProcessObject>();
  const sessionBrands = new WeakSet<ProcessObject>();
  const errorBrands = new WeakSet<ProcessObject>();
  const created: SharedSearchDirectory = Object.freeze<SharedSearchDirectory>({
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
  /** Never selected by `auto` default order or `all`; only when a caller names the family. */
  explicitOnly?: boolean;
  capabilities: SearchCapabilities;
  availability(context: SearchAdapterContext): SearchAvailability | Promise<SearchAvailability>;
  execute(request: SearchRequest, context: SearchAdapterContext): Promise<SearchAdapterResponse>;
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

export class SearchRouteMiss extends SearchError {
  constructor(family: SearchProviderFamily, message: string) {
    super("capability", message, { family });
  }
}

interface SearchErrorFields {
  readonly name: ProcessValue;
  readonly message: ProcessValue;
  readonly kind: ProcessValue;
  readonly family: ProcessValue;
  readonly adapterId: ProcessValue;
  readonly transport: ProcessValue;
  readonly billing: ProcessValue;
  readonly status: ProcessValue;
  readonly retryable: ProcessValue;
  readonly deadlineKind: ProcessValue;
  readonly attempts: ProcessValue;
}

/**
 * pi-schema reads only enumerable properties, so an Error's own non-enumerable `message` would look
 * missing. Snapshot the known fields by plain property reads and validate the snapshot.
 */
function hasSharedSearchErrorFields(value: ProcessObject): boolean {
  const snapshot: SearchErrorFields = {
    name: memberOf(value, "name"),
    message: memberOf(value, "message"),
    kind: memberOf(value, "kind"),
    family: memberOf(value, "family"),
    adapterId: memberOf(value, "adapterId"),
    transport: memberOf(value, "transport"),
    billing: memberOf(value, "billing"),
    status: memberOf(value, "status"),
    retryable: memberOf(value, "retryable"),
    deadlineKind: memberOf(value, "deadlineKind"),
    attempts: memberOf(value, "attempts"),
  };
  return isSharedSearchErrorSnapshot(snapshot);
}

export function isSearchScope(value: ProcessObject | undefined): value is SearchScope {
  return value !== undefined && sharedSearchDirectory.isScope(value);
}

export function isSearchSession(value: ProcessObject | undefined): value is SearchSession {
  return value !== undefined && sharedSearchDirectory.isSession(value);
}

export function isSearchError<Value>(value: Value): value is Value & SearchError {
  return (
    isProcessObject(value) &&
    sharedSearchDirectory.isError(value) &&
    hasSharedSearchErrorFields(value)
  );
}

const SCOPE_RENDEZVOUS_CHANNEL = "choco-pi-web-search:scope-rendezvous:v1";
interface ScopeRendezvous {
  readonly kind: "choco-pi-web-search-scope-request";
  accept(candidate: ProcessValue): void;
}

function isScopeRendezvous<Value>(value: Value): value is Value & ScopeRendezvous {
  return (
    isProcessObject(value) &&
    "kind" in value &&
    value.kind === "choco-pi-web-search-scope-request" &&
    hasFunctionMember(value, "accept")
  );
}

export function createSearchScope(): SearchScope {
  return new SearchScope();
}

export function getSearchScope(events: EventBus): SearchScope {
  const existing = sharedSearchDirectory.getScopeByEvents(events);
  if (isSearchScope(existing)) return existing;
  let shared: SearchScope | undefined;
  const request: ScopeRendezvous = {
    kind: "choco-pi-web-search-scope-request",
    accept(candidate) {
      if (isProcessObject(candidate) && isSearchScope(candidate)) shared = candidate;
    },
  };
  events.emit(SCOPE_RENDEZVOUS_CHANNEL, request);
  if (shared) {
    sharedSearchDirectory.setScopeByEvents(events, shared);
    return shared;
  }
  const scope = createSearchScope();
  events.on(SCOPE_RENDEZVOUS_CHANNEL, (data) => {
    if (isScopeRendezvous(data)) data.accept(scope);
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
  if (!isValidSearchProviderFamily(adapter.family)) {
    throw new SearchError(
      "config",
      `Search adapter family must be a non-empty lowercase identifier: ${String(adapter.family)}`,
      { adapterId: adapter.id },
    );
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
