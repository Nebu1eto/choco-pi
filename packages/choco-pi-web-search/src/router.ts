import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  defaultSearchFamilyOrder,
  isValidSearchProviderFamily,
  type SearchAdapterResponse,
  type SearchAttemptDiagnostic,
  type SearchAvailability,
  type SearchErrorKind,
  type SearchErrorOptions,
  type SearchProviderFamily,
  type SearchReference,
  type SearchRequest,
  type SearchResponse,
  type SearchRouteTarget,
  type SearchRouting,
  type StoredReference,
} from "./contract.ts";
import {
  actionFor,
  combineResponses,
  incompatibility,
  isValidDomain,
  normalizeSearchRequest,
} from "./formatting.ts";
import { isAdapterResponse, isAvailability, isRuntimeSearchRequest } from "./schema.ts";
import {
  isSearchError,
  isSearchScope,
  isSearchSession,
  resolveSearchScope,
  resolveSearchSession,
  SearchError,
  SearchRouteMiss,
  type SearchAdapter,
  type SearchAdapterContext,
  type SearchScope,
  type SearchSession,
} from "./scope.ts";

export const DEFAULT_ATTEMPT_DEADLINE_MS = 25_000;
export const DEFAULT_TOTAL_DEADLINE_MS = 90_000;

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

function validateRequest(request: SearchRequest): void {
  if (!isRuntimeSearchRequest(request)) {
    throw new SearchError("invalid-request", "Search request does not match canonicalSearchParams");
  }
  const action = actionFor(request);
  if (action === "search" && !request.query && !request.queries?.length) {
    throw new SearchError("invalid-request", "Search requires query or queries");
  }
  if (action === "image" && !request.imageQuery && !request.query) {
    throw new SearchError("invalid-request", "Image search requires image_query or query");
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
        `domain_filter contains an invalid domain: ${domain}`,
      );
    }
  }
  if (request.lineno !== undefined && action !== "open") {
    throw new SearchError("invalid-request", "lineno is only valid for open");
  }
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
  targets?: readonly SearchRouteTarget[];
  fanout: boolean;
  explicit: boolean;
  implicit: boolean;
  configuredPriority: boolean;
}

function defaultFamiliesForScope(scope: SearchScope): SearchProviderFamily[] {
  const builtinSet = new Set<string>(defaultSearchFamilyOrder);
  const customFamilies = [
    ...new Set(
      [...scope.adapters.values()]
        .map((adapter) => adapter.family)
        .filter((family) => !builtinSet.has(family)),
    ),
  ].sort((left, right) => left.localeCompare(right));
  return [...defaultSearchFamilyOrder, ...customFamilies];
}

function createSearchPlan(
  request: SearchRequest,
  options: SearchOptions,
  scope: SearchScope,
): SearchPlan {
  if (request.provider === undefined || request.provider === "auto") {
    if (!options.routing) {
      return {
        families: defaultFamiliesForScope(scope),
        fanout: false,
        explicit: false,
        implicit: true,
        configuredPriority: false,
      };
    }
    const configuredPriority = options.routing.configuredPriority === true;
    if (options.routing.targets !== undefined) {
      if (options.routing.targets.length === 0) {
        throw new SearchError("config", "search routing providers must be non-empty");
      }
      for (const target of options.routing.targets) {
        if (!isValidSearchProviderFamily(target.family)) {
          throw new SearchError(
            "config",
            `Invalid search routing provider family: ${String(target.family)}`,
          );
        }
      }
      return {
        families: options.routing.targets.map((target) => target.family),
        targets: [...options.routing.targets],
        fanout: false,
        explicit: false,
        implicit: false,
        configuredPriority,
      };
    }
    if (options.routing.providers.length === 0) {
      throw new SearchError("config", "search routing providers must be non-empty");
    }
    for (const family of options.routing.providers) {
      if (!isValidSearchProviderFamily(family)) {
        throw new SearchError(
          "config",
          `Invalid search routing provider family: ${String(family)}`,
        );
      }
    }
    return {
      families: [...options.routing.providers],
      fanout: false,
      explicit: false,
      implicit: false,
      configuredPriority,
    };
  }
  if (request.provider === "all") {
    return {
      families: defaultFamiliesForScope(scope),
      fanout: true,
      explicit: true,
      implicit: true,
      configuredPriority: false,
    };
  }
  if (Array.isArray(request.provider)) {
    if (request.provider.length === 0)
      throw new SearchError("config", "provider list must be non-empty");
    return {
      families: [...request.provider],
      fanout: true,
      explicit: true,
      implicit: false,
      configuredPriority: false,
    };
  }
  return {
    families: [request.provider],
    fanout: false,
    explicit: true,
    implicit: false,
    configuredPriority: false,
  };
}

