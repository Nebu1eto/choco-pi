import type { Model } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { assistantMessage } from "./fake-sse.ts";
import type { EntryMarker } from "./transport-capture.ts";

/**
 * Per-session marker lists derived from actual branch message text. Lists are
 * mutated in place so holders of `host.markers` see later entries.
 */
export class MarkerBook {
  readonly #managers = new Map<string, SessionManager>();
  readonly #lists = new Map<string, EntryMarker[]>();
  readonly #isCurrent: () => boolean;
  constructor(isCurrent: () => boolean) {
    this.#isCurrent = isCurrent;
  }
  attach(manager: SessionManager): EntryMarker[] {
    const sessionId = manager.getSessionId();
    this.#managers.set(sessionId, manager);
    const list = this.#lists.get(sessionId) ?? [];
    this.#lists.set(sessionId, list);
    return list;
  }
  detach(sessionId: string): void {
    this.#managers.delete(sessionId);
  }
  manager(sessionId: string): SessionManager | undefined {
    return this.#managers.get(sessionId);
  }
  sync(sessionId: string): readonly EntryMarker[] {
    if (!this.#isCurrent()) throw new Error("Capture requested after harness disposal");
    const manager = this.#managers.get(sessionId);
    if (!manager) return [];
    const list = this.#lists.get(sessionId) ?? [];
    for (const entry of manager.getBranch()) addEntryTexts(list, entry);
    return list;
  }
}

function messageTexts(entry: SessionEntry): string[] {
  if (entry.type !== "message" || !("content" in entry.message)) return [];
  const content = entry.message.content;
  if (Value.Check(Type.String(), content)) return content.length > 0 ? [content] : [];
  return content.flatMap((block) =>
    block.type === "text" && block.text.length > 0 ? [block.text] : [],
  );
}

/** String-content entries keep one marker (a seeded unique prefix wins over padded text). */
function isKnown(list: readonly EntryMarker[], entry: SessionEntry, text: string): boolean {
  const stringContent =
    entry.type === "message" &&
    "content" in entry.message &&
    Value.Check(Type.String(), entry.message.content);
  return list.some((item) => item.entryId === entry.id && (stringContent || item.text === text));
}

function addEntryTexts(list: EntryMarker[], entry: SessionEntry): void {
  for (const text of messageTexts(entry))
    if (!isKnown(list, entry, text)) list.push({ entryId: entry.id, text });
}

export interface SeedOptions {
  readonly namespace?: string;
  readonly bytes?: number;
  readonly model: Model<"anthropic-messages">;
}

/** Seeds the frozen prefix through the real SessionManager; returns markers in branch order. */
export function seedPrefix(manager: SessionManager, options: SeedOptions): EntryMarker[] {
  const namespace = options.namespace ?? "SEED";
  const padding = options.bytes
    ? `\n${"offline-prefix-fact\n".repeat(Math.ceil(options.bytes / 20))}`
    : "";
  const [a, b, c] = ["A", "B", "C"].map((part) => `HARNESS-${namespace}-PREFIX-${part}`);
  if (a === undefined || b === undefined || c === undefined)
    throw new Error("Seed markers missing");
  const user = (text: string) =>
    manager.appendMessage({ role: "user", content: text + padding, timestamp: Date.now() });
  const seeded: EntryMarker[] = [
    { entryId: user(a), text: a },
    { entryId: manager.appendMessage(assistantMessage(b + padding, options.model)), text: b },
    { entryId: user(c), text: c },
  ];
  if (!options.bytes) return seeded;
  const complete = `HARNESS-${namespace}-SEED-COMPLETE`;
  seeded.push({
    entryId: manager.appendMessage(assistantMessage(complete, options.model)),
    text: complete,
  });
  return seeded;
}
