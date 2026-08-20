import { isObjectValue, parseMcpObject } from "./protocol-values.js";
export type UiToolVisibility = "model" | "app";

export function extractUiToolVisibility<BoundaryValue>(
  meta: BoundaryValue | undefined,
): UiToolVisibility[] | undefined {
  if (!meta || !isObjectValue(meta)) return undefined;
  const ui = parseMcpObject(meta).ui;

  if (!ui || !isObjectValue(ui) || Array.isArray(ui)) return undefined;

  const visibility = parseMcpObject(ui).visibility;
  if (visibility === undefined) return undefined;
  if (!Array.isArray(visibility)) return [];

  const values: UiToolVisibility[] = [];
  for (const entry of visibility) {
    if (entry !== "model" && entry !== "app") return [];
    if (!values.includes(entry)) values.push(entry);
  }
  return values;
}

export function isUiToolVisibleToModel(
  visibility: readonly UiToolVisibility[] | undefined,
): boolean {
  return visibility === undefined || visibility.includes("model");
}

export function isUiToolCallableByApp(
  visibility: readonly UiToolVisibility[] | undefined,
): boolean {
  return visibility === undefined || visibility.includes("app");
}
