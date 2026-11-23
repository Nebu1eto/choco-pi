export const MENTION_TRIGGER = /(^|[\s。、？！])@([\w-]*)$/;

const MENTION_SEND = /^@([\w-]+)\s+([\s\S]+)$/;

const MAX_HANDLE_LENGTH = 64;

const RESERVED_HANDLES: ReadonlySet<string> = new Set(["main"]);

export function isReservedHandle(handle: string): boolean {
  return RESERVED_HANDLES.has(handle.toLowerCase());
}

export function handleBase(type: string): string {
  const slug = type
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_HANDLE_LENGTH)
    .replace(/-+$/, "");
  return slug || "agent";
}

export function assignHandle(base: string, taken: ReadonlySet<string>): string {
  let candidate = base;
  let n = 1;
  while (taken.has(candidate) || RESERVED_HANDLES.has(candidate)) {
    n++;
    candidate = `${base}-${n}`;
  }
  return candidate;
}

export function resolveHandleToType(handle: string, types: readonly string[]): string | undefined {
  const wanted = handle.toLowerCase();
  if (RESERVED_HANDLES.has(wanted)) return undefined;
  return types.find((type) => handleBase(type) === wanted);
}

export function stripAgentPrefix(handle: string): string | undefined {
  const rest = /^agent-(.+)$/i.exec(handle)?.[1];
  return rest || undefined;
}

export function describeMention(message: string): string {
  const oneLine = message.split("\n", 1)[0].replace(/\s+/g, " ").trim();
  return oneLine.length > 40 ? `${oneLine.slice(0, 39).trimEnd()}…` : oneLine;
}

export function agentMentionReminder(type: string): string {
  return `<system-reminder>\nThe user has expressed a desire to invoke the agent "${type}". Please invoke the agent appropriately, passing in the required context to it. \n</system-reminder>`;
}

export function parseMention(text: string): { handle: string; message: string } | null {
  const match = MENTION_SEND.exec(text);
  if (!match) return null;
  const message = match[2].trim();
  return message ? { handle: match[1], message } : null;
}
