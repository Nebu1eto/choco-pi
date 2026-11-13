import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { type BoundaryRecord, type BoundaryValue, isString } from "../boundary.ts";
import { decodePiCommands, type PiCommandInfo } from "../pi-rpc/protocol.ts";

export type PiCommandSource = "extension" | "prompt" | "skill";
export type CommandSource = PiCommandSource | "builtin";

/** One entry of Pi's `get_commands` payload, decoded at the RPC boundary. */
export type PiRpcCommandInfo = PiCommandInfo;

export type CommandCatalogEntry = {
  name: string;
  description: string;
  source: CommandSource;
  location?: string;
  path?: string;
};

export type CommandCatalogSnapshot = {
  entries: readonly CommandCatalogEntry[];
  availableCommands: readonly AvailableCommand[];
};

/** Where a discovered command came from, once both shapes Pi emits are reconciled. */
type CommandSourceDetails = {
  location?: string;
  path?: string;
};

/** Adapter-side filters applied while building a catalog. */
export type CommandCatalogOptions = {
  enableSkillCommands?: boolean;
};

/** Adapter-side filters applied by the legacy `get_commands` mapper. */
export type LegacyCommandMappingOptions = {
  enableSkillCommands?: boolean;
  includeExtensionCommands?: boolean;
};

/** Result of the legacy `get_commands` mapper. */
export type LegacyCommandMapping = {
  commands: AvailableCommand[];
  raw: PiRpcCommandInfo[];
};

/** The advertised command list a client last received, with its catalog revision. */
export type CommandCatalogView = {
  revision: number;
  availableCommands: readonly AvailableCommand[];
};

const SOURCE_PRECEDENCE = {
  extension: 0,
  prompt: 1,
  skill: 2,
  builtin: 3,
} satisfies Record<CommandSource, number>;

function stringValue(value: BoundaryValue): string | undefined {
  if (!isString(value)) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** Normalize a discovered or invoked slash name without changing Pi's case-sensitive identity. */
export function canonicalCommandName(value: string): string | null {
  const trimmed = value.trim();
  const withoutSlash = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  if (!withoutSlash || withoutSlash.includes("/") || /\s/.test(withoutSlash)) return null;
  return withoutSlash;
}

function commandSource(command: PiRpcCommandInfo): PiCommandSource | null {
  const source = stringValue(command.source);
  if (source === "extension" || source === "prompt" || source === "skill") return source;
  return null;
}

function sourceDetails(command: PiRpcCommandInfo): CommandSourceDetails {
  const sourceInfo = command.sourceInfo;
  const location = stringValue(sourceInfo?.location) ?? stringValue(command.location);
  const path = stringValue(sourceInfo?.path) ?? stringValue(command.path);

  const details: CommandSourceDetails = {};
  if (location) details.location = location;
  if (path) details.path = path;
  return details;
}

function describeFallback(command: PiRpcCommandInfo): string {
  const source = stringValue(command.source);
  const { location } = sourceDetails(command);
  const parts = [source, location].filter((part): part is string => Boolean(part));
  return parts.length ? `(${parts.join(":")})` : "(command)";
}

function rawPiCommands(data: BoundaryValue): PiRpcCommandInfo[] {
  return decodePiCommands(data).commands;
}

function availableCommand(entry: CommandCatalogEntry): AvailableCommand {
  const command: BoundaryRecord = { source: entry.source };
  if (entry.location) command.location = entry.location;
  if (entry.path) command.path = entry.path;

  return {
    name: entry.name,
    description: entry.description,
    _meta: {
      piAcp: { command },
    },
  };
}

/**
 * Build the authoritative command catalog for one live Pi session.
 *
 * Pi-discovered commands always beat adapter-owned builtins. If malformed Pi data
 * contains cross-source duplicates, resolution follows Pi's dispatch order:
 * extension, prompt template, skill, then adapter builtin.
 */
export function buildCommandCatalog(
  data: BoundaryValue,
  adapterBuiltins: readonly AvailableCommand[],
  opts?: CommandCatalogOptions,
): CommandCatalogSnapshot {
  const enableSkillCommands = opts?.enableSkillCommands ?? true;
  const candidates: CommandCatalogEntry[] = [];

  for (const command of rawPiCommands(data)) {
    const source = commandSource(command);
    const name = command.name === undefined ? null : canonicalCommandName(command.name);
    if (!source || !name) continue;
    if (source === "skill" && !enableSkillCommands) continue;

    const description = stringValue(command.description) ?? describeFallback(command);
    candidates.push({ name, description, source, ...sourceDetails(command) });
  }

  for (const builtin of adapterBuiltins) {
    const name = canonicalCommandName(builtin.name);
    if (!name) continue;
    candidates.push({
      name,
      description: stringValue(builtin.description) ?? "(builtin command)",
      source: "builtin",
    });
  }

  const entries: CommandCatalogEntry[] = [];
  const indexes = new Map<string, number>();

  for (const candidate of candidates) {
    const existingIndex = indexes.get(candidate.name);
    if (existingIndex === undefined) {
      indexes.set(candidate.name, entries.length);
      entries.push(candidate);
      continue;
    }

    const existing = entries[existingIndex];
    if (existing && SOURCE_PRECEDENCE[candidate.source] < SOURCE_PRECEDENCE[existing.source]) {
      entries[existingIndex] = candidate;
    }
  }

  return {
    entries,
    availableCommands: entries.map(availableCommand),
  };
}

export type SlashInvocation = { name: string; text: string };

/** Return a single-line slash invocation, or null for ordinary prompt text. */
export function parseSlashInvocation(message: string): SlashInvocation | null {
  if (!message.startsWith("/")) return null;
  if (message.includes("\n") || message.includes("\r")) return null;
  const match = /^\/([^\s/]+)(?:[\t ]+.*)?$/.exec(message);
  if (!match?.[1]) return null;
  const name = canonicalCommandName(match[1]);
  return name ? { name, text: message } : null;
}

export class SessionCommandCatalog {
  private entries = new Map<string, CommandCatalogEntry>();
  private commands: readonly AvailableCommand[] = [];
  private revision = 0;

  replace(snapshot: CommandCatalogSnapshot): number {
    this.entries = new Map(snapshot.entries.map((entry) => [entry.name, entry]));
    this.commands = [...snapshot.availableCommands];
    this.revision += 1;
    return this.revision;
  }

  resolve(name: string): CommandCatalogEntry | undefined {
    const canonical = canonicalCommandName(name);
    return canonical ? this.entries.get(canonical) : undefined;
  }

  snapshot(): CommandCatalogView {
    return { revision: this.revision, availableCommands: [...this.commands] };
  }
}

/** Legacy mapper retained for upstream callers and tests. New code should use buildCommandCatalog. */
export function toAvailableCommandsFromPiGetCommands(
  data: BoundaryValue,
  opts?: LegacyCommandMappingOptions,
): LegacyCommandMapping {
  const enableSkillCommands = opts?.enableSkillCommands ?? true;
  const includeExtensionCommands = opts?.includeExtensionCommands ?? false;
  const commandsRaw = rawPiCommands(data);
  const out: AvailableCommand[] = [];

  for (const command of commandsRaw) {
    const name = command.name === undefined ? null : canonicalCommandName(command.name);
    if (!name) continue;

    const source = commandSource(command);
    if (!source) continue;
    if (!includeExtensionCommands && source === "extension") continue;
    if (!enableSkillCommands && source === "skill") continue;

    out.push({
      name,
      description: stringValue(command.description) ?? describeFallback(command),
    });
  }

  return { commands: out, raw: commandsRaw };
}
