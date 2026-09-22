import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import {
  getSearchScope,
  hasCanonicalSearch,
  registerSearchAdapter,
  resolveSearchScope,
  resolveSearchSession,
  search,
  SearchError,
  SearchScope,
} from "../../index.ts";

export const CROSS_LOADER_RESULT_CHANNEL = "choco-pi-web-search:test:cross-loader-result:v1";
const NativeOwnerSchema = Type.Object(
  { owner: Type.Literal("jiti") },
  { additionalProperties: false },
);

export default function crossLoaderProbe(pi: ExtensionAPI): void {
  const scope = getSearchScope(pi.events);
  registerSearchAdapter(scope, {
    id: "cross-loader.probe",
    family: "synthetic",
    transport: "cross-loader-jiti",
    priority: -100,
    capabilities: {
      actions: ["search", "open"],
      constraints: { url: true },
    },
    availability: () => ({
      status: "available",
      transport: "cross-loader-jiti",
      billing: "free",
    }),
    async execute(request, context) {
      if (request.query === "cross-loader-auth") {
        throw new SearchError("auth", "foreign loader authentication failure", {
          family: "synthetic",
          adapterId: "cross-loader.probe",
          transport: "cross-loader-jiti",
          status: 401,
          retryable: true,
        });
      }
      if (request.action === "open") {
        const reference = context.reference;
        const native = reference?.native;
        if (
          reference?.id !== "foreign-reference" ||
          reference.kind !== "search-result" ||
          !Check(NativeOwnerSchema, native)
        ) {
          throw new SearchError("stale-context", "foreign reference identity was not preserved");
        }
        return {
          answer: "opened foreign reference",
          results: [],
        };
      }
      return {
        answer: "foreign search result",
        results: [
          {
            title: "Foreign result",
            url: "https://example.test/cross-loader",
            snippet: "Loaded through Jiti",
          },
        ],
        references: [
          {
            id: "foreign-reference",
            kind: "search-result",
            native: { owner: "jiti" },
          },
        ],
      };
    },
  });

  pi.on("session_start", async (_event, context) => {
    const resolvedScope = resolveSearchScope(context);
    const resolvedSession = resolveSearchSession(context);
    const initial = await search(
      { query: "cross-loader-reference", provider: "synthetic" },
      { context },
    );
    const reference = initial.references?.[0];
    if (!reference) {
      throw new SearchError("invalid-response", "foreign search returned no reference");
    }
    const opened = await search(
      {
        action: "open",
        reference: { id: reference.id },
        provider: "synthetic",
      },
      { context },
    );
    pi.events.emit(CROSS_LOADER_RESULT_CHANNEL, {
      canonical: hasCanonicalSearch(scope),
      distinctScopeConstructor: !(scope instanceof SearchScope),
      scopeResolved: resolvedScope === scope,
      sessionResolved: resolvedSession === scope.session,
      searchAnswer: initial.answer,
      openAnswer: opened.answer,
      referenceAdapterId: reference.adapterId,
    });
  });
}
