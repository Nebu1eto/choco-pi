import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import type { AgentManager } from "../agent-manager.ts";
import { handleBase, MENTION_TRIGGER } from "../mention.ts";
import type { AgentRecord, AgentTombstone } from "../types.ts";

export type MentionTarget =
  | { kind: "record"; handle: string; record: AgentRecord; typeLabel: string }
  | { kind: "tombstone"; handle: string; entry: AgentTombstone; typeLabel: string }
  | { kind: "type"; handle: string; type: string; description: string };

export type TypeInfo = { name: string; description: string };

export function mentionRoster(
  manager: AgentManager,
  types: readonly TypeInfo[],
  displayNameOf: (type: string) => string = (type) => type,
): MentionTarget[] {
  const live = (r: AgentRecord) => r.status === "running" || r.status === "queued";
  const records = manager
    .listAgents()
    .filter((r) => r.handle !== undefined && r.parentAgentId === undefined)
    .sort((a, b) => Number(live(b)) - Number(live(a)) || a.startedAt - b.startedAt);

  const taken = new Set<string>();
  const targets: MentionTarget[] = [];

  for (const record of records) {
    const handle = record.alias ?? record.handle!;
    taken.add(handle.toLowerCase());
    if (record.handle) taken.add(record.handle.toLowerCase());
    targets.push({ kind: "record", handle, record, typeLabel: displayNameOf(record.type) });
  }

  for (const entry of manager.listTombstones()) {
    const handle = entry.alias ?? entry.handle;
    if (taken.has(handle.toLowerCase())) continue;
    taken.add(handle.toLowerCase());
    taken.add(entry.handle.toLowerCase());
    targets.push({ kind: "tombstone", handle, entry, typeLabel: displayNameOf(entry.type) });
  }

  for (const type of types) {
    const handle = handleBase(type.name);
    if (taken.has(handle)) continue;
    taken.add(handle);
    targets.push({ kind: "type", handle, type: type.name, description: type.description });
  }
  return targets;
}

export function createMentionProvider(
  current: AutocompleteProvider,
  roster: () => MentionTarget[],
  isEnabled: () => boolean,
): AutocompleteProvider {
  let warnedInnerFailure = false;
  return {
    triggerCharacters: ["@"],

    async getSuggestions(
      lines,
      cursorLine,
      cursorCol,
      options,
    ): Promise<AutocompleteSuggestions | null> {
      const mine = isEnabled() ? mentionItems(roster(), lines[cursorLine] ?? "", cursorCol) : null;
      let theirs: AutocompleteSuggestions | null = null;
      try {
        theirs = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      } catch (err) {
        if (!warnedInnerFailure) {
          warnedInnerFailure = true;
          console.warn(
            "[choco-pi-subagents] the autocomplete provider below us failed; showing agent rows only:",
            err,
          );
        }
        theirs = null;
      }
      if (!mine) return theirs;
      if (!theirs) return mine;
      return { items: [...mine.items, ...theirs.items], prefix: mine.prefix };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

function mentionItems(
  roster: MentionTarget[],
  line: string,
  cursorCol: number,
): AutocompleteSuggestions | null {
  const match = MENTION_TRIGGER.exec(line.slice(0, cursorCol));
  if (!match) return null;

  const typed = match[2].toLowerCase();
  const items: AutocompleteItem[] = [];
  for (const target of roster) {
    if (!target.handle.toLowerCase().startsWith(typed)) continue;
    items.push({
      value: `@${target.handle}`,
      label: `@${target.handle}`,
      description: describeTarget(target),
    });
  }
  return items.length > 0 ? { items, prefix: `@${match[2]}` } : null;
}

function describeTarget(target: MentionTarget): string {
  if (target.kind === "type") return `start agent · ${summarize(target.description)}`;
  if (target.kind === "tombstone") {
    return `resume · ${target.typeLabel} · ${target.entry.description}`;
  }
  const { status, description, alias } = target.record;
  const action = status === "running" || status === "queued" ? "send message" : "resume";
  const identity = alias ? `${target.typeLabel} · ` : "";
  return `${action} · ${identity}${status} · ${description}`;
}

function summarize(description: string): string {
  const first = (description.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? description)
    .replace(/\s+/g, " ")
    .trim();
  return first.length > 60 ? `${first.slice(0, 59).trimEnd()}…` : first;
}
