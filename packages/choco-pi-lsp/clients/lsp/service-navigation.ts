/**
 * Navigation, symbol, command, code-action, and capability requests for {@link LSPService}.
 *
 * Extracted from `clients/lsp/index.ts`; behavior is unchanged.
 */

import { normalizeMapKey, uriToPath } from "../path-utils.ts";
import { type LspMutationContext } from "../lsp-mutation.ts";
import { getServersForFileWithConfig } from "./config.ts";
import { type LSPCapabilitySnapshot } from "./wait-policy/index.ts";
import { checkDestroyed, resolveServerRoot } from "./service-clients.ts";
import type { LSPServiceInternals } from "./service-internals.ts";
import { NAV_CLIENT_WAIT_TIMEOUT_MS } from "./service-tunables.ts";

/** Implements {@link LSPService.definition}. */
export async function definition(
  core: LSPServiceInternals,
  filePath: string,
  line: number,
  character: number,
) {
  const spawned = await core.service.getClientForFile(filePath, NAV_CLIENT_WAIT_TIMEOUT_MS);
  if (!spawned) return [];
  return spawned.client.definition(filePath, line, character);
}

/** Implements {@link LSPService.typeDefinition}. */
export async function typeDefinition(
  core: LSPServiceInternals,
  filePath: string,
  line: number,
  character: number,
) {
  const spawned = await core.service.getClientForFile(filePath, NAV_CLIENT_WAIT_TIMEOUT_MS);
  if (!spawned) return [];
  return spawned.client.typeDefinition(filePath, line, character);
}

/** Implements {@link LSPService.declaration}. */
export async function declaration(
  core: LSPServiceInternals,
  filePath: string,
  line: number,
  character: number,
) {
  const spawned = await core.service.getClientForFile(filePath, NAV_CLIENT_WAIT_TIMEOUT_MS);
  if (!spawned) return [];
  return spawned.client.declaration(filePath, line, character);
}

/** Implements {@link LSPService.references}. */
export async function references(
  core: LSPServiceInternals,
  filePath: string,
  line: number,
  character: number,
  includeDeclaration = true,
) {
  const spawned = await core.service.getClientForFile(filePath, NAV_CLIENT_WAIT_TIMEOUT_MS);
  if (!spawned) return [];
  return spawned.client.references(filePath, line, character, includeDeclaration);
}

/** Implements {@link LSPService.hover}. */
export async function hover(
  core: LSPServiceInternals,
  filePath: string,
  line: number,
  character: number,
) {
  const spawned = await core.service.getClientForFile(filePath, NAV_CLIENT_WAIT_TIMEOUT_MS);
  if (!spawned) return null;
  return spawned.client.hover(filePath, line, character);
}

/** Implements {@link LSPService.signatureHelp}. */
export async function signatureHelp(
  core: LSPServiceInternals,
  filePath: string,
  line: number,
  character: number,
) {
  const spawned = await core.service.getClientForFile(filePath, NAV_CLIENT_WAIT_TIMEOUT_MS);
  if (!spawned) return null;
  return spawned.client.signatureHelp(filePath, line, character);
}

/** Implements {@link LSPService.documentSymbol}. */
export async function documentSymbol(core: LSPServiceInternals, filePath: string) {
  const spawned = await core.service.getClientForFile(filePath, NAV_CLIENT_WAIT_TIMEOUT_MS);
  if (!spawned) return [];
  return spawned.client.documentSymbol(filePath);
}

/** Implements {@link LSPService.workspaceSymbol}. */
export async function workspaceSymbol(core: LSPServiceInternals, query: string, filePath?: string) {
  if (filePath) {
    const spawned = await core.service.getClientForFile(filePath, NAV_CLIENT_WAIT_TIMEOUT_MS);
    if (!spawned) return [];
    return spawned.client.workspaceSymbol(query);
  }

  // Use the first active client for workspace-level queries
  const clients = Array.from(core.state.clients.values());
  if (clients.length === 0) return [];
  return clients[0].workspaceSymbol(query);
}

/** Implements {@link LSPService.getAdvertisedCommands}. */
export async function getAdvertisedCommands(
  core: LSPServiceInternals,
  filePath?: string,
): Promise<string[]> {
  if (filePath) {
    const spawned = await core.service.getClientForFile(filePath, NAV_CLIENT_WAIT_TIMEOUT_MS);
    if (!spawned) return [];
    return spawned.client.getAdvertisedCommands();
  }
  const first = core.state.clients.values().next().value;
  return first ? first.getAdvertisedCommands() : [];
}

/** Implements {@link LSPService.executeCommand}. */
export async function executeCommand(
  core: LSPServiceInternals,
  filePath: string | undefined,
  command: string,
  args?: unknown[],
  mutationContext?: LspMutationContext,
): Promise<{ executed: boolean; result?: unknown; reason?: string }> {
  if (filePath) {
    const spawned = await core.service.getClientForFile(filePath, NAV_CLIENT_WAIT_TIMEOUT_MS);
    if (!spawned) {
      return { executed: false, reason: "no LSP server for file" };
    }
    return spawned.client.executeCommand(command, args, mutationContext);
  }
  const first = core.state.clients.values().next().value;
  if (!first) return { executed: false, reason: "no active LSP server" };
  return first.executeCommand(command, args, mutationContext);
}

