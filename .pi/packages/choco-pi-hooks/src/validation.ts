import { compile, str } from "@earendil-works/pi-schema";

// The repo lint rule forbids `typeof`; primitive strings are checked through pi-schema.
const stringCheck = compile(str()).check;

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
  return stringCheck(value);
}

export function isBooleanValue<Value>(value: Value): value is Value & boolean {
  return value === true || value === false;
}

export function isFunctionValue<Value>(value: Value): value is Value & CallableFunction {
  return value instanceof Function;
}

export function parseRuntimeRecord<Value>(value: Value): RuntimeRecord | undefined {
  // Non-null, non-function objects other than arrays form a string-keyed property bag.
  if (Object(value) !== value || value instanceof Function || Array.isArray(value)) {
    return undefined;
  }
  // SAFETY: the object and array exclusions establish a string-keyed runtime property bag.
  return value as Value & RuntimeRecord;
}
