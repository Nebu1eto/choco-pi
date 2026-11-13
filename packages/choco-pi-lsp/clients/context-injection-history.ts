import { createHash } from "node:crypto";

export interface ContextInjectionMessage {
  role: string;
  content: unknown;
}

interface InjectionState<Message> {
  baseLength: number;
  baseHash: string;
  batches: Array<{ index: number; messages: Message[] }>;
}

function contentHash(messages: readonly ContextInjectionMessage[]): string {
  const hash = createHash("sha256");
  for (const message of messages) {
    hash.update(JSON.stringify([message.role, message.content]));
    hash.update("\n");
  }
  return hash.digest("hex");
}

/** Retain delivered guidance at its original position until the agent run ends. */
export class ContextInjectionHistory<Message extends ContextInjectionMessage> {
  private sessions = new Map<string, InjectionState<Message>>();

  clear(sessionId: string | undefined): void {
    if (sessionId) this.sessions.delete(sessionId);
  }

  apply(
    sessionId: string | undefined,
    messages: Message[],
    additions: Message[] = [],
    beforeFinal = false,
  ): Message[] {
    const index = beforeFinal && messages.length > 0 ? messages.length - 1 : messages.length;
    if (!sessionId) {
      return additions.length === 0
        ? messages
        : [...messages.slice(0, index), ...additions, ...messages.slice(index)];
    }
    let state = this.sessions.get(sessionId);
    if (
      state &&
      (messages.length < state.baseLength ||
        contentHash(messages.slice(0, state.baseLength)) !== state.baseHash)
    ) {
      // Compaction, rewind, or a real context rewrite must not resurrect old guidance.
      this.sessions.delete(sessionId);
      state = undefined;
    }
    if (!state && additions.length === 0) return messages;
    state ??= { baseLength: 0, baseHash: "", batches: [] };
    state.baseLength = messages.length;
    state.baseHash = contentHash(messages);
    if (additions.length > 0) {
      state.batches.push({ index, messages: structuredClone(additions) });
      state.batches.sort((left, right) => left.index - right.index);
    }
    this.sessions.set(sessionId, state);

    const result: Message[] = [];
    let batchIndex = 0;
    for (let i = 0; i <= messages.length; i++) {
      while (state.batches[batchIndex]?.index === i) {
        result.push(...structuredClone(state.batches[batchIndex]!.messages));
        batchIndex++;
      }
      if (i < messages.length) result.push(messages[i]!);
    }
    return result;
  }
}
