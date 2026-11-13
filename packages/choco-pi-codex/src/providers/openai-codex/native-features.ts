import { arr, compile, lit, obj, oneOf, opt, str, unknown } from "@earendil-works/pi-schema";
import { nativeRuntime } from "./native-runtime.ts";
import type { ProtocolValue, ResponsesBody, ProviderOutputItem } from "./types.ts";

// Tool items are open wire objects: only the members read below are checked.
const toolValidator = compile(
  obj(
    {
      type: str(),
      name: opt(str()),
      allowed_callers: opt(arr(str())),
    },
    { open: true },
  ),
);
const namespaceValidator = compile(
  obj({ type: lit("namespace"), tools: arr(unknown()) }, { open: true }),
);
const asyncExecValidator = compile(
  obj(
    {
      type: oneOf(["custom_tool_call", "function_call"]),
      name: lit("exec"),
      call_id: str(),
      async: lit(true),
    },
    { open: true },
  ),
);

/** Unconsumed automatic generations must not have executed server-hosted actions. */
/** GPT-6 family models (Astra, Sol, Luna) and GPT-6.1 Sol accept mid-turn steering and async tool calls. */
export function supportsNativeResponsesModel(modelId: string | undefined): boolean {
  return modelId !== undefined && /^(?:gpt-6-(?:astra|sol|luna)|gpt-6\.1-sol)$/.test(modelId);
}

export function supportsNativeSteeringTools(body: ResponsesBody): boolean {
  const clientOwned = (tool: ProtocolValue): boolean => {
    if (namespaceValidator.check(tool)) {
      // SAFETY: Namespace children are provider protocol values from the existing tool serializer.
      return (tool.tools as ProtocolValue[]).every(clientOwned);
    }
    return toolValidator.check(tool) && (tool.type === "function" || tool.type === "custom");
  };
  return (body.tools ?? []).every(clientOwned);
}

/** The flag belongs to the direct client exec tool, never hosted PTC or nested calls. */
export function withAsyncCodeMode(body: ResponsesBody, enabled: boolean): ResponsesBody {
  if (!enabled || !supportsNativeResponsesModel(body.model) || !body.tools) return body;
  if (
    body.tools.some(
      (tool) => toolValidator.check(tool) && tool.type === "programmatic_tool_calling",
    )
  )
    return body;
  const decorate = (tool: ProtocolValue): ProtocolValue => {
    if (namespaceValidator.check(tool)) {
      // SAFETY: ResponsesBody tools are already provider protocol values; retain namespace children verbatim except direct exec.
      return { ...tool, tools: (tool.tools as ProtocolValue[]).map(decorate) };
    }
    if (
      toolValidator.check(tool) &&
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
  const ids = items.filter((item) => asyncExecValidator.check(item)).map((item) => item.call_id);
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
