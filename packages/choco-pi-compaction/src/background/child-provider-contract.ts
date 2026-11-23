import type {
  CompactionEntry,
  ContextUsage,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isObject, type RuntimeValue } from "@choco-pi/shared/runtime-values";
import type { AppendRecord, CoordinatorApi } from "./contract.ts";

/** Global symbol key for publishing the background child compaction provider across jiti `moduleCache: false` evaluations. */
export const CHILD_COMPACTION_PROVIDER_SYMBOL: unique symbol = Symbol.for(
  "choco-pi:compaction-child-provider",
);

/** Lifecycle-scoped context and append hooks passed when attaching a child compaction coordinator. */
export interface ChildCoordinatorContext {
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  readonly childSessionId: string;
  readonly parentSessionId: string | undefined;
  readonly mainSessionFork: boolean;
  readonly readOnly: boolean;
  readonly isolated: boolean;
  readonly sessionManager: ExtensionContext["sessionManager"];
  readonly model: ExtensionContext["model"];
  readonly appendRecord: AppendRecord;
  readonly appendAnchor: () => string;
  readonly signal: AbortSignal;
}

/** Agent execution boundary signal forwarded to an attached child coordinator. */
export interface ChildBoundary {
  readonly kind: "turn_end" | "agent_before_settle";
  readonly contextUsage: ContextUsage | undefined;
}

/** Attached child coordinator handle with optional boundary and commit callbacks. */
export interface ChildCoordinatorAttachment {
  readonly coordinator: CoordinatorApi;
  observeBoundary?(boundary: ChildBoundary): void;
  acknowledgeCommit?(entry: CompactionEntry): void;
}

/** Factory signature implemented by a child compaction provider to attach a coordinator to a child session. */
export type CreateChildCoordinator = (
  context: ChildCoordinatorContext,
) => ChildCoordinatorAttachment | undefined | Promise<ChildCoordinatorAttachment | undefined>;

/** Versioned cross-extension contract for background child-session compaction providers. */
export interface ChildCompactionProvider {
  readonly version: 1;
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

/** Reads and validates the active `ChildCompactionProvider` from the `globalThis` symbol slot. */
export function resolveChildCompactionProvider(): ChildCompactionProvider | undefined {
  const found: RuntimeValue = Object.getOwnPropertyDescriptor(
    globalThis,
    CHILD_COMPACTION_PROVIDER_SYMBOL,
  )?.value;
  return isProvider(found) ? found : undefined;
}

/** Publishes a `ChildCompactionProvider` into the `globalThis` slot and returns an identity-safe disposer. */
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
