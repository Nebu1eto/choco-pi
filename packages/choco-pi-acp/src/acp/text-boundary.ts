import type { SessionUpdate } from "@agentclientprotocol/sdk";

type TextChannel = "agent_message_chunk" | "agent_thought_chunk";

const PARAGRAPH_NEWLINES = 2;

function newlinesIn(text: string, pattern: RegExp): number {
  const run = pattern.exec(text)?.[0] ?? "";
  let count = 0;
  for (const char of run) if (char === "\n") count += 1;
  return count;
}

export class TextBoundary {
  private channel: TextChannel | null = null;
  private source: string | null = null;
  private trailingNewlines = 0;
  private distinctOutputs = 0;

  reset(): void {
    this.channel = null;
    this.source = null;
    this.trailingNewlines = 0;
  }

  apply(update: SessionUpdate, source?: string): SessionUpdate {
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
      this.channel = channel;
      this.source = key;
      this.trailingNewlines = 0;
      return update;
    }
    if (content.text === "") return update;

    let text = content.text;
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
