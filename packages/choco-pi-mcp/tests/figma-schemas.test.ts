import test from "node:test";
import assert from "node:assert/strict";
import { compile } from "@earendil-works/pi-schema";
import {
  FigmaComponentImplementationHintsParams,
  FigmaExtractAssetsParams,
  FigmaFindCodeConnectMappingParams,
  FigmaFindNodesParams,
  FigmaGetFileParams,
  FigmaGetNodesParams,
  FigmaImplementationContextParams,
  FigmaParseUrlParams,
  FigmaRenderNodesParams,
  FigmaSingleFileParams,
} from "../figma/src/figma-schemas.ts";
import { hostParams } from "../figma/src/schema-bridge.ts";

test("required fields are enforced and optional fields may be omitted", () => {
  const parseUrl = compile(FigmaParseUrlParams);
  assert.equal(parseUrl.check({ url: "https://figma.com/design/abc" }), true);
  assert.equal(parseUrl.check({}), false);
  assert.equal(parseUrl.check({ url: 3 }), false);
  const nodes = compile(FigmaGetNodesParams);
  assert.equal(nodes.check({ file_key: "k", node_ids: ["1:2"] }), true);
  assert.equal(nodes.check({ file_key: "k", node_ids: [] }), false);
  assert.equal(nodes.check({ file_key: "k" }), false);
});

test("file_key-only tools accept file_key and reject the former fileKey", () => {
  // figma_get_styles, figma_get_variables, figma_get_components, figma_get_component_sets
  const single = compile(FigmaSingleFileParams);
  assert.equal(single.check({ file_key: "k" }), true);
  assert.equal(single.check({ file_key: "k", max_response_chars: 2000 }), true);
  assert.equal(single.check({ fileKey: "k" }), false);
  assert.equal(single.check({ file_key: "k", maxResponseChars: 2000 }), false);
  assert.equal(single.check({}), false);
  // figma_get_file
  const file = compile(FigmaGetFileParams);
  assert.equal(file.check({ file_key: "k", depth: 2 }), true);
  assert.equal(file.check({ fileKey: "k", depth: 2 }), false);
});

test("objects are closed so renamed camelCase inputs are rejected", () => {
  assert.equal(compile(FigmaParseUrlParams).check({ url: "u", extra: true }), false);
});

test("snake_case inputs and values validate; the old camelCase names and values do not", () => {
  const assets = compile(FigmaExtractAssetsParams);
  const modern = {
    file_key: "k",
    node_id: "1",
    asset_types: ["svg_icons", "node_renders", "image_fills"],
    output_dir: "out",
    include_hidden: true,
    max_assets: 5,
    max_response_chars: 100,
  };
  assert.equal(assets.check(modern), true);
  assert.equal(assets.check({ ...modern, asset_types: ["svgIcons"] }), false);
  assert.equal(assets.check({ ...modern, asset_types: ["nodeRenders"] }), false);
  assert.equal(assets.check({ ...modern, asset_types: ["imageFills"] }), false);
  for (const old of [
    "fileKey",
    "nodeId",
    "assetTypes",
    "outputDir",
    "includeHidden",
    "maxAssets",
    "maxResponseChars",
  ]) {
    assert.equal(assets.check({ ...modern, [old]: modern.node_id }), false, old);
  }
  const hints = compile(FigmaComponentImplementationHintsParams);
  assert.equal(
    hints.check({
      file_key: "k",
      node_id: "1",
      include_hidden: false,
      include_vectors: false,
      include_component_internals: false,
      include_code_connect: true,
      include_snippet: true,
      root_dir: "src",
    }),
    true,
  );
  assert.equal(hints.check({ file_key: "k", node_id: "1", includeCodeConnect: true }), false);
  const context = compile(FigmaImplementationContextParams);
  assert.equal(
    context.check({
      file_key: "k",
      node_id: "1",
      render_image: true,
      resolve_tokens: true,
      include_code_snippets: true,
    }),
    true,
  );
  assert.equal(context.check({ file_key: "k", node_id: "1", resolveTokens: true }), false);
  const codeConnect = compile(FigmaFindCodeConnectMappingParams);
  assert.equal(
    codeConnect.check({ file_key: "k", component_key: "c", root_dir: "src", max_matches: 3 }),
    true,
  );
  assert.equal(codeConnect.check({ file_key: "k", maxMatches: 3 }), false);
  const find = compile(FigmaFindNodesParams);
  assert.equal(find.check({ file_key: "k", query: "q", case_sensitive: true }), true);
  assert.equal(find.check({ file_key: "k", query: "q", caseSensitive: true }), false);
});

test("numeric bounds and enums are enforced", () => {
  const find = compile(FigmaFindNodesParams);
  assert.equal(find.check({ file_key: "k", query: "q", max_results: 200, depth: 4 }), true);
  assert.equal(find.check({ file_key: "k", query: "q", max_results: 201 }), false);
  assert.equal(find.check({ file_key: "k", query: "q", depth: 0 }), false);
  assert.equal(find.check({ file_key: "k", query: "q", max_response_chars: 0 }), false);
  const render = compile(FigmaRenderNodesParams);
  assert.equal(render.check({ file_key: "k", node_ids: ["1"], format: "svg", scale: 4 }), true);
  assert.equal(render.check({ file_key: "k", node_ids: ["1"], format: "gif" }), false);
  assert.equal(render.check({ file_key: "k", node_ids: ["1"], scale: 0 }), false);
  const impl = compile(FigmaImplementationContextParams);
  assert.equal(
    impl.check({ file_key: "k", node_id: "1", framework: "vue", styling: "tailwind" }),
    true,
  );
  assert.equal(impl.check({ file_key: "k", node_id: "1", framework: "svelte" }), false);
  const assets = compile(FigmaExtractAssetsParams);
  assert.equal(assets.check({ file_key: "k", node_id: "1", asset_types: ["svg_icons"] }), true);
  assert.equal(assets.check({ file_key: "k", node_id: "1", asset_types: ["fonts"] }), false);
  assert.equal(assets.check({ file_key: "k", node_id: "1", max_assets: 501 }), false);
});

test("hostParams wraps the schema for the host registration contract", () => {
  const wrapped = hostParams(FigmaParseUrlParams);
  const validator = compile(wrapped);
  assert.equal(validator.check({ url: "u" }), true);
  assert.equal(validator.check({}), false);
});
