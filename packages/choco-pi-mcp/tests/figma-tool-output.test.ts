import test from "node:test";
import assert from "node:assert/strict";
import type { FigmaValue } from "../figma/src/figma-values.ts";
import { toFigmaOutput } from "../figma/src/figma-output-keys.ts";
import { summarizeNode } from "../figma/src/figma-summarizer.ts";
import { collectAssetCandidates } from "../figma/src/figma-assets.ts";
import { parseFigmaUrl } from "../figma/src/figma-client.ts";
import { toExtractAssetsOutput } from "../figma/src/figma-tools.ts";
import { jsonToolResult } from "../figma/common/tool-result.ts";

function allKeys(value: FigmaValue, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) allKeys(item, keys);
  else if (Object.prototype.toString.call(value) === "[object Object]" && value) {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      allKeys(child, keys);
    }
  }
  return keys;
}

test("toFigmaOutput converts invented keys and keeps Figma REST spellings and data-keyed maps", () => {
  const converted = toFigmaOutput({
    nodeId: "1:2",
    roleGuess: "button",
    layout: { primaryAxisAlignItems: "MIN", layoutMode: "HORIZONTAL" },
    spacing: { itemSpacing: 4, paddingLeft: 2 },
    component: { componentId: "c", componentProperties: { iconLeft: { preferredValues: [] } } },
    metadata: { truncatedReasons: [], nextSteps: [] },
  });
  assert.deepEqual(converted, {
    node_id: "1:2",
    role_guess: "button",
    layout: { primaryAxisAlignItems: "MIN", layoutMode: "HORIZONTAL" },
    spacing: { itemSpacing: 4, paddingLeft: 2 },
    component: { componentId: "c", componentProperties: { iconLeft: { preferredValues: [] } } },
    metadata: { truncated_reasons: [], next_steps: [] },
  });
});

test("node summaries and asset candidates serialize with snake_case invented keys", () => {
  const summary = summarizeNode({
    id: "1:1",
    name: "Card",
    type: "TEXT",
    characters: "Hello",
    style: { fontFamily: "Inter", fontSize: 12 },
    itemSpacing: 4,
  });
  const keys = allKeys(toFigmaOutput(summary));
  assert.ok(keys.has("visible_text"));
  assert.ok(keys.has("text_style"));
  assert.ok(keys.has("fontFamily"));
  assert.ok(keys.has("itemSpacing"));
  assert.equal(keys.has("visibleText"), false);
  assert.equal(keys.has("textStyle"), false);
  const assets = collectAssetCandidates({ id: "1:1", name: "Icon", type: "VECTOR" });
  const assetKeys = allKeys(toFigmaOutput(assets));
  for (const key of ["node_id", "node_name", "node_type", "node_path", "suggested_name"]) {
    assert.ok(assetKeys.has(key), key);
  }
  assert.ok(assetKeys.has("truncated_reasons"));
});

test("figma_parse_url output serializes snake_case keys", () => {
  const result = jsonToolResult(
    toFigmaOutput(parseFigmaUrl("https://www.figma.com/design/ABC123/Name?node-id=12-34")),
  );
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), {
    file_key: "ABC123",
    node_id: "12:34",
  });
});

test("figma_extract_assets output prints asset types and kinds that round-trip into asset_types", () => {
  const output = toExtractAssetsOutput({
    nodeId: "1:2",
    assetTypes: ["svgIcons", "nodeRenders", "imageFills"],
    assets: [
      {
        kind: "svgIcon",
        nodeId: "1:3",
        nodePath: "Frame/Icon",
        suggestedName: "icon",
        format: "svg",
      },
      {
        kind: "imageFill",
        imageRef: "ref",
        nodePath: "Frame/Img",
        suggestedName: "img",
        format: "png",
      },
    ],
    metadata: { truncated: false, truncatedReasons: [], nextSteps: [] },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(output)), {
    node_id: "1:2",
    asset_types: ["svg_icons", "node_renders", "image_fills"],
    assets: [
      {
        kind: "svg_icon",
        node_id: "1:3",
        node_path: "Frame/Icon",
        suggested_name: "icon",
        format: "svg",
      },
      {
        kind: "image_fill",
        imageRef: "ref",
        node_path: "Frame/Img",
        suggested_name: "img",
        format: "png",
      },
    ],
    metadata: { truncated: false, truncated_reasons: [], next_steps: [] },
  });
});
