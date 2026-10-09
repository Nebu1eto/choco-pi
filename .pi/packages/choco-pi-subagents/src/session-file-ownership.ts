/**
 * session-file-ownership.ts — process-wide ownership of child session files.
 *
 * Two live writers on one session JSONL corrupt it. A revival (or a resume
 * after /reload) must therefore claim the child file first, and a claim held
 * by an outgoing extension instance must block until that instance releases
 * it. State lives on `globalThis` so it survives module re-import on /reload
 * within the same process; it is validated structurally on every read.
 */

import { resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

const OWNERS_SYMBOL = Symbol.for("choco-pi-subagents:session-file-owners");

const OwnershipRegistrySchema = Type.Object({
  version: Type.Literal(1),
  claim: Type.Function([Type.String(), Type.String()], Type.Boolean()),
  release: Type.Function([Type.String(), Type.String()], Type.Void()),
  owner: Type.Function([Type.String()], Type.Union([Type.String(), Type.Undefined()])),
  /** Register a one-shot release listener; returns its unsubscribe function. */
  onRelease: Type.Function(
    [Type.String(), Type.Function([], Type.Void())],
    Type.Function([], Type.Void()),
  ),
});

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
  const existing: unknown = Object.getOwnPropertyDescriptor(globalThis, OWNERS_SYMBOL)?.value;
  if (Value.Check(OwnershipRegistrySchema, existing)) {
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

/**
 * Claim `file` for `ownerToken`. Returns true when now owned by this token
 * (including an existing claim by the same token), false when another owner
 * holds it. Empty paths or tokens are never claimable.
 */
export function claimSessionFile(file: string, ownerToken: string): boolean {
  if (file === "" || ownerToken === "") return false;
  return registry().claim(key(file), ownerToken);
}

/** Release `file` if `ownerToken` owns it; a non-owner release is ignored. */
export function releaseSessionFile(file: string, ownerToken: string): void {
  if (file === "" || ownerToken === "") return;
  registry().release(key(file), ownerToken);
}

/** Current owner token of `file`, if any. */
export function sessionFileOwner(file: string): string | undefined {
  if (file === "") return undefined;
  return registry().owner(key(file));
}

export type SessionFileWaitOutcome = "released" | "timeout" | "aborted";

/**
 * Wait until `file` has no owner. Resolves "released" immediately when it is
 * unowned. The result is advisory: another claimer may win the file between
 * release and the caller's continuation, so callers must still check
 * `claimSessionFile`'s return value. Settles exactly once and always clears
 * its timer, abort listener, and release listener.
 */
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
