import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { SessionLifecycle } from "./session-lifecycle";
import { type BoundaryValue, isNumber, isObjectValue } from "./runtime-values";

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

export class LiveContextController {
  private readonly lifecycle: SessionLifecycle;
  private readonly requestRender: () => void;
  private override: LiveContextOverride | undefined;
  private cancelScheduledRender: (() => void) | undefined;
  private scheduledGeneration: number | undefined;

  constructor(lifecycle: SessionLifecycle, requestRender: () => void) {
    this.lifecycle = lifecycle;
    this.requestRender = requestRender;
  }

  get(): LiveContextOverride | undefined {
    return this.override;
  }

  update(message: BoundaryValue): boolean {
    const next = liveContextFromMessage(message);
    if (!next || !this.lifecycle.isCurrent()) return false;
    this.override = next;
    const generation = this.lifecycle.currentGeneration();
    if (this.cancelScheduledRender && this.scheduledGeneration !== generation) {
      this.cancelScheduledRender = undefined;
      this.scheduledGeneration = undefined;
    }
    if (!this.cancelScheduledRender) {
      this.scheduledGeneration = generation;
      this.cancelScheduledRender = this.lifecycle.defer(() => {
        this.cancelScheduledRender = undefined;
        this.scheduledGeneration = undefined;
        if (this.override) this.requestRender();
      }, 250);
    }
    return true;
  }

  clear(): void {
    this.override = undefined;
    this.cancelScheduledRender?.();
    this.cancelScheduledRender = undefined;
    this.scheduledGeneration = undefined;
  }
}
