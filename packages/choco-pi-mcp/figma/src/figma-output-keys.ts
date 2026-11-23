import { isFigmaRecord, type FigmaRecord, type FigmaValue } from "./figma-values.ts";

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

export function toFigmaOutput(value: FigmaValue, opaqueKeys = false): FigmaValue {
  if (Array.isArray(value)) return value.map((item) => toFigmaOutput(item));
  if (!isFigmaRecord(value)) return value;
  const out: FigmaRecord = {};
  for (const [key, child] of Object.entries(value)) {
    out[opaqueKeys ? key : outputKey(key)] = toFigmaOutput(child, OPAQUE_CHILD_KEYS.has(key));
  }
  return out;
}
