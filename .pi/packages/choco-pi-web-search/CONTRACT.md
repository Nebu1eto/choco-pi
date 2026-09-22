# Unified search core contract

Import public values and types from `../choco-pi-web-search/index.ts`. The package imports no backend and registers no tool.

## Scope and lifecycle

- `getSearchScope(events): SearchScope` synchronously rendezvouses through the underlying loader event bus, then caches the loader-local scope by that extension's `pi.events` wrapper. A validated, versioned process directory holds only owner-keyed weak maps and shared object brands, so native and Jiti copies interoperate without sharing state between event buses or session managers. This accounts for Pi 0.86.1 creating a distinct wrapper per extension while forwarding all wrappers to one bus.
- `createSearchScope(): SearchScope` creates an isolated standalone scope.
- `requestCanonicalSearchIntegration(scope): void` records that the core requested canonical integration. `confirmCanonicalSearchRegistration(scope): void` records that the enabled frontend actually registered `web_search`. The canonical marker becomes visible only after both calls, in either order. `markCanonicalSearch(scope): void` remains the explicit manual/library activation API and satisfies both sides of the handshake. `hasCanonicalSearch(scope | events | context): boolean` reads the resulting per-scope state.
- `bindSearchSession(scope, sessionManager): SearchSession` synchronously invalidates the previous generation, aborts its work, removes the old manager binding, and binds the manager. Every bound generation receives a globally unique id containing the synchronously snapshotted host session id plus a UUID; identities cannot collide across main/subagent/standalone scopes.
- `invalidateSearchSession(scope, sessionManager?): void` synchronously aborts and invalidates matching work.
- `resolveSearchScope(context): SearchScope | undefined` and `resolveSearchSession(context): SearchSession | undefined` resolve bindings by `context.sessionManager` identity.
- Scope, session, and `SearchError` identity uses the shared brands rather than module-local constructors. Errors crossing native/Jiti loaders retain their typed kind and metadata, including auth/config hard-stop behavior. `isSearchError(value)` recognizes this shared identity across loaders without relying on `instanceof`.
- The extension handles SDK `session_start`, `session_tree`, and `session_shutdown`. Start/tree bind a fresh generation; shutdown invalidates. Main, subagent, loader, and standalone scopes do not share adapters or sessions.

## Adapters

`registerSearchAdapter(scope, adapter): () => void` registers a unique adapter id and returns an identity-safe unregister callback. Duplicate ids throw `SearchError(kind="conflict")`.

```ts
interface SearchAdapter {
  id: string; // e.g. codex.web_run, web-access.openai
  family: "openai" | "exa" | "kagi" | "synthetic" | "brave";
  transport: string;
  priority?: number; // lower first; codex should precede Responses
  billing?: "subscription" | "api" | "free" | "unknown";
  capabilities: SearchCapabilities;
  availability(context: SearchAdapterContext): SearchAvailability | Promise<SearchAvailability>;
  execute(request: SearchRequest, context: SearchAdapterContext): Promise<SearchAdapterResponse>;
}
```

Availability is `{ status: "available" | "unavailable" | "disabled" | "error", reason?, transport?, billing? }`. Adapters must not resolve credentials outside `availability`/`execute`; the router invokes those only for selected compatible candidates. `SearchAdapterContext` supplies the bound host context, session, generation, attempt `signal`, and an owned native reference for navigation.

`SearchAdapterResponse` is validated at runtime. It preserves legacy `answer`, `results`, and `inlineContent`, plus optional JSON `native` and native reference descriptors. The router attributes actual family/adapter/transport, warnings, and attempt diagnostics. It owns returned reference identity; adapters do not fabricate router ownership fields.

## Requests and routing

`search(request, options)` accepts `options.scope`, `options.context`, or `options.session` (exactly one effective bound session is required). Provider selection is `auto` (default), one family, `all`, or a non-empty family list. `request.provider: "all"` and request provider arrays are intentional fanout. `options.routing.providers` is an ordered sequential fallback list, including when request provider is absent or `auto`; it is never fanout. Empty routing/list configuration is a typed config error.

Default family order is OpenAI, Exa, Kagi, Synthetic, Brave; adapter `priority` orders transports within a family. Explicit OpenAI never crosses families. `all` and family lists intentionally fan out one successful transport per family. Auto skips unavailable/disabled adapters and incompatible capabilities. Explicit incompatible selection fails. Navigation accepts only a router-owned `reference`; raw backend ref ids are never routing authority.

`numResults` is a hint unless `requiredCapabilities` includes `numResults`; an adapter that cannot honor it adds a warning rather than being skipped. Other supplied filters/actions are hard constraints. In addition to the base fields, requests support `url` (absolute HTTP/HTTPS without credentials), zero-based `lineno`, arbitrary `recencyDays` from 1 through 3650, `searchContextSize` (`low | medium | high`), and Exa search types `auto | fast | instant | deep-lite | deep | deep-reasoning`. Their matching capability names are `url`, `lineno`, `recencyDays`, and `searchContextSize`. A URL open needs no prior reference but routes only to an adapter declaring URL support. Reference open, click, and find require router-owned identity. Domains are bare valid DNS names; URL/path/protocol values are rejected. A leading `-` denotes a validated excluded domain and additionally requires `domainExclusions`; adapters that support only positive filters must not claim it. Valid empty results succeed. Default fallback kinds are transient, network, invalid-response, capability, and attempt deadline. An explicit `fallbackOn` (directly or in routing) remains authoritative. Auth, config, invalid-request, cancellation, stale-context, entitlement, conflict, total deadline, and user cancellation never fall back. Quota falls back only when configured and adapter-retryable; `retryable: false` always stops. A failed subscription attempt cannot fall through to billed API transport unless `allowBilledApiFallback` is true; an initially available API-only connection is allowed.

Availability and execution are raced against cancellation and deadlines, so noncooperative adapters cannot delay settlement and their late values are ignored. The default attempt deadline is 120 seconds and the default total deadline is 360 seconds; explicit `SearchOptions` overrides are preserved. Native transports are therefore bounded by the router even if previously unbounded, while backends may enforce tighter limits of their own. Total deadlines, caller cancellation, and stale sessions never fall back. An attempt deadline may fall back when `deadline` is in the effective fallback policy and total budget remains. Session generation and interruption are checked after every adapter await. Navigation by `reference` requires the originating live session and exact adapter/transport and never falls back. Adapter response `references` contain backend-native ids and optional JSON payloads; the router stores the complete descriptor privately and returns separately generated canonical `SearchReference` ids. Callers must pass only the canonical id, and adapters recover the exact original id/kind/native descriptor from `SearchAdapterContext.reference`.

## UI schemas

- `canonicalSearchParams` is the complete TypeBox request schema. Action/provider and other public enum strings use JSON Schema `type: "string", enum: [...]`, not literal `anyOf` enums, for all Pi providers.
- `searchProviderSchema(description?)` returns the provider-selection schema used by the existing rich `web_search` registration.
- `searchProviderFamilies`, `searchProviderSelections`, and `defaultSearchFamilyOrder` are frozen values.

## Errors

`SearchError.kind` is one of `auth`, `config`, `invalid-request`, `transient`, `quota`, `network`, `invalid-response`, `capability`, `stale-context`, `entitlement`, `conflict`, `deadline`, or `cancelled`. It also carries optional family, adapter id, status, retryable metadata, and a readonly snapshot of accumulated attempt diagnostics without credentials. Older branded errors crossing loaders may omit `attempts`.
