/**
 * Cross-extension RPC handlers for the subagents extension.
 *
 * Exposes ping, spawn, and stop RPCs over the pi.events event bus,
 * using per-request scoped reply channels.
 *
 * Reply envelope follows pi-mono convention:
 *   success → { success: true, data?: T }
 *   error   → { success: false, error: string }
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { type ModelRegistry, resolveModel } from "./model-resolver.ts";

type RpcScalar = string | number | boolean | null;
type RpcWireValue = RpcScalar | RpcWireValue[] | { [key: string]: RpcWireValue };
type RpcWireObject = { [key: string]: RpcWireValue };
type RpcEventPayload = Parameters<Parameters<ExtensionAPI["events"]["on"]>[1]>[0];

/** Minimal event bus interface needed by the RPC handlers. */
export interface EventBus {
  on: ExtensionAPI["events"]["on"];
  emit: ExtensionAPI["events"]["emit"];
}

/** RPC reply envelope — matches pi-mono's RpcResponse shape. */
export type RpcReply<T = void> = { success: true; data?: T } | { success: false; error: string };

/** RPC protocol version — bumped when the envelope or method contracts change. */
export const PROTOCOL_VERSION = 2;

/** Minimal AgentManager interface needed by the spawn/stop RPCs. */
export interface SpawnCapable {
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: string,
    prompt: string,
    options: any,
  ): string;
  abort(id: string): boolean;
}

export interface RpcDeps {
  events: EventBus;
  pi: ExtensionAPI;
  getCtx: () => ExtensionContext | undefined;
  manager: SpawnCapable;
}

export interface RpcHandle {
  unsubPing: () => void;
  unsubSpawn: () => void;
  unsubStop: () => void;
}

interface RpcRequest {
  requestId: string;
}

interface SpawnRpcRequest extends RpcRequest {
  type: string;
  prompt: string;
  options?: RpcWireObject;
}

interface StopRpcRequest extends RpcRequest {
  agentId: string;
}

const RpcStringSchema = Type.String();
const RpcNumberSchema = Type.Number();
const RpcBooleanSchema = Type.Boolean();

function wireObject(value: RpcWireValue): RpcWireObject | undefined {
  if (value === null || Array.isArray(value) || Object(value) !== value) return undefined;
  // SAFETY: RpcWireValue's only non-null, non-array object member is RpcWireObject.
  return value as RpcWireObject;
}

function parseWireValue(input: RpcEventPayload): RpcWireValue {
  if (
    Value.Check(RpcStringSchema, input) ||
    Value.Check(RpcNumberSchema, input) ||
    Value.Check(RpcBooleanSchema, input)
  ) {
    return input;
  }
  if (input === null) return null;
  if (Array.isArray(input)) return input.map(parseWireValue);
  if (Object(input) === input) {
    const parsed: RpcWireObject = {};
    // SAFETY: Object identity and the primitive/array exclusions above establish an ordinary object.
    for (const [key, value] of Object.entries(input as object)) parsed[key] = parseWireValue(value);
    return parsed;
  }
  throw new Error("RPC payload contains an unsupported value");
}

function wireString(value: RpcWireValue | undefined): string | undefined {
  return Value.Check(RpcStringSchema, value) ? value : undefined;
}

function requestId(raw: RpcWireValue): string {
  const id = wireString(wireObject(raw)?.requestId);
  if (!id) throw new Error("RPC requestId must be a non-empty string");
  return id;
}

function parsePingRequest(raw: RpcWireValue): RpcRequest {
  return { requestId: requestId(raw) };
}

function parseSpawnRequest(raw: RpcWireValue): SpawnRpcRequest {
  const object = wireObject(raw);
  const type = wireString(object?.type);
  const prompt = wireString(object?.prompt);
  if (!type || prompt === undefined) throw new Error("Spawn RPC requires string type and prompt");
  const optionsValue = object?.options;
  const options = optionsValue === undefined ? undefined : wireObject(optionsValue);
  if (optionsValue !== undefined && !options)
    throw new Error("Spawn RPC options must be an object");
  return { requestId: requestId(raw), type, prompt, options };
}

function parseStopRequest(raw: RpcWireValue): StopRpcRequest {
  const agentId = wireString(wireObject(raw)?.agentId);
  if (!agentId) throw new Error("Stop RPC requires a non-empty string agentId");
  return { requestId: requestId(raw), agentId };
}

/**
 * Wire a single RPC handler: listen on `channel`, parse its request, run
 * `fn(params)`, and emit the reply on `channel:reply:${requestId}`.
 */
function handleRpc<P extends RpcRequest, R>(
  events: EventBus,
  channel: string,
  parse: (raw: RpcWireValue) => P,
  fn: (params: P) => R | Promise<R>,
): () => void {
  return events.on(channel, async (raw) => {
    let params: P;
    let wire: RpcWireValue | undefined;
    try {
      wire = parseWireValue(raw);
      params = parse(wire);
      const data = await fn(params);
      const reply: RpcReply<R> = { success: true };
      if (data !== undefined) reply.data = data;
      events.emit(`${channel}:reply:${params.requestId}`, reply);
    } catch (err: any) {
      const rawRequestId = wire === undefined ? undefined : wireObject(wire)?.requestId;
      const replyChannelId = wireString(rawRequestId) ?? "invalid";
      events.emit(`${channel}:reply:${replyChannelId}`, {
        success: false,
        error: err?.message ?? String(err),
      });
    }
  });
}

/** Register ping, spawn, and stop RPC handlers on the event bus. */
export function registerRpcHandlers(deps: RpcDeps): RpcHandle {
  const { events, pi, getCtx, manager } = deps;

  const unsubPing = handleRpc(events, "subagents:rpc:ping", parsePingRequest, () => {
    return { version: PROTOCOL_VERSION };
  });

  const unsubSpawn = handleRpc(
    events,
    "subagents:rpc:spawn",
    parseSpawnRequest,
    ({ type, prompt, options }) => {
      const ctx = getCtx();
      if (!ctx) throw new Error("No active session");

      // Cross-extension RPC callers naturally forward a serializable model name.
      // Resolve it to a host Model before passing options to AgentManager.
      let normalizedOptions: any = options ?? {};
      const modelName = wireString(options?.model);
      if (modelName !== undefined) {
        const registry: ModelRegistry = ctx.modelRegistry;
        const resolution = resolveModel(modelName, registry);
        switch (resolution.tag) {
          case "error":
            throw new Error(resolution.message);
          case "resolved":
            normalizedOptions = { ...normalizedOptions, model: resolution.model };
            break;
        }
      }

      return { id: manager.spawn(pi, ctx, type, prompt, normalizedOptions) };
    },
  );

  const unsubStop = handleRpc(events, "subagents:rpc:stop", parseStopRequest, ({ agentId }) => {
    if (!manager.abort(agentId)) throw new Error("Agent not found");
  });

  return { unsubPing, unsubSpawn, unsubStop };
}
