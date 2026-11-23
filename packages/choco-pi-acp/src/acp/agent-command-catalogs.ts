import type { BoundaryValue } from "../boundary.ts";
import type { PiRpcProcessLike } from "../pi-rpc/process.ts";
import { builtinAvailableCommands } from "./agent-builtin-commands.ts";
import {
  buildCommandCatalog,
  type CommandCatalogEntry,
  SessionCommandCatalog,
} from "./pi-commands.ts";

export type CommandCatalogOwner = {
  proc: PiRpcProcessLike;
  catalog: SessionCommandCatalog;
};

export class SessionCommandCatalogs {
  private readonly owners = new Map<string, CommandCatalogOwner>();

  get(sessionId: string): CommandCatalogOwner | undefined {
    return this.owners.get(sessionId);
  }

  clear(): void {
    this.owners.clear();
  }

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

  entry(sessionId: string, proc: PiRpcProcessLike, name: string): CommandCatalogEntry | undefined {
    const owned = this.owners.get(sessionId);
    return owned?.proc === proc ? owned.catalog.resolve(name) : undefined;
  }
}
