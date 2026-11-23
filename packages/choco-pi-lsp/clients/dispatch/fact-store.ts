import { normalizeMapKey } from "../path-utils.ts";

export interface ReadonlyFactStore {
  getFileFact<T>(filePath: string, factId: string): T | undefined;
  hasFileFact(filePath: string, factId: string): boolean;
  getSessionFact<T>(factId: string): T | undefined;
  hasSessionFact(factId: string): boolean;
}

export class FactStore implements ReadonlyFactStore {
  private readonly fileFacts = new Map<string, Map<string, unknown>>();
  private readonly sessionFacts = new Map<string, unknown>();

  getFileFact<T>(filePath: string, factId: string): T | undefined {
    // SAFETY: Fact IDs pair each producer with consumers that request the producer's stored type.
    return this.fileFacts.get(normalizeMapKey(filePath))?.get(factId) as T | undefined;
  }

  setFileFact<T>(filePath: string, factId: string, value: T): void {
    const key = normalizeMapKey(filePath);
    let facts = this.fileFacts.get(key);
    if (!facts) {
      facts = new Map();
      this.fileFacts.set(key, facts);
    }
    facts.set(factId, value);
  }

  hasFileFact(filePath: string, factId: string): boolean {
    return this.fileFacts.get(normalizeMapKey(filePath))?.has(factId) ?? false;
  }

  deleteFileFact(filePath: string, factId: string): void {
    const key = normalizeMapKey(filePath);
    const facts = this.fileFacts.get(key);
    if (!facts) return;
    facts.delete(factId);
    if (facts.size === 0) this.fileFacts.delete(key);
  }

  clearFileFactsFor(filePath: string): void {
    this.fileFacts.delete(normalizeMapKey(filePath));
  }

  clearFileFacts(): void {
    this.fileFacts.clear();
  }

  getSessionFact<T>(factId: string): T | undefined {
    // SAFETY: Session fact IDs pair each producer with consumers that request the stored type.
    return this.sessionFacts.get(factId) as T | undefined;
  }

  setSessionFact<T>(factId: string, value: T): void {
    this.sessionFacts.set(factId, value);
  }

  hasSessionFact(factId: string): boolean {
    return this.sessionFacts.has(factId);
  }

  clearAll(): void {
    this.fileFacts.clear();
    this.sessionFacts.clear();
  }
}
