export interface RenderCache<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  delete(key: K): void;
  clear(): void;
}

export function createRenderCache<K, V>(maxEntries = 200): RenderCache<K, V> {
  const cache = new Map<K, V>();

  return {
    get(key) {
      const value = cache.get(key);
      if (value === undefined) return undefined;

      cache.delete(key);
      cache.set(key, value);

      return value;
    },

    set(key, value) {
      if (cache.has(key)) {
        cache.delete(key);
      }

      cache.set(key, value);

      if (cache.size > maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) {
          cache.delete(oldest);
        }
      }
    },

    delete(key) {
      cache.delete(key);
    },

    clear() {
      cache.clear();
    },
  };
}
