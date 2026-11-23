/**
 * Per-session command catalogs, each owned by the Pi process that produced it.
 */
import type { BoundaryValue } from "../boundary.ts";
import type { PiRpcProcessLike } from "../pi-rpc/process.ts";
import { builtinAvailableCommands } from "./agent-builtin-commands.ts";
import {
  buildCommandCatalog,
  type CommandCatalogEntry,
  SessionCommandCatalog,
} from "./pi-commands.ts";

/** A command catalog together with the Pi process that produced it. */
export type CommandCatalogOwner = {
  proc: PiRpcProcessLike;
  catalog: SessionCommandCatalog;
};

/**
 * The agent's command catalogs keyed by session. A catalog is reused only while the
 * same Pi process owns its session, so a respawned process never inherits stale entries.
 */
export class SessionCommandCatalogs {
  private readonly owners = new Map<string, CommandCatalogOwner>();

  get(sessionId: string): CommandCatalogOwner | undefined {
    return this.owners.get(sessionId);
  }

  clear(): void {
    this.owners.clear();
  }

  /** Rebuild a session's catalog from Pi's command data plus the adapter builtins. */
  replace(
    sessionId: string,
    proc: PiRpcProcessLike,
    data: BoundaryValue,
    enableSkillCommands: boolean,
  ): SessionCommandCatalog {
    const owned = this.owners.get(sessionId);
    const catalog = owned?.proc === proc ? owned.catalog : new SessionCommandCatalog();
    catalog.replace(
      buildCommandCatalog(data, builtinAvailableCommands(), {
        enableSkillCommands,
      }),
    );
    this.owners.set(sessionId, { proc, catalog });
    return catalog;
  }

  /** The entry for `name`, when `proc` still owns the session's catalog. */
  entry(sessionId: string, proc: PiRpcProcessLike, name: string): CommandCatalogEntry | undefined {
    const owned = this.owners.get(sessionId);
    return owned?.proc === proc ? owned.catalog.resolve(name) : undefined;
  }
}