function candidates(
  scope: SearchScope,
  families: readonly SearchProviderFamily[],
  implicit = false,
): SearchAdapter[] {
  const familyIndex = new Map(families.map((family, index) => [family, index]));
  return [...scope.adapters.values()]
    .filter((adapter) => familyIndex.has(adapter.family) && !(implicit && adapter.explicitOnly))
    .sort((left, right) => {
      const familyOrder =
        (familyIndex.get(left.family) ?? 0) - (familyIndex.get(right.family) ?? 0);
      if (familyOrder !== 0) return familyOrder;
      const priority = (left.priority ?? 100) - (right.priority ?? 100);
      return priority === 0 ? left.id.localeCompare(right.id) : priority;
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
  }, options.attemptDeadlineMs ?? DEFAULT_ATTEMPT_DEADLINE_MS);
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
    options.totalDeadlineMs ?? DEFAULT_TOTAL_DEADLINE_MS,
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
  return {
    families: [owner.family],
    fanout: false,
    explicit: plan.explicit,
    implicit: false,
    configuredPriority: plan.configuredPriority,
  };
}

const DEFAULT_FALLBACK_KINDS: readonly SearchErrorKind[] = [
  "transient",
  "network",
  "invalid-response",
  "capability",
  "deadline",
];

const CONFIGURED_PRIORITY_FALLBACK_KINDS: readonly SearchErrorKind[] = [
  "transient",
  "network",
  "invalid-response",
  "capability",
  "deadline",
  "quota",
  "auth",
  "entitlement",
];

function retryKinds(
  options: SearchOptions,
  configuredPriority = false,
): ReadonlySet<SearchErrorKind> {
  const explicit = options.fallbackOn ?? options.routing?.fallbackOn;
  if (explicit !== undefined) return new Set(explicit);
  return new Set(configuredPriority ? CONFIGURED_PRIORITY_FALLBACK_KINDS : DEFAULT_FALLBACK_KINDS);
}

function shouldFallback(
  error: SearchError,
  allowed: ReadonlySet<SearchErrorKind>,
  configuredPriority = false,
): boolean {
  if (
    ["config", "invalid-request", "cancelled", "stale-context", "conflict"].includes(error.kind)
  ) {
    return false;
  }
  if (!configuredPriority && (error.kind === "auth" || error.kind === "entitlement")) {
    return false;
  }
  if (error.kind === "deadline" && error.deadlineKind !== "attempt") return false;
  if (
    configuredPriority &&
    (error.kind === "quota" || error.kind === "auth" || error.kind === "entitlement")
  ) {
    return allowed.has(error.kind);
  }
  return error.retryable !== false && allowed.has(error.kind);
}

