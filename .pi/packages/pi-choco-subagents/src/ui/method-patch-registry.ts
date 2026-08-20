export const SUBAGENT_METHOD_PATCH_REGISTRY = Symbol.for("pi-choco-subagents.method-patch-registry");

type PatchAdapter = "focused-conversation-render" | "focused-editor-input";
type PatchMethod = "render" | "handleInput";
type Method = (this: unknown, ...args: unknown[]) => unknown;

type PatchInvocation = {
  predecessor: Method;
  receiver: unknown;
  args: unknown[];
};

type PatchBehavior = (invocation: PatchInvocation) => unknown;

type PatchRecord = {
  method: PatchMethod;
  predecessor: Method;
  predecessorDescriptor?: PropertyDescriptor;
  wrapper: Method;
  behavior?: PatchBehavior;
};

type PatchRegistry = Map<PatchAdapter, PatchRecord>;
type PatchTarget = Record<PropertyKey, unknown>;

function registryFor(target: PatchTarget): PatchRegistry {
  const existing = target[SUBAGENT_METHOD_PATCH_REGISTRY];
  if (existing instanceof Map) return existing as PatchRegistry;
  const registry: PatchRegistry = new Map();
  Object.defineProperty(target, SUBAGENT_METHOD_PATCH_REGISTRY, {
    value: registry,
    configurable: true,
  });
  return registry;
}

function installWrapper(target: PatchTarget, record: PatchRecord): void {
  const descriptor = record.predecessorDescriptor;
  if (descriptor && "value" in descriptor) {
    Object.defineProperty(target, record.method, { ...descriptor, value: record.wrapper });
    return;
  }
  Object.defineProperty(target, record.method, {
    value: record.wrapper,
    writable: true,
    enumerable: descriptor?.enumerable ?? false,
    configurable: true,
  });
}

/**
 * Add an instance-scoped method adapter without discarding an adapter already
 * installed by another extension. Cleanup restores only while this wrapper is
 * still outermost; if another adapter wrapped it later, cleanup merely
 * deactivates this behavior so the newer adapter remains intact.
 */
export function installMethodPatch(
  targetValue: object,
  method: PatchMethod,
  adapter: PatchAdapter,
  behavior: PatchBehavior,
): () => void {
  const target = targetValue as PatchTarget;
  const registry = registryFor(target);
  const predecessor = target[method];
  if (typeof predecessor !== "function") {
    if (registry.size === 0) delete target[SUBAGENT_METHOD_PATCH_REGISTRY];
    throw new TypeError(`Cannot patch ${method}: predecessor is not a function`);
  }

  const record: PatchRecord = {
    method,
    predecessor: predecessor as Method,
    predecessorDescriptor: Object.getOwnPropertyDescriptor(target, method),
    wrapper: () => undefined,
    behavior,
  };
  record.wrapper = function subagentMethodPatch(this: unknown, ...args: unknown[]): unknown {
    const active = record.behavior;
    return active
      ? active({ predecessor: record.predecessor, receiver: this, args })
      : Reflect.apply(record.predecessor, this, args);
  };

  installWrapper(target, record);
  registry.set(adapter, record);

  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    record.behavior = undefined;
    if (registry.get(adapter) !== record) return;

    if (target[method] === record.wrapper) {
      if (record.predecessorDescriptor) {
        Object.defineProperty(target, method, record.predecessorDescriptor);
      } else {
        delete target[method];
      }
    }
    registry.delete(adapter);
    if (registry.size === 0) delete target[SUBAGENT_METHOD_PATCH_REGISTRY];
  };
}
