export class WriteOrderingGuard<K, T extends number = number> {
  private readonly lastSeen = new Map<K, T>();

  shouldWrite(key: K, token: T | undefined): boolean {
    if (token === undefined) return true;
    const last = this.lastSeen.get(key);
    if (last !== undefined && token < last) return false;
    this.lastSeen.set(key, token);
    return true;
  }

  delete(key: K): void {
    this.lastSeen.delete(key);
  }

  clear(): void {
    this.lastSeen.clear();
  }
}
