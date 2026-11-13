import type { SessionUpdate } from "@agentclientprotocol/sdk";

/** The two streamed-text update kinds a client concatenates within one rendered block. */
type TextChannel = "agent_message_chunk" | "agent_thought_chunk";

/** Markdown needs two newlines between outputs for them to render as separate paragraphs. */
const PARAGRAPH_NEWLINES = 2;

/** Number of `\n` characters in the whitespace run matched by `pattern` in `text`. */
function newlinesIn(text: string, pattern: RegExp): number {
  const run = pattern.exec(text)?.[0] ?? "";
  let count = 0;
  for (const char of run) if (char === "\n") count += 1;
  return count;
}

/**
 * Keeps distinct outputs visibly separate in the client's thread.
 *
 * ACP clients such as Zed append consecutive `agent_message_chunk` (or
 * `agent_thought_chunk`) updates to one rendered block until another thread entry
 * intervenes, so a notification followed by assistant text reads as one run-on
 * sentence. Every text update passes through `apply` in delivery order; when its
 * source differs from the source of the text it would be appended to, it is prefixed
 * with just enough newlines to start a new Markdown paragraph. Chunks of one source
 * (one streamed Pi assistant message) are never altered.
 *
 * A source is a caller-chosen key. An update without one is a distinct output of its
 * own: adapter notices, warnings, forwarded notifications, and command output.
 */
export class TextBoundary {
  private channel: TextChannel | null = null;
  private source: string | null = null;
  private trailingNewlines = 0;
  private distinctOutputs = 0;

  /** The client opened a new thread entry; the next text starts it without a separator. */
  reset(): void {
    this.channel = null;
    this.source = null;
    this.trailingNewlines = 0;
  }

  /** Return `update` ready for delivery, recording what the client will have rendered. */
  apply(update: SessionUpdate, source?: string): SessionUpdate {
    // A user message or a new tool call becomes its own entry in the client's thread,
    // so the next text opens a new block. Tool call updates edit an existing entry and
    // other updates render outside the message stream; neither changes the open block.
    if (update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "tool_call") {
      this.reset();
      return update;
    }
    if (
      update.sessionUpdate !== "agent_message_chunk" &&
      update.sessionUpdate !== "agent_thought_chunk"
    ) {
      return update;
    }

    const channel = update.sessionUpdate;
    this.distinctOutputs += 1;
    const key = source ?? `distinct:${this.distinctOutputs}`;
    const content = update.content;
    if (content.type !== "text") {
      // Non-text content cannot carry a separator; it still ends the open text run.
      this.channel = channel;
      this.source = key;
      this.trailingNewlines = 0;
      return update;
    }
    // An empty chunk renders nothing and must not move the boundary.
    if (content.text === "") return update;

    let text = content.text;
    // A different channel already renders as its own block (thought versus answer).
    if (this.channel === channel && this.source !== key) {
      const present = this.trailingNewlines + newlinesIn(text, /^[ \t\r\n]*/);
      const missing = PARAGRAPH_NEWLINES - present;
      if (missing > 0) text = "\n".repeat(missing) + text;
    }

    const trailing = newlinesIn(text, /[ \t\r\n]*$/);
    const continues = this.channel === channel && this.source === key;
    this.trailingNewlines =
      continues && text.trim() === "" ? this.trailingNewlines + trailing : trailing;
    this.channel = channel;
    this.source = key;
    if (text === content.text) return update;
    return { ...update, content: { ...content, text } };
  }
}
