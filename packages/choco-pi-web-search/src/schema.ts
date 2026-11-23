import {
  arr,
  bool,
  compile,
  int,
  lit,
  nul,
  nullable,
  num,
  obj,
  oneOf,
  opt,
  str,
  union,
  type Schema,
} from "@earendil-works/pi-schema";
import {
  isValidSearchProviderFamily,
  searchProviderFamilies,
  searchProviderSelections,
  type JsonRecord,
  type JsonValue,
} from "./contract.ts";

/** String enum in the `{ type: "string", enum: [...] }` form every Pi provider accepts (not `anyOf` of literals). */
export function stringEnum<const V extends readonly string[]>(values: V): Schema<V[number]> {
  return { type: "string", enum: [...values] };
}

const ProviderFamilySchema = stringEnum(searchProviderFamilies);
const ProviderNameSchema = stringEnum(searchProviderSelections);
const OpenProviderFamilyStringSchema = str({ minLength: 1, pattern: "^[a-z][a-z0-9-]*$" });
export const SearchActionSchema = stringEnum(["search", "image", "open", "click", "find"] as const);
export const SearchErrorKindSchema = stringEnum([
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
] as const);
export const CapabilitySchema = stringEnum([
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
] as const);

export function searchProviderSchema(description?: string) {
  return union(
    [ProviderNameSchema, arr(ProviderFamilySchema, { minItems: 1, uniqueItems: true })],
    description ? { description } : {},
  );
}

const ReferenceInputSchema = obj({ id: str({ minLength: 1 }) });

/** Open JSON-object-of-objects schema for `providerOptions` without `$ref` so tool schemas can copy properties standalone. */
const ProviderOptionsToolSchema: Schema<Record<string, JsonRecord>> = {
  type: "object",
  additionalProperties: {
    type: "object",
    additionalProperties: true,
  },
};

const baseSearchParamFields = {
  query: opt(str({ minLength: 1 })),
  queries: opt(arr(str({ minLength: 1 }), { minItems: 1, maxItems: 20 })),
  action: opt(SearchActionSchema),
  imageQuery: opt(str({ minLength: 1 })),
  url: opt(str({ minLength: 1 })),
  lineno: opt(int({ minimum: 0 })),
  open: opt(bool()),
  click: opt(obj({ id: int({ minimum: 0 }) })),
  find: opt(obj({ pattern: str({ minLength: 1 }) })),
  reference: opt(ReferenceInputSchema),
  responseLength: opt(stringEnum(["short", "medium", "long"] as const)),
  numResults: opt(int({ minimum: 1, maximum: 100 })),
  recencyFilter: opt(stringEnum(["day", "week", "month", "year"] as const)),
  recencyDays: opt(int({ minimum: 1, maximum: 3650 })),
  domainFilter: opt(arr(str({ minLength: 1 }), { minItems: 1, maxItems: 100 })),
  includeContent: opt(bool()),
  country: opt(str({ minLength: 2, maxLength: 2 })),
  language: opt(str({ minLength: 2, maxLength: 35 })),
  safesearch: opt(stringEnum(["off", "moderate", "strict"] as const)),
  offset: opt(int({ minimum: 0 })),
  exaSearchType: opt(
    stringEnum(["auto", "fast", "instant", "deep-lite", "deep", "deep-reasoning"] as const),
  ),
  answerMode: opt(stringEnum(["answer", "results", "both"] as const)),
  searchContextSize: opt(stringEnum(["low", "medium", "high"] as const)),
  requiredCapabilities: opt(arr(CapabilitySchema, { uniqueItems: true })),
  providerOptions: opt(ProviderOptionsToolSchema),
};

export const canonicalSearchParams = obj({
  ...baseSearchParamFields,
  provider: opt(searchProviderSchema()),
});

export const isObjectValue = compile(obj({}, { open: true })).check;

