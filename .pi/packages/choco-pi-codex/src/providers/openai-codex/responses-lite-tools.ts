import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

const DEFAULT_TOOL_NAMESPACE = "functions";

const ProtocolRecordType = Type.Record(Type.String(), Type.Unknown());
type ProtocolRecord = Static<typeof ProtocolRecordType>;
const ProtocolRecordSchema = Type.Unsafe<ProtocolRecord>({ type: "object" });
const DefaultNamespaceSchema = Type.Object({
  type: Type.Literal("namespace"),
  name: Type.Literal(DEFAULT_TOOL_NAMESPACE),
  description: Type.Optional(Type.Unknown()),
  tools: Type.Array(Type.Unknown()),
});
type DefaultNamespace = Static<typeof DefaultNamespaceSchema>;

function isRecord<T>(value: T): value is Extract<T, object> & ProtocolRecord {
  return Check(ProtocolRecordSchema, value);
}

function isDefaultNamespace<T>(value: T): value is T & DefaultNamespace {
  return Check(DefaultNamespaceSchema, value);
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
      if (Check(Type.String(), tool.description) && tool.description.trim()) {
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
