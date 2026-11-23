export class PathKeyedMap<V> {
  private readonly store = new Map<string, { displayPath: string; value: V }>();
  private readonly normalize: (p: string) => string;

  constructor(normalize: (p: string) => string) {
    this.normalize = normalize;
  }

  get size(): number {
    return this.store.size;
  }

  get(path: string): V | undefined {
    return this.store.get(this.normalize(path))?.value;
  }

  has(path: string): boolean {
    return this.store.has(this.normalize(path));
  }

  set(path: string, value: V): this {
    this.store.set(this.normalize(path), { displayPath: path, value });
    return this;
  }

  delete(path: string): boolean {
    return this.store.delete(this.normalize(path));
  }

  clear(): void {
    this.store.clear();
  }

  *keys(): IterableIterator<string> {
    for (const entry of this.store.values()) yield entry.displayPath;
  }

  *values(): IterableIterator<V> {
    for (const entry of this.store.values()) yield entry.value;
  }

  *entries(): IterableIterator<[string, V]> {
    for (const entry of this.store.values()) yield [entry.displayPath, entry.value];
  }

  forEach(callback: (value: V, path: string, map: this) => void): void {
    for (const entry of this.store.values()) {
      callback(entry.value, entry.displayPath, this);
    }
  }

  [Symbol.iterator](): IterableIterator<[string, V]> {
    return this.entries();
  }
}
