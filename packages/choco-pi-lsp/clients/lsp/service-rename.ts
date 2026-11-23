import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, URL } from "node:url";
import { logLatency } from "../latency-logger.ts";
import { withTimeout } from "../deadline-utils.ts";
import { normalizeMapKey } from "../path-utils.ts";
import { recordLspMutation, type LspMutationContext } from "../lsp-mutation.ts";
import { getServersForFileWithConfig } from "./config.ts";
import { getLanguageId } from "./language.ts";
import {
  applyWorkspaceEdit,
  type AppliedWorkspaceEdit,
  mergeWorkspaceTextEditsByPriority,
  summarizeWorkspaceEdit,
  validateWorkspaceEdit,
} from "./edits.ts";
import { activeClientsForCwd } from "./service-clients.ts";
import type { LSPServiceInternals } from "./service-internals.ts";
import { NAV_CLIENT_WAIT_TIMEOUT_MS, RENAME_NOTIFY_TIMEOUT_MS } from "./service-tunables.ts";
import type {
  LSPRenameFileResult,
  RenameNotifyDisposition,
  RenameNotifyFailure,
} from "./service-types.ts";

export function destinationUriPreservingSpelling(
  oldUri: string,
  oldFilePath: string,
  newFilePath: string,
): string {
  const canonical = pathToFileURL(newFilePath);
  try {
    const original = new URL(oldUri);
    const authority = /^file:\/\/([^/]*)/i.exec(oldUri)?.[1] ?? "";
    if (
      original.protocol !== "file:" ||
      (original.host !== "" && original.hostname !== "localhost")
    ) {
      return canonical.href;
    }
    const canonicalDestination = () => `${original.protocol}//${authority}${canonical.pathname}`;
    const oldParent = path.resolve(path.dirname(oldFilePath));
    const newParent = path.resolve(path.dirname(newFilePath));
    if (normalizeMapKey(oldParent) !== normalizeMapKey(newParent)) {
      return canonicalDestination();
    }
    const slash = original.pathname.lastIndexOf("/");
    if (slash < 0) return canonicalDestination();
    let rawName = canonical.pathname.slice(canonical.pathname.lastIndexOf("/") + 1);
    const oldRawName = original.pathname.slice(slash + 1);
    const oldName = decodeURIComponent(oldRawName);
    const expectedOldName = path.basename(oldFilePath);
    if (oldName.toLowerCase() !== expectedOldName.toLowerCase()) {
      return canonicalDestination();
    }
    for (const match of oldRawName.matchAll(/%([0-9a-f]{2})/gi)) {
      const encoded = match[0];
      const decoded = String.fromCharCode(Number.parseInt(match[1], 16));
      rawName = rawName.split(decoded).join(encoded);
    }
    return `${original.protocol}//${authority}${original.pathname.slice(0, slash + 1)}${rawName}`;
  } catch {
    return canonical.href;
  }
}

export type RenameNotifyResult =
  | { ok: true }
  | { ok: false; error: string; disposition: RenameNotifyDisposition };

export async function runRenameNotify(
  send: () => Promise<void>,
  timeoutMs: number,
): Promise<RenameNotifyResult> {
  try {
    await withTimeout(send(), timeoutMs);
    return { ok: true };
  } catch (err) {
    const timedOut = err instanceof Error && err.message.startsWith("Timeout after");
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      disposition: timedOut ? "timedOut" : "rejected",
    };
  }
}

export async function rename(
  core: LSPServiceInternals,
  filePath: string,
  line: number,
  character: number,
  newName: string,
) {
  const spawned = await core.service.getClientForFile(filePath, NAV_CLIENT_WAIT_TIMEOUT_MS);
  if (!spawned) return null;
  return spawned.client.rename(filePath, line, character, newName);
}

