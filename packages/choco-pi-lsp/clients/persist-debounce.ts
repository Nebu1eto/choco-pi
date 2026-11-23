import { isFunction } from "./runtime-guards.ts";

export interface DebounceScheduler<T> {
  schedule(key: string, payload: T): void;
  flush(key: string): void;
  flushAll(): void;
}

export function createDebounceScheduler<T>(args: {
  write: (key: string, payload: T) => void;
  debounceMs: () => number;
}): DebounceScheduler<T> {
  const { write, debounceMs } = args;
  const pending = new Map<string, T>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function flush(key: string): void {
    const payload = pending.get(key);
    if (payload === undefined) return;
    pending.delete(key);
    const timer = timers.get(key);
    if (timer) {
      clearTimeout(timer);
      timers.delete(key);
    }
    write(key, payload);
  }

  function flushAll(): void {
    for (const key of Array.from(pending.keys())) flush(key);
  }

  function schedule(key: string, payload: T): void {
    pending.set(key, payload);
    const debounce = debounceMs();
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    if (debounce === 0) {
      flush(key);
      return;
    }
    const timer = setTimeout(() => flush(key), debounce);

    if (isFunction(timer.unref)) timer.unref();
    timers.set(key, timer);
  }

  return { schedule, flush, flushAll };
}