function responseFromAdapter(
  adapter: SearchAdapter,
  availability: SearchAvailability,
  raw: SearchAdapterResponse,
  session: SearchSession,
  attempts: SearchAttemptDiagnostic[],
): SearchResponse {
  if (!isAdapterResponse(raw)) {
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
  invocation: SearchInvocation,
  options: SearchOptions,
  totalSignal: AbortSignal,
  attempts: SearchAttemptDiagnostic[],
  billingState: { attemptedSubscription: boolean },
  configuredPriority: boolean,
  target?: SearchRouteTarget,
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
  if (target?.model !== undefined) adapterContext.targetModel = target.model;
  if (target?.authProvider !== undefined) adapterContext.targetAuthProvider = target.authProvider;
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
    if (!isAvailability(availability)) {
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
      !configuredPriority &&
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
      adapter.execute(normalizeSearchRequest(request), adapterContext),
      attemptSignal,
      adapter,
    );
    assertCurrent(scope, session, generation);
    const numResultsWarning =
      request.numResults !== undefined &&
      !request.requiredCapabilities?.includes("numResults") &&
      adapter.capabilities.constraints?.numResults !== true
        ? [`${adapter.id} treats num_results as a non-binding hint`]
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

function implicitFamilies(
  scope: SearchScope,
  families: readonly SearchProviderFamily[],
  attempts: SearchAttemptDiagnostic[],
): SearchProviderFamily[] {
  const registered = [...scope.adapters.values()];
  for (const adapter of candidates(scope, families)) {
    if (!adapter.explicitOnly) continue;
    attempts.push({
      adapterId: adapter.id,
      family: adapter.family,
      transport: adapter.transport,
      outcome: "disabled",
      reason: "explicit selection only",
    });
  }
  return families.filter((family) => {
    const adapters = registered.filter((adapter) => adapter.family === family);
    return adapters.length === 0 || adapters.some((adapter) => !adapter.explicitOnly);
  });
}

async function searchFamily(
  family: SearchProviderFamily,
  request: SearchRequest,
  invocation: SearchInvocation,
  options: SearchOptions,
  totalSignal: AbortSignal,
  attempts: SearchAttemptDiagnostic[],
  billingState: { attemptedSubscription: boolean },
  implicit: boolean,
  configuredPriority: boolean,
  target?: SearchRouteTarget,
): Promise<SearchResponse> {
  const familyCandidates = candidates(invocation.scope, [family], implicit);
  if (familyCandidates.length === 0)
    throw new SearchRouteMiss(family, `No ${family} search adapter is registered`);
  const allowed = retryKinds(options, configuredPriority);
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
        configuredPriority,
        target,
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
      if (!shouldFallback(error, allowed, configuredPriority)) throw error;
    }
  }
  if (lastError) throw lastError;
  throw new SearchRouteMiss(family, `No compatible available ${family} search transport`);
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
      createSearchPlan(request, options, invocation.scope),
      request,
      invocation,
    );
    const { fanout, implicit } = plan;
    const { configuredPriority } = plan;
    const families = implicit
      ? implicitFamilies(invocation.scope, plan.families, attempts)
      : plan.families;
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
            await searchFamily(
              family,
              request,
              invocation,
              options,
              total.signal,
              attempts,
              { attemptedSubscription: false },
              implicit,
              false,
            ),
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
      return await searchFamily(
        family,
        request,
        invocation,
        options,
        total.signal,
        attempts,
        { attemptedSubscription: false },
        implicit,
        false,
      );
    }
    const billingState = { attemptedSubscription: false };
    let substantiveError: SearchError | undefined;
    let routeMiss: SearchError | undefined;
    const routeTargets: readonly SearchRouteTarget[] =
      plan.targets ?? families.map((family) => ({ family }));
    const allowed = retryKinds(options, configuredPriority);
    for (const target of routeTargets) {
      try {
        return await searchFamily(
          target.family,
          request,
          invocation,
          options,
          total.signal,
          attempts,
          billingState,
          implicit,
          configuredPriority,
          target,
        );
      } catch (cause) {
        const error = normalizeError(cause);
        if (error instanceof SearchRouteMiss) {
          routeMiss = error;
          continue;
        }
        substantiveError ??= error;
        if (!shouldFallback(error, allowed, configuredPriority)) throw error;
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