/** Recursive JSON value. Numbers are bounded to finite values because pi-schema `num()` accepts NaN/Infinity. */
const JsonValueSchema: Schema<JsonValue> = { $ref: "#/$defs/JsonValue" };
const JsonRecordSchema: Schema<JsonRecord> = {
  type: "object",
  additionalProperties: JsonValueSchema,
};
const JsonValueDefinitions = {
  JsonValue: {
    anyOf: [
      nul(),
      bool(),
      num({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE }),
      str(),
      { type: "array", items: JsonValueSchema },
      { type: "object", additionalProperties: JsonValueSchema },
    ],
  },
};

const RuntimeProviderOptionsSchema: Schema<Record<string, JsonRecord>> = {
  type: "object",
  additionalProperties: JsonRecordSchema,
};

const RuntimeProviderSelectionSchema = union([
  OpenProviderFamilyStringSchema,
  arr(OpenProviderFamilyStringSchema, { minItems: 1, uniqueItems: true }),
]);

const RuntimeSearchRequestSchema = obj({
  ...baseSearchParamFields,
  provider: opt(RuntimeProviderSelectionSchema),
  providerOptions: opt(RuntimeProviderOptionsSchema),
});
const isRuntimeSearchRequestBase = compile({
  ...RuntimeSearchRequestSchema,
  $defs: JsonValueDefinitions,
}).check;

/** Validates a runtime SearchRequest, allowing any valid custom lowercase family id in `provider`. */
export function isRuntimeSearchRequest<Value>(value: Value): boolean {
  if (!isRuntimeSearchRequestBase(value)) return false;
  if (!isObjectValue(value)) return false;
  const provider = "provider" in value ? Object(value).provider : undefined;
  if (provider === undefined || provider === "auto" || provider === "all") return true;
  if (Array.isArray(provider)) {
    return provider.every((entry) => isValidSearchProviderFamily(entry));
  }
  return isValidSearchProviderFamily(provider);
}

export const SharedSearchErrorSchema = obj(
  {
    name: lit("SearchError"),
    message: str(),
    kind: SearchErrorKindSchema,
    family: opt(OpenProviderFamilyStringSchema),
    adapterId: opt(str()),
    transport: opt(str()),
    billing: opt(stringEnum(["subscription", "api", "free", "unknown"] as const)),
    status: opt(int()),
    retryable: opt(bool()),
    deadlineKind: opt(stringEnum(["total", "attempt"] as const)),
    attempts: opt(
      arr(
        obj({
          adapterId: str(),
          family: OpenProviderFamilyStringSchema,
          transport: str(),
          outcome: stringEnum([
            "success",
            "unavailable",
            "disabled",
            "incompatible",
            "error",
          ] as const),
          errorKind: opt(SearchErrorKindSchema),
          reason: opt(str()),
        }),
      ),
    ),
  },
  { open: true },
);
export const isSharedSearchErrorSnapshot = compile(SharedSearchErrorSchema).check;

const AvailabilitySchema = obj({
  status: oneOf(["available", "unavailable", "disabled", "error"] as const),
  reason: opt(str()),
  transport: opt(str({ minLength: 1 })),
  billing: opt(oneOf(["subscription", "api", "free", "unknown"] as const)),
});
export const isAvailability = compile(AvailabilitySchema).check;

const SearchResultSchema = obj({ title: str(), url: str(), snippet: str() });
const InlineContentSchema = obj({
  url: str(),
  title: str(),
  content: str(),
  error: nullable(str()),
  thumbnail: opt(obj({ data: str(), mimeType: str() })),
  mimeType: opt(str()),
  status: opt(int()),
});
const NativeReferenceSchema = obj({
  id: str({ minLength: 1 }),
  kind: str({ minLength: 1 }),
  native: opt(JsonValueSchema),
});
const AdapterResponseSchema = obj({
  answer: str(),
  results: arr(SearchResultSchema),
  inlineContent: opt(arr(InlineContentSchema)),
  warnings: opt(arr(str())),
  native: opt(JsonValueSchema),
  references: opt(arr(NativeReferenceSchema)),
});
export const isAdapterResponse = compile({
  ...AdapterResponseSchema,
  $defs: JsonValueDefinitions,
}).check;
