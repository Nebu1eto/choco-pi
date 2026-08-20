import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { shortHash } from "./signatures.ts";

type ToolFamily = "function" | "custom" | "search";

type PairedCall = {
  family: ToolFamily;
  id: string;
  index: number;
};

const HistoryRecordType = Type.Record(Type.String(), Type.Unknown());
type HistoryRecord = Static<typeof HistoryRecordType>;
const HistoryRecordSchema = Type.Unsafe<HistoryRecord>({ type: "object" });
const StringSchema = Type.String();

function isRecord<T>(value: T): value is Extract<T, object> & HistoryRecord {
  return Check(HistoryRecordSchema, value);
}

function callId<T>(item: T): string | undefined {
  return isRecord(item) && Check(StringSchema, item["call_id"]) ? item["call_id"] : undefined;
}

function callFamily<T>(item: T): ToolFamily | undefined {
  if (!isRecord(item)) return undefined;
  if (item["type"] === "function_call" || item["type"] === "local_shell_call") return "function";
  if (item["type"] === "custom_tool_call") return "custom";
  if (item["type"] === "tool_search_call") return "search";
  return undefined;
}

function outputFamily<T>(item: T): ToolFamily | undefined {
  if (!isRecord(item)) return undefined;
  if (item["type"] === "function_call_output") return "function";
  if (item["type"] === "custom_tool_call_output") return "custom";
  if (
    item["type"] === "tool_search_output" &&
    item["execution"] !== "server" &&
    Check(StringSchema, item["call_id"])
  )
    return "search";
  return undefined;
}

function syntheticOutputId(prefix: string, call: HistoryRecord): string | undefined {
  const sourceId = call["id"];
  return Check(StringSchema, sourceId) && sourceId !== ""
    ? `${prefix}_${shortHash(`${prefix}:${sourceId}`)}`
    : undefined;
}

interface SyntheticCustomToolOutput {
  type: "custom_tool_call_output";
  id?: string;
  call_id: string;
  output: string;
}
interface SyntheticSearchToolOutput {
  type: "tool_search_output";
  id?: string;
  call_id: string;
  status: "completed";
  execution: "client";
  tools: never[];
}
interface SyntheticFunctionToolOutput {
  type: "function_call_output";
  id?: string;
  call_id: string;
  output: string;
}
type SyntheticToolOutput =
  | SyntheticCustomToolOutput
  | SyntheticSearchToolOutput
  | SyntheticFunctionToolOutput;

function syntheticOutput(call: HistoryRecord, family: ToolFamily, id: string): SyntheticToolOutput {
  if (family === "custom") {
    const outputId = syntheticOutputId("ctco", call);
    const output: SyntheticCustomToolOutput = {
      type: "custom_tool_call_output",
      call_id: id,
      output: "aborted",
    };
    if (outputId) output.id = outputId;
    return output;
  }
  if (family === "search") {
    const outputId = syntheticOutputId("tso", call);
    const output: SyntheticSearchToolOutput = {
      type: "tool_search_output",
      call_id: id,
      status: "completed",
      execution: "client",
      tools: [],
    };
    if (outputId) output.id = outputId;
    return output;
  }
  const outputId = syntheticOutputId("fco", call);
  const output: SyntheticFunctionToolOutput = {
    type: "function_call_output",
    call_id: id,
    output: "aborted",
  };
  if (outputId) output.id = outputId;
  return output;
}

function itemAt<T>(input: T[], index: number): T {
  // SAFETY: Every caller supplies an index from a loop bounded by this same array's length.
  return input[index] as T;
}

/** Keep Responses tool calls and outputs paired after arbitrary history rewrites. */
export function normalizeResponsesToolHistory<T>(input: T[]): (T | SyntheticToolOutput)[] {
  const calls = new Map<string, PairedCall>();
  const validCalls = new Set<number>();
  const droppedCalls = new Set<number>();
  for (let index = 0; index < input.length; index++) {
    const item = itemAt(input, index);
    const family = callFamily(item);
    const id = callId(item);
    if (!family || id === undefined) continue;
    if (id === "" || !isRecord(item) || calls.has(id)) {
      droppedCalls.add(index);
      continue;
    }
    calls.set(id, { family, id, index });
    validCalls.add(index);
  }

  const matchedCalls = new Set<string>();
  const droppedOutputs = new Set<number>();
  for (let index = 0; index < input.length; index++) {
    const item = itemAt(input, index);
    const family = outputFamily(item);
    const id = callId(item);
    if (!family) continue;
    const call = id === undefined ? undefined : calls.get(id);
    if (!call || call.family !== family || call.index >= index || matchedCalls.has(call.id)) {
      droppedOutputs.add(index);
      continue;
    }
    matchedCalls.add(call.id);
  }

  let normalized: (T | SyntheticToolOutput)[] | undefined;
  for (let index = 0; index < input.length; index++) {
    const item = itemAt(input, index);
    const family = callFamily(item);
    const drop = droppedCalls.has(index) || droppedOutputs.has(index);
    if (drop) {
      normalized ??= input.slice(0, index);
      continue;
    }
    if (normalized) normalized.push(item);
    const id = callId(item);
    if (!family || !validCalls.has(index) || !isRecord(item) || id === undefined) continue;
    if (matchedCalls.has(id)) continue;
    normalized ??= input.slice(0, index + 1);
    normalized.push(syntheticOutput(item, family, id));
  }

  return normalized ?? input;
}
