/**
 * Hide access-program Anthropic models from accounts that cannot use them.
 *
 * Pi lists every catalog model once a provider has credentials. Claude Mythos
 * 5.1 and 5.2 are served only to accounts in Anthropic's access programs, so
 * this extension registers a native `anthropic` provider that delegates to the
 * current one and adds `filterModels`. Both the model picker and the
 * usage-limit fallback read `ModelRegistry.getAvailable()`, which applies that
 * filter. A gated model stays hidden until `GET /v1/models` for the current
 * credential lists it; a pending, failed, or credential-less check hides it.
 *
 * Pi keeps one native or one config registration per provider, and each
 * replaces the other. The wrapper delegates to the provider composed at
 * registration time, so earlier config overlays keep working, and it is
 * re-installed on session start, model selection, and agent start when a later
 * config registration displaced it. Wrappers that build on the registered
 * native provider (the Anthropic capture and the opaque guard) keep it, and
 * they use it as their prototype, which is how `ensure` recognizes it.
 */
import { createHash } from "node:crypto";
import type { Credential, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { arr, bool, compile, obj, opt, str } from "@earendil-works/pi-schema";
import { rethrowUnlessStaleContext } from "./lib/lifecycle.ts";

const PROVIDER = "anthropic";
/** Anthropic models served only to accounts in an access program. */
const GATED_MODEL_IDS: ReadonlySet<string> = new Set(["claude-mythos-5-1", "claude-mythos-5-2"]);
const MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";
const OAUTH_BETA = "oauth-2025-04-20";
const FETCH_TIMEOUT_MS = 10_000;
const RETRY_AFTER_MS = 60_000;
const MAX_PAGES = 10;

const modelsPage = compile(
  obj(
    {
      data: arr(obj({ id: str() }, { open: true })),
      has_more: opt(bool()),
    },
    { open: true },
  ),
);

type Entitlement =
  | { readonly state: "pending" }
  | { readonly state: "known"; readonly ids: ReadonlySet<string> }
  | { readonly state: "failed"; readonly at: number };

function credentialSecret(credential: Credential): string | undefined {
  return credential.type === "oauth" ? credential.access : credential.key;
}

/** In-memory cache key; the credential itself is never stored. */
function credentialKey(credential: Credential | undefined): string | undefined {
  if (credential === undefined) return undefined;
  const secret = credentialSecret(credential);
  if (!secret) return undefined;
  return createHash("sha256").update(`${credential.type}\0${secret}`).digest("hex");
}

function authHeaders(credential: Credential): Record<string, string> | undefined {
  const secret = credentialSecret(credential);
  if (!secret) return undefined;
  return credential.type === "oauth"
    ? {
        authorization: `Bearer ${secret}`,
        "anthropic-beta": OAUTH_BETA,
        "anthropic-version": ANTHROPIC_VERSION,
      }
    : { "x-api-key": secret, "anthropic-version": ANTHROPIC_VERSION };
}

/** Every model id the credential's account can use, following pagination. */
async function fetchModelIds(
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(MODELS_URL);
    url.searchParams.set("limit", "1000");
    if (after !== undefined) url.searchParams.set("after_id", after);
    const response = await fetch(url, { headers, signal });
    if (!response.ok) throw new Error(`Anthropic model list returned HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!modelsPage.check(body)) throw new Error("Anthropic model list has an unexpected shape");
    for (const model of body.data) ids.add(model.id);
    const last = body.data.at(-1);
    if (body.has_more !== true || last === undefined) return ids;
    after = last.id;
  }
  throw new Error("Anthropic model list exceeded the page limit");
}

export default function anthropicEntitlement(pi: ExtensionAPI): void {
  const entitlements = new Map<string, Entitlement>();
  /** This instance's installed wrapper. */
  let installed: Provider | undefined;
  /**
   * The registry outlives a session switch or reload (a ctx does not), so a
   * wrapper left by an earlier load still republishes its own late result.
   */
  let registry: ExtensionContext["modelRegistry"] | undefined;

  /** Recompute availability so a newly confirmed model appears. */
  const republish = (): void => {
    if (registry === undefined) return;
    let pending: Promise<unknown>;
    try {
      pending = registry.refresh({ allowNetwork: false, providers: [PROVIDER] });
    } catch (error) {
      rethrowUnlessStaleContext(error);
      return;
    }
    void pending.catch(rethrowUnlessStaleContext);
  };

  /** Confirmed model ids, or undefined while unverified (starting a check when due). */
  const entitledIds = (credential: Credential | undefined): ReadonlySet<string> | undefined => {
    const key = credentialKey(credential);
    if (key === undefined || credential === undefined) return undefined;
    const entry = entitlements.get(key);
    if (entry?.state === "known") return entry.ids;
    if (entry?.state === "pending") return undefined;
    if (entry?.state === "failed" && Date.now() - entry.at < RETRY_AFTER_MS) return undefined;
    const headers = authHeaders(credential);
    if (headers === undefined) return undefined;
    entitlements.set(key, { state: "pending" });
    void fetchModelIds(headers, AbortSignal.timeout(FETCH_TIMEOUT_MS)).then(
      (ids) => {
        entitlements.set(key, { state: "known", ids });
        if ([...GATED_MODEL_IDS].some((id) => ids.has(id))) republish();
      },
      () => {
        // Unverified, not denied: hide the gated models and retry later.
        entitlements.set(key, { state: "failed", at: Date.now() });
      },
    );
    return undefined;
  };

  const allow = <M extends { readonly id: string }>(
    models: readonly M[],
    credential: Credential | undefined,
  ): readonly M[] => {
    if (!models.some((model) => GATED_MODEL_IDS.has(model.id))) return models;
    const ids = entitledIds(credential);
    return models.filter((model) => !GATED_MODEL_IDS.has(model.id) || ids?.has(model.id) === true);
  };

  /** A provider that delegates every member to `base` and filters gated models. */
  const wrap = (base: Provider): Provider => {
    const baseFilter = base.filterModels?.bind(base);
    const wrapper: Provider = {
      get id() {
        return base.id;
      },
      get name() {
        return base.name;
      },
      get auth() {
        return base.auth;
      },
      getModels: () => base.getModels(),
      stream: (model, context, options) => base.stream(model, context, options),
      streamSimple: (model, context, options) => base.streamSimple(model, context, options),
      filterModels: (models, credential) =>
        allow(baseFilter ? baseFilter(models, credential) : models, credential),
    };
    if ("baseUrl" in base) {
      Object.defineProperty(wrapper, "baseUrl", {
        get: () => base.baseUrl,
        enumerable: true,
        configurable: true,
      });
    }
    if ("headers" in base) {
      Object.defineProperty(wrapper, "headers", {
        get: () => base.headers,
        enumerable: true,
        configurable: true,
      });
    }
    if (base.getAllModels !== undefined) wrapper.getAllModels = base.getAllModels.bind(base);
    if (base.refreshModels !== undefined) wrapper.refreshModels = base.refreshModels.bind(base);
    const baseFilterAll = base.filterAllModels?.bind(base);
    if (baseFilterAll !== undefined) {
      wrapper.filterAllModels = (models, credential) =>
        allow(baseFilterAll(models, credential), credential);
    }
    if (base.fetchDeferred !== undefined) wrapper.fetchDeferred = base.fetchDeferred.bind(base);
    if (base.cancelDeferred !== undefined) wrapper.cancelDeferred = base.cancelDeferred.bind(base);
    if (base.generateImages !== undefined) wrapper.generateImages = base.generateImages.bind(base);
    if (base.classify !== undefined) wrapper.classify = base.classify.bind(base);
    Object.setPrototypeOf(wrapper, base);
    return wrapper;
  };

  /** Whether this instance's wrapper is the native provider or a prototype of it. */
  const inChain = (native: Provider | undefined): boolean =>
    installed !== undefined &&
    native !== undefined &&
    (native === installed || Object.prototype.isPrototypeOf.call(installed, native));

  /** Install the wrapper unless this instance's wrapper is already in the native chain. */
  const ensure = (ctx: ExtensionContext): void => {
    const current = ctx.modelRegistry;
    registry = current;
    if (inChain(current.getRegisteredNativeProvider(PROVIDER))) return;
    // The composed provider keeps earlier overlays, including a wrapper from an earlier load.
    const base = current.getProvider(PROVIDER);
    if (base === undefined) return;
    installed = wrap(base);
    pi.registerProvider(installed);
  };

  pi.on("session_start", (_event, ctx) => {
    ensure(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    ensure(ctx);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    ensure(ctx);
  });
}
