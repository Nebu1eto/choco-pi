import assert from "node:assert/strict";
import test from "node:test";
import { compile } from "@earendil-works/pi-schema";
import { createAgentBrowserParamsSchema } from "../extensions/agent-browser/lib/input-modes/params.ts";
import { AGENT_BROWSER_PARAMS } from "../extensions/agent-browser/lib/input-modes/params.ts";
import { fullDescription } from "../extensions/agent-browser/lib/json-schema.ts";
import { hasRuntimeType } from "../extensions/agent-browser/lib/parsing.ts";
import {
  AgentBrowserWebSearchParams,
  createAgentBrowserWebSearchParamsSchema,
} from "../extensions/agent-browser/lib/web-search-registration.ts";

const isParams = compile(AGENT_BROWSER_PARAMS).check;
const isSearchParams = compile(AgentBrowserWebSearchParams).check;

test("provider schema omits prose without weakening representative constraints", () => {
  assert.doesNotMatch(JSON.stringify(AGENT_BROWSER_PARAMS), /"description"/);
  assert.equal(isParams({ args: ["open", "https://example.com"] }), true);
  assert.equal(isParams({ electron: { action: "cleanup", all: true } }), true);
  assert.equal(isParams({ args: [] }), false);
  assert.equal(isParams({ electron: { action: "invalid" } }), false);
});

test("compact and full schemas differ only by descriptions", () => {
  const full = createAgentBrowserParamsSchema(fullDescription);
  assert.match(JSON.stringify(full), /"description"/);
  const strip = (value: string) => value.replace(/,?"description":"(?:[^"\\]|\\.)*"/g, "");
  assert.equal(
    strip(JSON.stringify(full)).replace(/\{,/g, "{"),
    JSON.stringify(AGENT_BROWSER_PARAMS).replace(/\{,/g, "{"),
  );
});

test("params schema is closed at every object level and keeps optional fields optional", () => {
  assert.equal(isParams({}), true);
  assert.equal(isParams({ timeoutMs: undefined }), true);
  assert.equal(isParams({ unknownKey: 1 }), false);
  assert.equal(isParams({ semanticAction: { action: "click", extra: true } }), false);
  assert.equal(isParams({ job: { steps: [{ action: "open", extra: 1 }] } }), false);
  assert.equal(isParams({ job: { steps: [] } }), false);
  assert.equal(isParams({ timeoutMs: 1.5 }), false);
  assert.equal(isParams({ timeoutMs: 0 }), false);
  assert.equal(isParams({ sessionMode: "fresh" }), true);
  assert.equal(isParams({ sessionMode: "other" }), false);
  assert.equal(isParams({ qa: { url: "https://example.com", attached: false } }), true);
  assert.equal(isParams({ qa: { attached: true } }), true);
  assert.equal(isParams({ qa: { attached: false } }), false);
  assert.equal(isParams({ electron: { action: "status", launchId: "x", all: true } }), false);
});

test("string enums keep an explicit string type", () => {
  const schema = JSON.stringify(AGENT_BROWSER_PARAMS);
  assert.match(schema, /"type":"string","enum":\["auto","fresh"\]/);
});

test("web search schema validates and rejects as before", () => {
  assert.match(JSON.stringify(createAgentBrowserWebSearchParamsSchema()), /"description"/);
  assert.equal(isSearchParams({ query: "x" }), true);
  assert.equal(isSearchParams({ query: "" }), false);
  assert.equal(isSearchParams({ query: "x", count: 11 }), false);
  assert.equal(isSearchParams({ query: "x", country: "USA" }), false);
  assert.equal(isSearchParams({ query: "x", extra: 1 }), false);
  assert.equal(isSearchParams({ query: "x", freshness: "pd", safesearch: "off" }), true);
});

test("hasRuntimeType matches typeof semantics", () => {
  assert.equal(hasRuntimeType(1, "number"), true);
  assert.equal(hasRuntimeType(Number.NaN, "number"), true);
  assert.equal(hasRuntimeType(Number.NEGATIVE_INFINITY, "number"), true);
  assert.equal(hasRuntimeType(Object(1), "number"), false);
  assert.equal(hasRuntimeType("a", "string"), true);
  assert.equal(hasRuntimeType(Object("a"), "string"), false);
  assert.equal(hasRuntimeType(Object.create(null), "string"), false);
  assert.equal(hasRuntimeType(true, "boolean"), true);
  assert.equal(hasRuntimeType(Object(true), "boolean"), false);
  assert.equal(hasRuntimeType(1n, "bigint"), true);
  assert.equal(hasRuntimeType(Object(1n), "bigint"), false);
  assert.equal(hasRuntimeType(Symbol("s"), "symbol"), true);
  assert.equal(hasRuntimeType(Object(Symbol("s")), "symbol"), false);
  assert.equal(
    hasRuntimeType(() => 1, "function"),
    true,
  );
  assert.equal(
    hasRuntimeType(() => 1, "object"),
    false,
  );
  assert.equal(hasRuntimeType(null, "object"), true);
  assert.equal(hasRuntimeType({}, "object"), true);
  assert.equal(hasRuntimeType(undefined, "undefined"), true);
});
