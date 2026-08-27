import { Type } from "typebox";
import { Check } from "typebox/value";

const StringSchema = Type.String();
const BooleanSchema = Type.Boolean();
const FunctionSchema = Type.Function([], Type.Unknown());
const RecordSchema = Type.Record(Type.String(), Type.Unknown());

export type RuntimeValue = string | number | boolean | bigint | symbol | object | null | undefined;

export interface RuntimeRecord {
  id?: RuntimeValue;
  type?: RuntimeValue;
  delta?: RuntimeValue;
  description?: RuntimeValue;
  result?: RuntimeValue;
  error?: RuntimeValue;
  workflowId?: RuntimeValue;
  workflowStepId?: RuntimeValue;
  agentTranscriptPath?: RuntimeValue;
  claim?: RuntimeValue;
  resolve?: RuntimeValue;
  event?: RuntimeValue;
  params?: RuntimeValue;
  current?: RuntimeValue;
  serverName?: RuntimeValue;
  message?: RuntimeValue;
  mode?: RuntimeValue;
  url?: RuntimeValue;
  elicitationId?: RuntimeValue;
  requestedSchema?: RuntimeValue;
  action?: RuntimeValue;
  content?: RuntimeValue;
  filePath?: RuntimeValue;
  memoryType?: RuntimeValue;
  loadReason?: RuntimeValue;
  triggerFilePath?: RuntimeValue;
  parentFilePath?: RuntimeValue;
  command?: RuntimeValue;
  file_path?: RuntimeValue;
  path?: RuntimeValue;
}

export function isStringValue<Value>(value: Value): value is Value & string {
  return Check(StringSchema, value);
}

export function isBooleanValue<Value>(value: Value): value is Value & boolean {
  return Check(BooleanSchema, value);
}

export function isFunctionValue<Value>(value: Value): value is Value & CallableFunction {
  return Check(FunctionSchema, value);
}

export function parseRuntimeRecord<Value>(value: Value): RuntimeRecord | undefined {
  if (!Check(RecordSchema, value) || Array.isArray(value)) return undefined;
  // SAFETY: RecordSchema and the array exclusion establish a string-keyed runtime property bag.
  return value as Value & RuntimeRecord;
}
