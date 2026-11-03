import test from "node:test";
import assert from "node:assert/strict";
import { compile } from "@earendil-works/pi-schema";
import {
  FigmaExtractAssetsParams,
  FigmaFindNodesParams,
  FigmaGetNodesParams,
  FigmaImplementationContextParams,
  FigmaParseUrlParams,
  FigmaRenderNodesParams,
} from "../figma/src/figma-schemas.ts";
import { hostParams } from "../figma/src/schema-bridge.ts";

test("required fields are enforced and optional fields may be omitted", () => {
  const parseUrl = compile(FigmaParseUrlParams);
  assert.equal(parseUrl.check({ url: "https://figma.com/design/abc" }), true);
  assert.equal(parseUrl.check({}), false);
  assert.equal(parseUrl.check({ url: 3 }), false);
  const nodes = compile(FigmaGetNodesParams);
  assert.equal(nodes.check({ fileKey: "k", nodeIds: ["1:2"] }), true);
  assert.equal(nodes.check({ fileKey: "k", nodeIds: [] }), false);
  assert.equal(nodes.check({ fileKey: "k" }), false);
});

test("objects stay open like the TypeBox originals", () => {
  assert.equal(compile(FigmaParseUrlParams).check({ url: "u", extra: true }), true);
});

test("numeric bounds and enums are enforced", () => {
  const find = compile(FigmaFindNodesParams);
  assert.equal(find.check({ fileKey: "k", query: "q", maxResults: 200, depth: 4 }), true);
  assert.equal(find.check({ fileKey: "k", query: "q", maxResults: 201 }), false);
  assert.equal(find.check({ fileKey: "k", query: "q", depth: 0 }), false);
  assert.equal(find.check({ fileKey: "k", query: "q", maxResponseChars: 0 }), false);
  const render = compile(FigmaRenderNodesParams);
  assert.equal(render.check({ fileKey: "k", nodeIds: ["1"], format: "svg", scale: 4 }), true);
  assert.equal(render.check({ fileKey: "k", nodeIds: ["1"], format: "gif" }), false);
  assert.equal(render.check({ fileKey: "k", nodeIds: ["1"], scale: 0 }), false);
  const impl = compile(FigmaImplementationContextParams);
  assert.equal(
    impl.check({ fileKey: "k", nodeId: "1", framework: "vue", styling: "tailwind" }),
    true,
  );
  assert.equal(impl.check({ fileKey: "k", nodeId: "1", framework: "svelte" }), false);
  const assets = compile(FigmaExtractAssetsParams);
  assert.equal(assets.check({ fileKey: "k", nodeId: "1", assetTypes: ["svgIcons"] }), true);
  assert.equal(assets.check({ fileKey: "k", nodeId: "1", assetTypes: ["fonts"] }), false);
  assert.equal(assets.check({ fileKey: "k", nodeId: "1", maxAssets: 501 }), false);
});

test("hostParams wraps the schema for the host registration contract", () => {
  const wrapped = hostParams(FigmaParseUrlParams);
  const validator = compile(wrapped);
  assert.equal(validator.check({ url: "u" }), true);
  assert.equal(validator.check({}), false);
});
