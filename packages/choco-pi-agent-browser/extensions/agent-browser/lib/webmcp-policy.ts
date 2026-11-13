import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { hasRuntimeType, isRecord, type RuntimeValue } from "./parsing.ts";

export const WEBMCP_PARAMS_MAX_BYTES = 1_048_576;
const SENSITIVE_KEY =
  /(?:authorization|cookie|credential|password|secret|token|api[-_]?key|private[-_]?key)/i;

export type WebMcpJson = boolean | null | number | string | WebMcpJson[] | WebMcpJsonObject;
export interface WebMcpJsonObject {
  [key: string]: WebMcpJson;
}

export interface WebMcpOwner {
  frame?: string;
  generation: number;
  namespace?: string;
  session: string;
}

export interface WebMcpInvocationOwnership extends WebMcpOwner {
  invocationId: string;
}

export interface WebMcpParamsPreflight {
  params: WebMcpJsonObject;
  source: "file" | "inline";
  summary: string;
}

function parseJsonValue(value: RuntimeValue): WebMcpJson {
  if (value === null || hasRuntimeType(value, "boolean") || hasRuntimeType(value, "string"))
    return value;
  if (hasRuntimeType(value, "number")) {
    if (!Number.isFinite(value)) throw new Error("WebMCP --params contains a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) return value.map(parseJsonValue);
  if (!isRecord(value)) throw new Error("WebMCP --params contains an unsupported JSON value.");
  const parsed: WebMcpJsonObject = {};
  for (const [key, item] of Object.entries(value)) parsed[key] = parseJsonValue(item);
  return parsed;
}

function parseParamsJson(text: string): WebMcpJsonObject {
  let value: RuntimeValue;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("WebMCP --params must contain valid JSON.");
  }
  if (!isRecord(value) || Array.isArray(value))
    throw new Error("WebMCP --params must be a JSON object.");
  const parsed = parseJsonValue(value);
  if (!isRecord(parsed) || Array.isArray(parsed))
    throw new Error("WebMCP --params must be a JSON object.");
  const object: WebMcpJsonObject = {};
  for (const [key, item] of Object.entries(parsed)) object[key] = parseJsonValue(item);
  return object;
}

export async function preflightWebMcpParams(
  raw: string | undefined,
  cwd: string,
): Promise<WebMcpParamsPreflight> {
  if (raw === undefined) return { params: {}, source: "inline", summary: "WebMCP params: 0 keys." };
  let text = raw;
  let source: "file" | "inline" = "inline";
  if (raw.startsWith("@")) {
    const requestedPath = raw.slice(1);
    if (!requestedPath) throw new Error("WebMCP --params @file path is empty.");
    const absolutePath = resolve(cwd, requestedPath);
    let size: number;
    try {
      size = (await stat(absolutePath)).size;
      if (size > WEBMCP_PARAMS_MAX_BYTES)
        throw new Error(`WebMCP params file exceeds ${WEBMCP_PARAMS_MAX_BYTES} bytes.`);
      text = await readFile(absolutePath, "utf8");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("WebMCP params file exceeds"))
        throw error;
      throw new Error(`Unable to read WebMCP params file '${requestedPath}'.`);
    }
    source = "file";
  }
  if (Buffer.byteLength(text, "utf8") > WEBMCP_PARAMS_MAX_BYTES)
    throw new Error(`WebMCP params exceed ${WEBMCP_PARAMS_MAX_BYTES} bytes.`);
  const params = parseParamsJson(text);
  return {
    params,
    source,
    summary: `WebMCP params: ${Object.keys(params).length} keys (${source}).`,
  };
}

export function redactWebMcpMetadata(value: WebMcpJson): WebMcpJson {
  if (Array.isArray(value)) return value.map(redactWebMcpMetadata);
  if (
    value === null ||
    hasRuntimeType(value, "boolean") ||
    hasRuntimeType(value, "number") ||
    hasRuntimeType(value, "string")
  )
    return value;
  const redacted: WebMcpJsonObject = {};
  for (const [key, item] of Object.entries(value))
    redacted[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactWebMcpMetadata(item);
  return redacted;
}

function sameOwner(left: WebMcpOwner, right: WebMcpOwner): boolean {
  return (
    left.session === right.session &&
    left.namespace === right.namespace &&
    left.frame === right.frame &&
    left.generation === right.generation
  );
}

export class WebMcpInvocationRegistry {
  readonly #pending = new Map<string, WebMcpInvocationOwnership>();

  register(invocation: WebMcpInvocationOwnership): void {
    if (!invocation.invocationId) throw new Error("WebMCP detached invocation ID is empty.");
    if (this.#pending.has(invocation.invocationId))
      throw new Error("WebMCP detached invocation ID is already pending.");
    this.#pending.set(invocation.invocationId, { ...invocation });
  }

  assertOwned(invocationId: string, owner: WebMcpOwner): WebMcpInvocationOwnership {
    const invocation = this.#pending.get(invocationId);
    if (!invocation || !sameOwner(invocation, owner))
      throw new Error("WebMCP invocation is not owned by this session generation and frame.");
    return { ...invocation };
  }

  settle(invocationId: string, owner: WebMcpOwner): void {
    this.assertOwned(invocationId, owner);
    this.#pending.delete(invocationId);
  }

  takeOwned(owner: WebMcpOwner): WebMcpInvocationOwnership[] {
    const owned: WebMcpInvocationOwnership[] = [];
    for (const [id, invocation] of this.#pending) {
      if (!sameOwner(invocation, owner)) continue;
      this.#pending.delete(id);
      owned.push({ ...invocation });
    }
    return owned;
  }
}

export function getWebMcpInvocationId(value: WebMcpJsonObject): string | undefined {
  return hasRuntimeType(value.invocationId, "string") && value.invocationId.length > 0
    ? value.invocationId
    : undefined;
}
