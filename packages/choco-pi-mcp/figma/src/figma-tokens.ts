import { asFigmaRecord, isStringValue, type FigmaValue } from "./figma-values.ts";

export interface FigmaTokenMap {
  styles: Record<string, { key?: string; name: string; type?: string; description?: string }>;
  variables: Record<
    string,
    { key?: string; name: string; collectionName?: string; resolvedType?: string }
  >;
  collections: Record<string, { name: string; modes?: Array<{ modeId: string; name: string }> }>;
  warnings: string[];
}

export function buildFigmaTokenMap(
  stylesResponse: FigmaValue,
  variablesResponse: FigmaValue,
): FigmaTokenMap {
  const warnings: string[] = [];
  const styles: FigmaTokenMap["styles"] = {};
  for (const style of getNestedArray(stylesResponse, ["meta", "styles"])) {
    const record = asFigmaRecord(style);
    const id = stringValue(record.node_id) ?? stringValue(record.nodeId) ?? stringValue(record.key);
    if (!id) continue;
    styles[id] = {
      key: stringValue(record.key),
      name: String(record.name ?? id),
      type: stringValue(record.style_type) ?? stringValue(record.styleType),
      description: stringValue(record.description),
    };
  }

  const variables: FigmaTokenMap["variables"] = {};
  const collections: FigmaTokenMap["collections"] = {};
  const meta = asFigmaRecord(asFigmaRecord(variablesResponse).meta ?? variablesResponse);
  const rawCollections = asFigmaRecord(meta.variableCollections ?? meta.variable_collections);
  for (const [collectionId, raw] of Object.entries(rawCollections)) {
    const record = asFigmaRecord(raw);
    collections[collectionId] = {
      name: String(record.name ?? collectionId),
      modes: Array.isArray(record.modes)
        ? record.modes.map((mode) => ({
            modeId: String(asFigmaRecord(mode).modeId ?? asFigmaRecord(mode).mode_id ?? ""),
            name: String(asFigmaRecord(mode).name ?? "Mode"),
          }))
        : undefined,
    };
  }
  const rawVariables = asFigmaRecord(meta.variables);
  for (const [variableId, raw] of Object.entries(rawVariables)) {
    const record = asFigmaRecord(raw);
    const collectionId =
      stringValue(record.variableCollectionId) ?? stringValue(record.variable_collection_id);
    variables[variableId] = {
      key: stringValue(record.key),
      name: String(record.name ?? variableId),
      collectionName: collectionId ? collections[collectionId]?.name : undefined,
      resolvedType: stringValue(record.resolvedType) ?? stringValue(record.resolved_type),
    };
  }
  if (!Object.keys(styles).length)
    warnings.push("No named styles were available to resolve style IDs.");
  if (!Object.keys(variables).length)
    warnings.push("No local variables were available to resolve variable IDs.");
  return { styles, variables, collections, warnings };
}

function getNestedArray(value: FigmaValue, path: readonly string[]): FigmaValue[] {
  let current = value;
  for (const segment of path) current = asFigmaRecord(current)[segment];
  return Array.isArray(current) ? current : [];
}

function stringValue(value: FigmaValue): string | undefined {
  return isStringValue(value) ? value : undefined;
}