/** Implements {@link LSPService.executeReadOnlyCommandOnLiveClient}. */
export async function executeReadOnlyCommandOnLiveClient(
  core: LSPServiceInternals,
  filePath: string,
  command: string,
  args?: unknown[],
): Promise<{ executed: boolean; result?: unknown; reason?: string }> {
  if (checkDestroyed(core)) {
    return { executed: false, reason: "lsp service destroyed" };
  }
  for (const server of getServersForFileWithConfig(filePath)) {
    const root = await resolveServerRoot(core, server, filePath);
    if (!root) continue;
    const entry = core.state.clients.get(`${server.id}:${normalizeMapKey(root)}`);
    if (!entry?.isAlive()) continue;
    const run = entry.executeReadOnlyCommand;
    if (!run) continue;
    return run.call(entry, command, args);
  }
  return { executed: false, reason: "no live LSP server for file" };
}

/** Implements {@link LSPService.getOperationSupport}. */
export async function getOperationSupport(
  core: LSPServiceInternals,
  filePath?: string,
): Promise<import("./client.ts").LSPOperationSupport | null> {
  if (filePath) {
    const spawned = await core.service.getClientForFile(filePath);
    if (!spawned) return null;
    const getter = spawned.client.getOperationSupport;
    if (!getter) return null;
    return getter();
  }

  const first = core.state.clients.values().next().value;
  if (!first) return null;
  const getter = first.getOperationSupport;
  if (!getter) return null;
  return getter();
}

/** Implements {@link LSPService.getCapabilitySnapshots}. */
export async function getCapabilitySnapshots(
  core: LSPServiceInternals,
  filePath?: string,
): Promise<LSPCapabilitySnapshot[]> {
  if (checkDestroyed(core)) return [];
  const snapshots: LSPCapabilitySnapshot[] = [];

  if (filePath) {
    const servers = getServersForFileWithConfig(filePath);
    for (const server of servers) {
      const root = await resolveServerRoot(core, server, filePath);
      if (!root) continue;
      const client = core.state.clients.get(`${server.id}:${normalizeMapKey(root)}`);
      if (!client?.isAlive()) continue;
      snapshots.push({
        serverId: server.id,
        root,
        operationSupport: client.getOperationSupport(),
        workspaceDiagnosticsSupport: client.getWorkspaceDiagnosticsSupport(),
        advertisedCommands: client.getAdvertisedCommands(),
        rawCapabilityKeys: client.getRawCapabilityKeys?.() ?? [],
        launchVariant: client.getLaunchVariant?.(),
      });
    }
    return snapshots;
  }

  for (const [key, client] of core.state.clients) {
    if (!client.isAlive()) continue;
    const separator = key.indexOf(":");
    const serverId = separator >= 0 ? key.slice(0, separator) : key;
    snapshots.push({
      serverId,
      root: client.root,
      operationSupport: client.getOperationSupport(),
      workspaceDiagnosticsSupport: client.getWorkspaceDiagnosticsSupport(),
      advertisedCommands: client.getAdvertisedCommands(),
      rawCapabilityKeys: client.getRawCapabilityKeys?.() ?? [],
      launchVariant: client.getLaunchVariant?.(),
    });
  }
  return snapshots;
}

/** Implements {@link LSPService.getWorkspaceDiagnosticsSupport}. */
export async function getWorkspaceDiagnosticsSupport(
  core: LSPServiceInternals,
  filePath?: string,
): Promise<import("./client.ts").LSPWorkspaceDiagnosticsSupport | null> {
  if (filePath) {
    const spawned = await core.service.getClientForFile(filePath);
    if (!spawned) return null;
    const getter = spawned.client.getWorkspaceDiagnosticsSupport;
    if (!getter) return null;
    return getter();
  }

  const first = core.state.clients.values().next().value;
  if (!first) return null;
  const getter = first.getWorkspaceDiagnosticsSupport;
  if (!getter) return null;
  return getter();
}

/** Implements {@link LSPService.codeAction}. */
export async function codeAction(
  core: LSPServiceInternals,
  filePath: string,
  line: number,
  character: number,
  endLine: number,
  endCharacter: number,
) {
  const spawned = await core.service.getClientForFile(filePath, NAV_CLIENT_WAIT_TIMEOUT_MS);
  if (!spawned) return [];
  return spawned.client.codeAction(filePath, line, character, endLine, endCharacter);
}

/** Implements {@link LSPService.implementation}. */
export async function implementation(
  core: LSPServiceInternals,
  filePath: string,
  line: number,
  character: number,
) {
  const spawned = await core.service.getClientForFile(filePath, NAV_CLIENT_WAIT_TIMEOUT_MS);
  if (!spawned) return [];
  return spawned.client.implementation(filePath, line, character);
}

/** Implements {@link LSPService.prepareCallHierarchy}. */
export async function prepareCallHierarchy(
  core: LSPServiceInternals,
  filePath: string,
  line: number,
  character: number,
) {
  const spawned = await core.service.getClientForFile(filePath, NAV_CLIENT_WAIT_TIMEOUT_MS);
  if (!spawned) return [];
  return spawned.client.prepareCallHierarchy(filePath, line, character);
}

/** Implements {@link LSPService.incomingCalls}. */
export async function incomingCalls(
  core: LSPServiceInternals,
  item: import("./client.ts").LSPCallHierarchyItem,
) {
  const spawned = await core.service.getClientForFile(
    uriToPath(item.uri),
    NAV_CLIENT_WAIT_TIMEOUT_MS,
  );
  if (!spawned) return [];
  return spawned.client.incomingCalls(item);
}

/** Implements {@link LSPService.outgoingCalls}. */
export async function outgoingCalls(
  core: LSPServiceInternals,
  item: import("./client.ts").LSPCallHierarchyItem,
) {
  const spawned = await core.service.getClientForFile(
    uriToPath(item.uri),
    NAV_CLIENT_WAIT_TIMEOUT_MS,
  );
  if (!spawned) return [];
  return spawned.client.outgoingCalls(item);
}
