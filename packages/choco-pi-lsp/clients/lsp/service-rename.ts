/**
 * Symbol rename and file rename (willRenameFiles/didRenameFiles) for {@link LSPService}.
 *
 * Extracted from `clients/lsp/index.ts`; behavior is unchanged.
 */

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
    // Keep non-canonical percent-encoding choices from the URI that was
    // opened (for example `%2E` instead of `.`) while using the new path's
    // exact basename. The authority and directory spelling are preserved too.
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

// #1621: bound a single rename-propagation notify call and classify how it
// failed. `withTimeout` rejects with the deterministic `"Timeout after Nms"`
// message on the timer branch (see deadline-utils.ts) — the same signal
// `navRequest`/`clientPingLiveness` in clients/lsp/client.ts already match on
// to tell a timeout from a genuine rejection, reused here rather than forking
// a second convention.
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

/** Implements {@link LSPService.rename}. */
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

/** Implements {@link LSPService.renameFile}. */
export async function renameFile(
  core: LSPServiceInternals,
  oldFilePath: string,
  newFilePath: string,
  options: { cwd: string; apply?: boolean; mutationContext?: LspMutationContext },
): Promise<LSPRenameFileResult> {
  const cwd = options.cwd;
  const apply = options.apply ?? false;
  // Validate the complete resource operation before asking any server for
  // willRenameFiles edits. This is a read-only preflight, but it reuses the
  // same confinement, realpath/symlink, existence, and destination checks as
  // the eventual apply path, so an invalid rename cannot first mutate an
  // in-workspace file through returned text edits (including previews).
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
      // #1621: bounded so one wedged server's didClose write cannot stall
      // this Promise.all — and therefore the whole rename — for every
      // other client alongside it.
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
    // Do not rename or send didRenameFiles while any server still has the
    // old document open. Re-open/resync every affected client so a partial
    // close cannot leave an in-memory document behind the disk contents.
    // Reopen with the document's ACTUAL language ID (the same resolver every
    // genuine open uses) rather than a hardcoded "plaintext" fallback — a
    // wrong languageId here degrades that server's diagnostics until the
    // next genuine open (#1147 P3-7).
    const content = await fs.readFile(oldFilePath, "utf-8");
    const languageId = getLanguageId(oldFilePath) ?? "plaintext";
    const resyncFailures: RenameNotifyFailure[] = [];
    // #1621 F1: the resync write is the SAME class of notify as the didClose
    // it is repairing after — a pipe that is wedged for didClose is wedged
    // for every subsequent write on it too, so this bare await reintroduced
    // the exact unbounded primitive one Promise.all up. Bound it with the
    // same budget and record the disposition rather than let a wedged
    // resync silently move the hang here instead of removing it.
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
      // A resync failure is not swallowed: the affected client is left with
      // no open document at all until its next genuine open, so this is
      // logged for the same reason lsp_client_shutdown records a forced
      // teardown — a degraded resync must be countable from the log.
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
    // Route the resource mutation through the same preflight confinement,
    // realpath and symlink policy as all other workspace edits. Do not
    // duplicate that security boundary with a direct mkdir/rename pair.
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
      // #1621: bounded for the same reason as the didClose notify above —
      // rename propagation is best-effort advice to servers, not a
      // correctness gate, so a wedged client's notify must not stall the
      // healthy clients settling alongside it in this Promise.all.
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
