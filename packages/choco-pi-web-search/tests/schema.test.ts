import assert from "node:assert/strict";
import test from "node:test";
import { compile } from "@earendil-works/pi-schema";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  bindSearchSession,
  canonicalSearchParams,
  createSearchScope,
  isSearchError,
  registerSearchAdapter,
  search,
  SearchError,
  searchProviderSchema,
  type SearchAdapter,
  type SearchResponse,
} from "../index.ts";

const isParams = compile(canonicalSearchParams).check;
const isProvider = compile(searchProviderSchema()).check;

test("canonicalSearchParams accepts valid requests and treats optional keys as omittable", () => {
  assert.equal(isParams({}), true);
  assert.equal(isParams({ query: "q", lineno: 0, open: true, click: { id: 3 } }), true);
  assert.equal(isParams({ query: "q", offset: undefined }), true);
  assert.equal(isParams({ find: { pattern: "x" }, reference: { id: "r" } }), true);
  assert.equal(isParams({ requiredCapabilities: ["url", "offset"] }), true);
});

test("canonicalSearchParams rejects unknown keys, bad bounds, enums, and duplicates", () => {
  assert.equal(isParams({ query: "q", extra: 1 }), false);
  assert.equal(isParams({ click: { id: 1, extra: 1 } }), false);
  assert.equal(isParams({ reference: { id: "r", extra: 1 } }), false);
  assert.equal(isParams({ query: "" }), false);
  assert.equal(isParams({ queries: [] }), false);
  assert.equal(isParams({ numResults: 101 }), false);
  assert.equal(isParams({ numResults: 1.5 }), false);
  assert.equal(isParams({ country: "usa" }), false);
  assert.equal(isParams({ action: "nope" }), false);
  assert.equal(isParams({ requiredCapabilities: ["url", "url"] }), false);
  assert.equal(isParams({ requiredCapabilities: ["bogus"] }), false);
  assert.equal(isParams({ query: null }), false);
  assert.equal(isParams(null), false);
  assert.equal(isParams([]), false);
});

test("searchProviderSchema accepts a selection or a unique family list only", () => {
  assert.equal(isProvider("auto"), true);
  assert.equal(isProvider(["brave", "xai"]), true);
  assert.equal(isProvider([]), false);
  assert.equal(isProvider(["brave", "brave"]), false);
  assert.equal(isProvider("google"), false);
  assert.equal(isProvider(["auto"]), false);
  assert.equal(searchProviderSchema("d").description, "d");
});

function adapterWith<Response, Availability>(
  response: Response,
  availability: Availability,
): SearchAdapter {
  const valid: SearchAdapter = {
    id: "schema.probe",
    family: "synthetic",
    transport: "schema",
    capabilities: { actions: ["search"], constraints: {} },
    availability: () => ({ status: "available" }),
    execute: () => Promise.resolve({ answer: "a", results: [] }),
  };
  // Deliberately malformed output: Object.assign intersects the member types instead of casting.
  return Object.assign(valid, {
    availability: () => Promise.resolve(availability),
    execute: () => Promise.resolve(response),
  });
}

async function run<Response, Availability = { status: "available" }>(
  response: Response,
  availability?: Availability,
): Promise<SearchResponse | SearchError> {
  const scope = createSearchScope();
  bindSearchSession(scope, SessionManager.inMemory("/tmp/choco-pi-web-search-schema"));
  registerSearchAdapter(
    scope,
    adapterWith(response, availability === undefined ? { status: "available" } : availability),
  );
  try {
    return await search({ query: "q" }, { scope });
  } catch (cause) {
    if (isSearchError(cause)) return cause;
    throw cause;
  }
}

function base<Extra extends {}>(extra: Extra) {
  return { answer: "a", results: [{ title: "t", url: "u", snippet: "s" }], ...extra };
}

test("adapter response boundary: accepted shapes", async () => {
  const ok = await run(
    base({
      inlineContent: [{ url: "u", title: "t", content: "c", error: null, status: 200 }],
      warnings: ["w"],
      native: { a: [1, "x", null, { b: false }] },
      references: [{ id: "1", kind: "k", native: [1, 2] }],
    }),
  );
  assert.equal(isSearchError(ok), false);
  assert.equal((await run(base({}))) instanceof SearchError, false);
});

test("adapter response boundary: rejected shapes", async () => {
  const bad: unknown[] = [
    base({ extra: 1 }),
    base({ results: [{ title: "t", url: "u", snippet: "s", extra: 1 }] }),
    base({ results: [{ title: "t", url: "u" }] }),
    base({ native: Number.NaN }),
    base({ native: { a: Number.POSITIVE_INFINITY } }),
    base({ native: { a: undefined } }),
    base({ native: 1n }),
    base({ references: [{ id: "", kind: "k" }] }),
    base({ inlineContent: [{ url: "u", title: "t", content: "c" }] }),
    base({ inlineContent: [{ url: "u", title: "t", content: "c", error: null, thumbnail: {} }] }),
    base({ warnings: [1] }),
    null,
    [],
  ];
  for (const [index, response] of bad.entries()) {
    const failure = await run(response);
    assert.ok(isSearchError(failure), `response ${index}`);
    assert.equal(failure.kind, "invalid-response");
  }
});

test("adapter availability boundary is closed and enum-checked", async () => {
  const good = [
    { status: "available" },
    { status: "disabled", reason: "r", transport: "t", billing: "free" },
  ];
  for (const availability of good) {
    const outcome = await run(base({}), availability);
    assert.equal(outcome instanceof SearchError, availability.status === "disabled");
  }
  const bad = [
    { status: "available", extra: 1 },
    { status: "maybe" },
    { status: "available", transport: "" },
    { status: "available", billing: "paid" },
    { status: "available", reason: 1 },
    null,
  ];
  for (const availability of bad) {
    const failure = await run(base({}), availability);
    assert.ok(failure instanceof SearchError, JSON.stringify(availability));
    assert.ok(failure.attempts?.some((attempt) => attempt.outcome === "error"));
  }
});

test("isSearchError requires the realm brand and a well-formed shape", () => {
  const error = new SearchError("auth", "m", {
    family: "brave",
    status: 401,
    retryable: true,
    attempts: [{ adapterId: "a", family: "brave", transport: "t", outcome: "error" }],
  });
  assert.equal(isSearchError(error), true);
  assert.equal(isSearchError({ name: "SearchError", message: "m", kind: "auth" }), false);
  assert.equal(isSearchError(null), false);
  assert.equal(isSearchError("x"), false);
  assert.equal(
    isSearchError(() => 1),
    false,
  );
  assert.equal(isSearchError([]), false);
  // Optional fields tolerate undefined, extra keys stay allowed, and a bad field fails the shape.
  Object.assign(error, { extra: 1, family: undefined });
  assert.equal(isSearchError(error), true);
  Object.assign(error, { status: 1.5 });
  assert.equal(isSearchError(error), false);
});
