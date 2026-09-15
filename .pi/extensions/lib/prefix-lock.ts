export const PREFIX_LOCK_SYMBOL = Symbol.for("choco-pi.prefix.locked");

export interface PrefixLock {
  isLocked: () => boolean;
}

let locked = false;

export function publishPrefixLock(): void {
  const prefixLock: PrefixLock = { isLocked: () => locked };
  Object.defineProperty(globalThis, PREFIX_LOCK_SYMBOL, {
    configurable: true,
    writable: true,
    value: prefixLock,
  });
}

export function isPrefixLocked(): boolean {
  return locked;
}

export function lockPrefix(): void {
  locked = true;
}

export function unlockPrefix(): void {
  locked = false;
}
