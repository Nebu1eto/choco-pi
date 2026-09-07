import { Type } from "typebox";
import { Check } from "typebox/value";
import { nativeRuntime } from "./native-runtime.ts";
import type { ProtocolValue, ResponsesBody, ProviderOutputItem } from "./types.ts";

const ToolSchema = Type.Object({
  type: Type.String(),
  name: Type.Optional(Type.String()),
  allowed_callers: Type.Optional(Type.Array(Type.String())),
});
const NamespaceSchema = Type.Object({
  type: Type.Literal("namespace"),
  tools: Type.Array(Type.Unknown()),
});
const AsyncExecSchema = Type.Object({
  type: Type.Union([Type.Literal("custom_tool_call"), Type.Literal("function_call")]),
  name: Type.Literal("exec"),
  call_id: Type.String(),
  async: Type.Literal(true),
});

/** Unconsumed automatic generations must not have executed server-hosted actions. */
export function supportsNativeSteeringTools(body: ResponsesBody): boolean {
  const clientOwned = (tool: ProtocolValue): boolean => {
    if (Check(NamespaceSchema, tool)) {
      // SAFETY: Namespace children are provider protocol values from the existing tool serializer.
      return (tool.tools as ProtocolValue[]).every(clientOwned);
    }
    return Check(ToolSchema, tool) && (tool.type === "function" || tool.type === "custom");
  };
  return (body.tools ?? []).every(clientOwned);
}

/** The flag belongs to the direct client exec tool, never hosted PTC or nested calls. */
export function withAsyncCodeMode(body: ResponsesBody, enabled: boolean): ResponsesBody {
  if (!enabled || body.model !== "gpt-6-astra" || !body.tools) return body;
  if (
    body.tools.some((tool) => Check(ToolSchema, tool) && tool.type === "programmatic_tool_calling")
  )
    return body;
  const decorate = (tool: ProtocolValue): ProtocolValue => {
    if (Check(NamespaceSchema, tool)) {
      // SAFETY: ResponsesBody tools are already provider protocol values; retain namespace children verbatim except direct exec.
      return { ...tool, tools: (tool.tools as ProtocolValue[]).map(decorate) };
    }
    if (
      Check(ToolSchema, tool) &&
      !tool.allowed_callers?.includes("programmatic") &&
      tool.name === "exec" &&
      (tool.type === "custom" || tool.type === "function")
    ) {
      return { ...tool, async: true };
    }
    return tool;
  };
  return { ...body, tools: body.tools.map(decorate) };
}

// Hints are consumed only inside Pi-approved exec dispatch, never used to execute a tool early.
const asyncCalls = nativeRuntime.asyncCalls;

export function rememberAsyncCodeModeCalls(
  owner: string | undefined,
  items: readonly ProviderOutputItem[],
): void {
  if (!owner) return;
  const ids = items.filter((item) => Check(AsyncExecSchema, item)).map((item) => item.call_id);
  if (ids.length === 0) return;
  const calls = asyncCalls.get(owner) ?? new Set<string>();
  for (const id of ids.slice(0, 64)) calls.add(id);
  while (calls.size > 64) calls.delete(calls.values().next().value!);
  asyncCalls.set(owner, calls);
  while (asyncCalls.size > 64) asyncCalls.delete(asyncCalls.keys().next().value!);
}

export function consumeAsyncCodeModeCall(owner: string, toolCallId: string): boolean {
  const calls = asyncCalls.get(owner);
  const found = calls?.delete(toolCallId.split("|")[0] ?? "") ?? false;
  if (calls?.size === 0) asyncCalls.delete(owner);
  return found;
}

export function clearAsyncCodeModeCalls(owner?: string): void {
  if (owner) asyncCalls.delete(owner);
  else asyncCalls.clear();
}
