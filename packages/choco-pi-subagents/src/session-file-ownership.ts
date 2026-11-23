import { resolve } from "node:path";
import { type HostValue, isHostObject } from "./value-guards.ts";

const OWNERS_SYMBOL = Symbol.for("choco-pi-subagents:session-file-owners");

interface OwnershipRegistryCandidate {
  version?: HostValue;
  claim?: HostValue;
  release?: HostValue;
  owner?: HostValue;
  onRelease?: HostValue;
}

function isOwnershipRegistry(value: HostValue): value is OwnershipRegistry {
  if (!isHostObject(value)) return false;
  const candidate: OwnershipRegistryCandidate = value;
  return (
    candidate.version === 1 &&
    candidate.claim instanceof Function &&
    candidate.release instanceof Function &&
    candidate.owner instanceof Function &&
    candidate.onRelease instanceof Function
  );
}

interface OwnershipRegistry {
  version: 1;
  claim(file: string, ownerToken: string): boolean;
  release(file: string, ownerToken: string): void;
  owner(file: string): string | undefined;
  onRelease(file: string, listener: () => void): () => void;
}

function createRegistry(): OwnershipRegistry {
  const owners = new Map<string, string>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    version: 1,
    claim(file, ownerToken) {
      const current = owners.get(file);
      if (current !== undefined) return current === ownerToken;
      owners.set(file, ownerToken);
      return true;
    },
    release(file, ownerToken) {
      if (owners.get(file) !== ownerToken) return;
      owners.delete(file);
      const pending = listeners.get(file);
      listeners.delete(file);
      pending?.forEach((listener) => listener());
    },
    owner: (file) => owners.get(file),
    onRelease(file, listener) {
      let set = listeners.get(file);
      if (set === undefined) {
        set = new Set();
        listeners.set(file, set);
      }
      set.add(listener);
      return () => {
        const current = listeners.get(file);
        if (current === undefined) return;
        current.delete(listener);
        if (current.size === 0) listeners.delete(file);
      };
    },
  };
}

function registry(): OwnershipRegistry {
  const existing: HostValue = Object.getOwnPropertyDescriptor(globalThis, OWNERS_SYMBOL)?.value;
  if (isOwnershipRegistry(existing)) {
    return {
      version: 1,
      claim: (file, ownerToken) => existing.claim(file, ownerToken),
      release: (file, ownerToken) => existing.release(file, ownerToken),
      owner: (file) => existing.owner(file),
      onRelease: (file, listener) => existing.onRelease(file, listener),
    };
  }
  const created = createRegistry();
  Object.defineProperty(globalThis, OWNERS_SYMBOL, {
    configurable: true,
    writable: true,
    value: created,
  });
  return created;
}

function key(file: string): string {
  return resolve(file);
}

export function claimSessionFile(file: string, ownerToken: string): boolean {
  if (file === "" || ownerToken === "") return false;
  return registry().claim(key(file), ownerToken);
}

export function releaseSessionFile(file: string, ownerToken: string): void {
  if (file === "" || ownerToken === "") return;
  registry().release(key(file), ownerToken);
}

export function sessionFileOwner(file: string): string | undefined {
  if (file === "") return undefined;
  return registry().owner(key(file));
}

export type SessionFileWaitOutcome = "released" | "timeout" | "aborted";

export function waitForSessionFileRelease(
  file: string,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<SessionFileWaitOutcome> {
  const path = key(file);
  const owners = registry();
  if (owners.owner(path) === undefined) return Promise.resolve("released");
  const signal = options.signal;
  if (signal?.aborted === true) return Promise.resolve("aborted");
  return new Promise((settleWith) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const onAbort = (): void => finish("aborted");
    function finish(outcome: SessionFileWaitOutcome): void {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe?.();
      signal?.removeEventListener("abort", onAbort);
      settleWith(outcome);
    }
    unsubscribe = owners.onRelease(path, () => finish("released"));
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish("timeout"), Math.max(0, options.timeoutMs));
  });
}
