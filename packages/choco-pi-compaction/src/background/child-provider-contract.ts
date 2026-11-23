import type {
  CompactionEntry,
  ContextUsage,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isObject, type RuntimeValue } from "@choco-pi/shared/runtime-values";
import type { AppendRecord, CoordinatorApi } from "./contract.ts";

/** Global slot the compaction extension publishes its child provider on. */
export const CHILD_COMPACTION_PROVIDER_SYMBOL: unique symbol = Symbol.for(
  "choco-pi:compaction-child-provider",
);

/** Everything a child coordinator may use; no parent session object is reachable from here. */
export interface ChildCoordinatorContext {
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  readonly childSessionId: string;
  readonly parentSessionId: string | undefined;
  readonly mainSessionFork: boolean;
  readonly readOnly: boolean;
  readonly isolated: boolean;
  /** The child's own (read-only) manager; for a /btw fork it is the in-memory fork. */
  readonly sessionManager: ExtensionContext["sessionManager"];
  readonly model: ExtensionContext["model"];
  /** Persists through the child's `pi.appendEntry`; refused after detachment. */
  readonly appendRecord: AppendRecord;
  /**
   * Appends a model-invisible anchor entry through the child's `pi.appendEntry`
   * and returns its entry ID; returns "" (append nothing) after detachment.
   */
  readonly appendAnchor: () => string;
  /** Aborted when the attachment is detached (cancel, timeout, disposal). */
  readonly signal: AbortSignal;
}

export interface ChildBoundary {
  readonly kind: "turn_end" | "agent_before_settle";
  readonly contextUsage: ContextUsage | undefined;
}

/** Returned by the provider: the coordinator plus optional runner-only observation hooks. */
export interface ChildCoordinatorAttachment {
  readonly coordinator: CoordinatorApi;
  /** Synchronous boundary observation (threshold scheduling); never adopts. */
  observeBoundary?(boundary: ChildBoundary): void;
  /** Called once per committed checkpoint this bridge proposed, from the SDK `entry_appended` event. */
  acknowledgeCommit?(entry: CompactionEntry): void;
}

export type CreateChildCoordinator = (
  context: ChildCoordinatorContext,
) => ChildCoordinatorAttachment | undefined | Promise<ChildCoordinatorAttachment | undefined>;

export interface ChildCompactionProvider {
  readonly version: 1;
  /** Background-compaction feature switch, read once per spawn. */
  isEnabled(): boolean;
  createChildCoordinator: CreateChildCoordinator;
}

interface ProviderCandidate {
  version?: RuntimeValue;
  isEnabled?: RuntimeValue;
  createChildCoordinator?: RuntimeValue;
}

function isHostObject(value: RuntimeValue): value is object {
  return isObject(value) && value !== null && !Array.isArray(value);
}

function isProvider<T extends RuntimeValue>(value: T): value is T & ChildCompactionProvider {
  if (!isHostObject(value)) return false;
  const provider: ProviderCandidate = value;
  return (
    provider.version === 1 &&
    provider.isEnabled instanceof Function &&
    provider.createChildCoordinator instanceof Function
  );
}

/** Resolve a published, structurally valid provider; foreign or corrupt slots are ignored. */
export function resolveChildCompactionProvider(): ChildCompactionProvider | undefined {
  const found: RuntimeValue = Object.getOwnPropertyDescriptor(
    globalThis,
    CHILD_COMPACTION_PROVIDER_SYMBOL,
  )?.value;
  return isProvider(found) ? found : undefined;
}

/**
 * Publish the provider; the compaction extension calls this. Returns an
 * unpublish callback that only removes this instance.
 */
export function publishChildCompactionProvider(provider: ChildCompactionProvider): () => void {
  if (!isProvider(provider)) throw new Error("Invalid child compaction provider");
  Object.defineProperty(globalThis, CHILD_COMPACTION_PROVIDER_SYMBOL, {
    value: provider,
    configurable: true,
  });
  return () => {
    const current: RuntimeValue = Object.getOwnPropertyDescriptor(
      globalThis,
      CHILD_COMPACTION_PROVIDER_SYMBOL,
    )?.value;
    if (current === provider) {
      Reflect.deleteProperty(globalThis, CHILD_COMPACTION_PROVIDER_SYMBOL);
    }
  };
}
