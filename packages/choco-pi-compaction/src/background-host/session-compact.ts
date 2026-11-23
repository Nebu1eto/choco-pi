import {
  AgentSession,
  type CompactionResult,
  type PromptOptions,
} from "@earendil-works/pi-coding-agent";

import {
  hasMethods,
  hasProperty,
  isBoolean,
  isFunction,
  isString,
  readProperty,
} from "../guards.ts";
import { isStaleContextError } from "@choco-pi/shared/lifecycle";

const BRIDGE_SYMBOL: unique symbol = Symbol.for("choco-pi:compaction-session-compact-bridge:v1");

export interface SessionCompactHost {
  readonly sessionId: string;
  readonly isIdle: boolean;
}

export type SessionCompactOutcome = "handled" | "declined" | "stale";

export type SessionCompactDefer = (
  host: SessionCompactHost,
  customInstructions?: string,
) => Promise<SessionCompactOutcome>;

type CompactMethod = (
  this: AgentSession,
  customInstructions?: string,
) => Promise<CompactionResult | undefined>;

type PromptMethod = (this: AgentSession, text: string, options?: PromptOptions) => Promise<void>;

const PROMPT_METHOD = "prompt";

interface PromptPatch {
  readonly original: PromptMethod;
  readonly patched: PromptMethod;
  readonly writable: boolean;
  readonly enumerable: boolean;
  readonly configurable: boolean;
}

interface SessionCompactBridge {
  readonly original: CompactMethod;
  readonly patched: CompactMethod;
  readonly defers: Set<SessionCompactDefer>;
  readonly prompt: PromptPatch | undefined;
}

interface SessionCompactPrototype {
  compact: CompactMethod;
}

function isPromptPatch<T>(value: T): value is T & PromptPatch {
  return (
    hasMethods(value, ["original", "patched"]) &&
    isBoolean(readProperty(value, "writable")) &&
    isBoolean(readProperty(value, "enumerable")) &&
    isBoolean(readProperty(value, "configurable"))
  );
}

function isBridge<T>(value: T): value is T & SessionCompactBridge {
  const prompt = readProperty(value, "prompt");
  return (
    hasProperty(value, "prompt") &&
    hasMethods(value, ["original", "patched"]) &&
    readProperty(value, "defers") instanceof Set &&
    (prompt === undefined || isPromptPatch(prompt))
  );
}

function hostPrototype(): SessionCompactPrototype {
  const prototype: object = AgentSession.prototype;
  // SAFETY: `AgentSession.prototype.compact` is a method taking optional
  return prototype as SessionCompactPrototype;
}

function readBridge(): SessionCompactBridge | undefined {
  const found: unknown = Object.getOwnPropertyDescriptor(globalThis, BRIDGE_SYMBOL)?.value;
  return isBridge(found) ? found : undefined;
}

function readScalars(session: AgentSession): SessionCompactHost | undefined {
  const scalars = { sessionId: session.sessionId, isIdle: session.isIdle };
  return isString(scalars.sessionId) && isBoolean(scalars.isIdle) ? scalars : undefined;
}

function isCommandFirst(text: string, options: PromptOptions | undefined): boolean {
  return (options?.expandPromptTemplates ?? true) && text.startsWith("/");
}

function compactionBlocksPrompt(session: AgentSession): boolean {
  return session.isCompacting && !session.isStreaming;
}

async function promptWhenCompacted(
  session: AgentSession,
  original: PromptMethod,
  text: string,
  options: PromptOptions | undefined,
): Promise<void> {
  while (compactionBlocksPrompt(session)) await session.waitForIdle();
  return original.call(session, text, options);
}

function installPromptPatch(): PromptPatch | undefined {
  const prototype: object = AgentSession.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, PROMPT_METHOD);
  const found = {
    value: descriptor?.value,
    writable: descriptor?.writable,
    enumerable: descriptor?.enumerable,
    configurable: descriptor?.configurable,
  };
  const { value, writable, enumerable, configurable } = found;
  if (!isFunction(value) || !isBoolean(writable) || !isBoolean(enumerable)) return undefined;
  if (configurable !== true) return undefined;
  const original: PromptMethod = AgentSession.prototype.prompt;
  const patched: PromptMethod = function promptAfterCompaction(
    this: AgentSession,
    text: string,
    options?: PromptOptions,
  ): Promise<void> {
    if (isCommandFirst(text, options) || !compactionBlocksPrompt(this)) {
      return original.call(this, text, options);
    }
    return promptWhenCompacted(this, original, text, options);
  };
  Object.defineProperty(prototype, PROMPT_METHOD, {
    value: patched,
    writable,
    enumerable,
    configurable: true,
  });
  return {
    original,
    patched,
    writable,
    enumerable,
    configurable,
  };
}

function promptStillOurs(prompt: PromptPatch | undefined): boolean {
  if (prompt === undefined) return true;
  const prototype: object = AgentSession.prototype;
  return Object.getOwnPropertyDescriptor(prototype, PROMPT_METHOD)?.value === prompt.patched;
}

function restorePromptPatch(prompt: PromptPatch | undefined): void {
  if (prompt === undefined) return;
  Object.defineProperty(AgentSession.prototype, PROMPT_METHOD, {
    value: prompt.original,
    writable: prompt.writable,
    enumerable: prompt.enumerable,
    configurable: prompt.configurable,
  });
}

async function offer(
  bridge: SessionCompactBridge,
  session: AgentSession,
  host: SessionCompactHost,
  customInstructions: string | undefined,
): Promise<SessionCompactOutcome> {
  for (const current of bridge.defers) {
    let outcome: SessionCompactOutcome;
    try {
      outcome = await current(host, customInstructions);
    } catch (cause) {
      if (!(cause instanceof Error && isStaleContextError(cause))) throw cause;
      outcome = "stale";
    }
    if (outcome !== "declined") return outcome;
    if (readScalars(session)?.sessionId !== host.sessionId) return "stale";
  }
  return "declined";
}

export function installSessionCompactBridge(defer: SessionCompactDefer): void {
  const existing = readBridge();
  if (existing !== undefined) {
    existing.defers.add(defer);
    return;
  }
  const prototype = hostPrototype();
  const original = prototype.compact;
  const defers = new Set<SessionCompactDefer>([defer]);
  const patched: CompactMethod = async function patchedCompact(
    this: AgentSession,
    customInstructions?: string,
  ): Promise<CompactionResult | undefined> {
    const host = readScalars(this);
    if (host === undefined) return original.call(this, customInstructions);
    const outcome = await offer(bridge, this, host, customInstructions);
    if (outcome !== "declined") return undefined;
    return original.call(this, customInstructions);
  };
  const bridge: SessionCompactBridge = {
    original,
    patched,
    defers,
    prompt: installPromptPatch(),
  };
  Object.defineProperty(globalThis, BRIDGE_SYMBOL, {
    configurable: true,
    writable: true,
    value: bridge,
  });
  prototype.compact = patched;
}

export function releaseSessionCompactBridge(defer: SessionCompactDefer): void {
  const bridge = readBridge();
  if (bridge === undefined) return;
  bridge.defers.delete(defer);
  if (bridge.defers.size > 0) return;
  const prototype = hostPrototype();
  if (prototype.compact !== bridge.patched || !promptStillOurs(bridge.prompt)) return;
  restorePromptPatch(bridge.prompt);
  prototype.compact = bridge.original;
  Reflect.deleteProperty(globalThis, BRIDGE_SYMBOL);
}

export function liveSessionCompactDefers(): number {
  return readBridge()?.defers.size ?? 0;
}
