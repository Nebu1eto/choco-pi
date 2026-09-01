import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  estimateTokens,
  sessionEntryToContextMessages,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { SessionLifecycle } from "./session-lifecycle.ts";
import { type BoundaryValue, isNumber, isObjectValue } from "./runtime-values.ts";

export type LiveContextOverride = {
  tokens: number;
};

function usageComponent(value: BoundaryValue): number {
  return isNumber(value) && Number.isFinite(value) && value > 0 ? value : 0;
}

export function calculateLiveContextTokens(usage: Usage | undefined): number | undefined {
  if (!usage) return undefined;
  const totalTokens = usageComponent(usage.totalTokens);
  if (totalTokens > 0) return totalTokens;
  const calculated =
    usageComponent(usage.input) +
    usageComponent(usage.output) +
    usageComponent(usage.cacheRead) +
    usageComponent(usage.cacheWrite);
  return calculated > 0 ? calculated : undefined;
}

export function liveContextFromMessage(message: BoundaryValue): LiveContextOverride | undefined {
  if (!message || !isObjectValue(message)) return undefined;
  // SAFETY: the preceding runtime guard validates the members used through this structural view.
  const assistant = message as Partial<AssistantMessage>;
  if (assistant.role !== "assistant") return undefined;
  if (assistant.stopReason === "error" || assistant.stopReason === "aborted") return undefined;
  const tokens = calculateLiveContextTokens(assistant.usage);
  return tokens === undefined ? undefined : { tokens };
}

export function estimateLiveContext(entries: SessionEntry[]): LiveContextOverride | undefined {
  const tokens = entries
    .flatMap(sessionEntryToContextMessages)
    .reduce((total, message) => total + estimateTokens(message), 0);
  return tokens > 0 ? { tokens } : undefined;
}

type LiveContextState = {
  override?: LiveContextOverride;
  cancelScheduledRender?: () => void;
  scheduledGeneration?: number;
};

function setLiveContext(
  state: LiveContextState,
  lifecycle: SessionLifecycle,
  requestRender: () => void,
  next: LiveContextOverride,
): boolean {
  if (!lifecycle.isCurrent()) return false;
  state.override = next;
  const generation = lifecycle.currentGeneration();
  if (state.cancelScheduledRender && state.scheduledGeneration !== generation) {
    state.cancelScheduledRender = undefined;
    state.scheduledGeneration = undefined;
  }
  if (!state.cancelScheduledRender) {
    state.scheduledGeneration = generation;
    state.cancelScheduledRender = lifecycle.defer(() => {
      state.cancelScheduledRender = undefined;
      state.scheduledGeneration = undefined;
      if (state.override) requestRender();
    }, 250);
  }
  return true;
}

export class LiveContextController {
  private readonly lifecycle: SessionLifecycle;
  private readonly requestRender: () => void;
  private readonly state: LiveContextState = {};

  constructor(lifecycle: SessionLifecycle, requestRender: () => void) {
    this.lifecycle = lifecycle;
    this.requestRender = requestRender;
  }

  get(): LiveContextOverride | undefined {
    return this.state.override;
  }

  update(message: BoundaryValue): boolean {
    const next = liveContextFromMessage(message);
    return next ? this.set(next) : false;
  }

  updateAfterCompaction(entries: SessionEntry[]): boolean {
    const next = estimateLiveContext(entries);
    return next ? this.set(next) : false;
  }

  private set(next: LiveContextOverride): boolean {
    return setLiveContext(this.state, this.lifecycle, this.requestRender, next);
  }

  clear(): void {
    this.state.override = undefined;
    this.state.cancelScheduledRender?.();
    this.state.cancelScheduledRender = undefined;
    this.state.scheduledGeneration = undefined;
  }
}