export async function renameFile(
  core: LSPServiceInternals,
  oldFilePath: string,
  newFilePath: string,
  options: { cwd: string; apply?: boolean; mutationContext?: LspMutationContext },
): Promise<LSPRenameFileResult> {
  const cwd = options.cwd;
  const apply = options.apply ?? false;
  await validateWorkspaceEdit(
    {
      documentChanges: [
        {
          kind: "rename",
          oldUri: pathToFileURL(oldFilePath).href,
          newUri: pathToFileURL(newFilePath).href,
        },
      ],
    },
    cwd,
  );
  const priorityServerIds = getServersForFileWithConfig(oldFilePath).map((server) => server.id);
  const activeClients = activeClientsForCwd(core, cwd, priorityServerIds);
  const willRenameFailures: Array<{ serverId: string; error: string }> = [];
  const didRenameFailures: RenameNotifyFailure[] = [];

  const willResults = await Promise.all(
    activeClients.map(async ({ serverId, client }) => {
      try {
        return {
          serverId,
          edit: await client.willRenameFiles(oldFilePath, newFilePath),
        };
      } catch (err) {
        willRenameFailures.push({
          serverId,
          error: err instanceof Error ? err.message : String(err),
        });
        return { serverId, edit: null };
      }
    }),
  );

  const successfulWillResults = willResults.filter(
    (result) => !willRenameFailures.some((failure) => failure.serverId === result.serverId),
  );
  if (activeClients.length > 0 && successfulWillResults.length === 0) {
    throw new Error(
      `workspace/willRenameFiles failed for all active LSP servers: ${willRenameFailures.map((failure) => `${failure.serverId}: ${failure.error}`).join("; ")}`,
    );
  }

  const merged = mergeWorkspaceTextEditsByPriority(successfulWillResults);
  const summary = summarizeWorkspaceEdit(merged.edit, cwd);
  if (!apply) {
    return {
      applied: false,
      serverIds: activeClients.map((entry) => entry.serverId),
      willRenameFailures,
      didRenameFailures,
      droppedConflicts: merged.droppedConflicts,
      inputEditCount: merged.inputEditCount,
      summary,
    };
  }

  let applied;
  try {
    applied = await applyWorkspaceEdit(merged.edit, cwd, {
      mutationContext: options.mutationContext,
      observe: false,
    });
  } catch (err) {
    if (
      options.mutationContext &&
      err instanceof Error &&
      Object.hasOwn(err, "appliedWorkspaceEdit")
    ) {
      // SAFETY: applyWorkspaceEdit creates this Error property from its typed partial result.
      const partial = (err as Error & { appliedWorkspaceEdit?: AppliedWorkspaceEdit })
        .appliedWorkspaceEdit;
      if (partial) {
        recordLspMutation(options.mutationContext, {
          results: [partial],
          status: "failed",
        });
      }
    }
    throw err;
  }
  const openDocuments = activeClients
    .filter(({ client }) => client.isDocumentOpen(oldFilePath))
    .map(({ serverId, client }) => ({
      serverId,
      client,
      oldUri: client.getDocumentUri(oldFilePath),
    }));
  const closeFailures: RenameNotifyFailure[] = [];
  await Promise.all(
    openDocuments.map(async ({ serverId, client }) => {
      const result = await runRenameNotify(
        () => client.closeDocument(oldFilePath),
        RENAME_NOTIFY_TIMEOUT_MS,
      );
      if (!result.ok) {
        closeFailures.push({
          serverId,
          error: result.error,
          disposition: result.disposition,
        });
      }
    }),
  );
  if (closeFailures.length > 0) {
    if (options.mutationContext) {
      recordLspMutation(options.mutationContext, {
        results: [applied],
        status: "failed",
      });
    }
    const content = await fs.readFile(oldFilePath, "utf-8");
    const languageId = getLanguageId(oldFilePath) ?? "plaintext";
    const resyncFailures: RenameNotifyFailure[] = [];
    await Promise.all(
      openDocuments.map(async ({ serverId, client }) => {
        const resyncResult = await runRenameNotify(
          () => client.notify.open(oldFilePath, content, languageId, true, true),
          RENAME_NOTIFY_TIMEOUT_MS,
        );
        if (!resyncResult.ok) {
          resyncFailures.push({
            serverId,
            error: resyncResult.error,
            disposition: resyncResult.disposition,
          });
        }
      }),
    );
    if (resyncFailures.length > 0) {
      logLatency({
        type: "phase",
        phase: "lsp_rename_resync_failed",
        filePath: oldFilePath,
        durationMs: 0,
        metadata: {
          failures: resyncFailures.map((failure) => ({
            serverId: failure.serverId,
            disposition: failure.disposition,
            error: failure.error,
          })),
        },
      });
    }
    const closeFailureSummary = closeFailures
      .map((failure) => `${failure.serverId} (${failure.disposition}): ${failure.error}`)
      .join("; ");
    const resyncFailureSummary =
      resyncFailures.length > 0
        ? ` (resync also failed: ${resyncFailures.map((failure) => `${failure.serverId} (${failure.disposition}): ${failure.error}`).join("; ")})`
        : "";
    throw new Error(
      `workspace/didClose failed; rename aborted: ${closeFailureSummary}${resyncFailureSummary}`,
    );
  }
  let renameApplied;
  try {
    renameApplied = await applyWorkspaceEdit(
      {
        documentChanges: [
          {
            kind: "rename",
            oldUri: pathToFileURL(oldFilePath).href,
            newUri: pathToFileURL(newFilePath).href,
          },
        ],
      },
      cwd,
      { observe: false },
    );
  } catch (err) {
    if (options.mutationContext) {
      recordLspMutation(options.mutationContext, {
        results: [applied],
        status: "failed",
      });
    }
    throw err;
  }
  const relOld = path.relative(cwd, oldFilePath).replace(/\\/g, "/") || path.basename(oldFilePath);
  const relNew = path.relative(cwd, newFilePath).replace(/\\/g, "/") || path.basename(newFilePath);
  const renameDescription = `Renamed ${relOld} → ${relNew}`;

  await Promise.all(
    activeClients.map(async ({ serverId, client }) => {
      const opened = openDocuments.find((entry) => entry.serverId === serverId);
      const result = await runRenameNotify(
        () =>
          opened?.oldUri
            ? client.didRenameFiles(
                oldFilePath,
                newFilePath,
                opened.oldUri,
                destinationUriPreservingSpelling(opened.oldUri, oldFilePath, newFilePath),
              )
            : client.didRenameFiles(oldFilePath, newFilePath),
        RENAME_NOTIFY_TIMEOUT_MS,
      );
      if (!result.ok) {
        didRenameFailures.push({
          serverId,
          error: result.error,
          disposition: result.disposition,
        });
      }
    }),
  );

  const files = [...new Set([...applied.files, oldFilePath, newFilePath])];
  if (options.mutationContext) {
    recordLspMutation(options.mutationContext, {
      results: [
        {
          ...applied,
          files,
          operationTotal: applied.operationTotal + renameApplied.operationTotal,
          appliedOperationTotal:
            applied.appliedOperationTotal + renameApplied.appliedOperationTotal,
          appliedOperationIndexes: [
            ...applied.appliedOperationIndexes,
            ...renameApplied.appliedOperationIndexes.map((index) => applied.operationTotal + index),
          ],
          operationCounts: {
            textEdits: applied.operationCounts.textEdits + renameApplied.operationCounts.textEdits,
            create: applied.operationCounts.create + renameApplied.operationCounts.create,
            rename: applied.operationCounts.rename + renameApplied.operationCounts.rename,
            delete: applied.operationCounts.delete + renameApplied.operationCounts.delete,
          },
          fileDetails: [...applied.fileDetails, ...renameApplied.fileDetails],
        },
      ],
      status: "success",
    });
  }

  return {
    applied: true,
    serverIds: activeClients.map((entry) => entry.serverId),
    willRenameFailures,
    didRenameFailures,
    droppedConflicts: merged.droppedConflicts,
    inputEditCount: merged.inputEditCount,
    summary,
    descriptions: [...applied.descriptions, renameDescription],
    files,
  };
}
