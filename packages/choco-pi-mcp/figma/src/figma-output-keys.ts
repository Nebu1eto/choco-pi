import { isFigmaRecord, type FigmaRecord, type FigmaValue } from "./figma-values.ts";

/**
 * camelCase keys that the Figma REST API itself spells. Processed tool output copies them from
 * Figma nodes, so they keep Figma's spelling; every other camelCase key is ours and becomes snake_case.
 */
const FIGMA_REST_KEYS: ReadonlySet<string> = new Set([
  "layoutMode",
  "layoutWrap",
  "layoutAlign",
  "layoutGrow",
  "layoutSizingHorizontal",
  "layoutSizingVertical",
  "layoutGrids",
  "primaryAxisAlignItems",
  "counterAxisAlignItems",
  "counterAxisSpacing",
  "itemSpacing",
  "paddingLeft",
  "paddingRight",
  "paddingTop",
  "paddingBottom",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "gutterSize",
  "sectionSize",
  "strokeWeight",
  "cornerRadius",
  "scaleMode",
  "imageRef",
  "fontFamily",
  "fontPostScriptName",
  "fontSize",
  "fontWeight",
  "lineHeightPx",
  "letterSpacing",
  "textAlignHorizontal",
  "textAlignVertical",
  "componentId",
  "componentSetId",
  "lastModified",
  "boundVariables",
  "componentProperties",
  "preferredValues",
]);

/** Keys whose children are data-keyed (user property names, variable paths): keep child keys as-is. */
const OPAQUE_CHILD_KEYS: ReadonlySet<string> = new Set([
  "componentProperties",
  "boundVariables",
  "styleIds",
  "images",
]);

export function toSnakeCaseKey(key: string): string {
  return key.replace(/([A-Z])/g, (letter) => `_${letter.toLowerCase()}`);
}

function outputKey(key: string): string {
  return FIGMA_REST_KEYS.has(key) ? key : toSnakeCaseKey(key);
}

/** Convert the keys we invent in processed tool output; Figma-spelled keys and data-keyed maps stay. */
export function toFigmaOutput(value: FigmaValue, opaqueKeys = false): FigmaValue {
  if (Array.isArray(value)) return value.map((item) => toFigmaOutput(item));
  if (!isFigmaRecord(value)) return value;
  const out: FigmaRecord = {};
  for (const [key, child] of Object.entries(value)) {
    out[opaqueKeys ? key : outputKey(key)] = toFigmaOutput(child, OPAQUE_CHILD_KEYS.has(key));
  }
  return out;
}
