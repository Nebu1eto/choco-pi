import { isString } from "../value-guards.ts";
import { isJsonObject, type JsonObject } from "../../adapter/runtime-values.ts";
import { arr, compile, lit, obj, opt, unknown, type Static } from "@earendil-works/pi-schema";

const DEFAULT_TOOL_NAMESPACE = "functions";

type ProtocolRecord = JsonObject;
const defaultNamespaceSchema = obj(
  {
    type: lit("namespace"),
    name: lit(DEFAULT_TOOL_NAMESPACE),
    description: opt(unknown()),
    tools: arr(unknown()),
  },
  { open: true },
);
const defaultNamespaceValidator = compile(defaultNamespaceSchema);
type DefaultNamespace = Static<typeof defaultNamespaceSchema>;

function isRecord<T>(value: T): value is Extract<T, object> & ProtocolRecord {
  return isJsonObject(value);
}

function isDefaultNamespace<T>(value: T): value is T & DefaultNamespace {
  return defaultNamespaceValidator.check(value);
}

export function namespaceResponsesLiteTools<T>(tools: readonly T[]): (T | DefaultNamespace)[] {
  const children: (T | DefaultNamespace["tools"][number])[] = [];
  const output: (T | DefaultNamespace)[] = [];
  let insertionIndex: number | undefined;
  let description = "";

  for (const tool of tools) {
    if (isRecord(tool) && (tool["type"] === "function" || tool["type"] === "custom")) {
      insertionIndex ??= output.length;
      children.push(tool);
      continue;
    }
    if (isDefaultNamespace(tool)) {
      insertionIndex ??= output.length;
      children.push(...tool.tools);
      if (isString(tool.description) && tool.description.trim()) {
        description = tool.description;
      }
      continue;
    }
    output.push(tool);
  }

  if (children.length === 0) return output;
  output.splice(insertionIndex ?? output.length, 0, {
    type: "namespace",
    name: DEFAULT_TOOL_NAMESPACE,
    description,
    tools: children,
  });
  return output;
}

export function namespaceResponsesLiteInputTools<T>(input: readonly T[]) {
  return input.map((item) => {
    if (!isRecord(item) || !Array.isArray(item["tools"])) return item;
    if (item["type"] !== "additional_tools" && item["type"] !== "tool_search_output") return item;
    return { ...item, tools: namespaceResponsesLiteTools(item["tools"]) };
  });
}
