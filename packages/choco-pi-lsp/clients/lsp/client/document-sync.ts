import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { logLatency } from "../../latency-logger.ts";
import { hashDiagnosticContent } from "../diagnostic-binding.ts";
import { normalizeMapKey } from "../../path-utils.ts";
import { convertCharacterOffset } from "../position-encoding.ts";
import { TEXT_DOCUMENT_SYNC_KIND_INCREMENTAL } from "../sync-kind.ts";
import { probeTsserverProjectIdentity } from "../tsserver-sync.ts";
import { getStrategy } from "../wait-policy/index.ts";
import { runReadOnlyServerCommand } from "./commands.ts";
import { clearDiagnosticsForPath } from "./diagnostics-store.ts";
import { isClientAlive } from "./process.ts";
import { safeSendNotification } from "./transport.ts";
import type { LSPClientState } from "./types.ts";

function recordSentContent(
  state: LSPClientState,
  normalizedPath: string,
  version: number,
  content: string,
): void {
  state.documentContentHashes.set(normalizedPath, {
    version,
    hash: hashDiagnosticContent(content),
    ...(state.syncKind === TEXT_DOCUMENT_SYNC_KIND_INCREMENTAL && {
      text: content,
    }),
  });
  let newlineCount = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) newlineCount++;
  }
  logLatency({
    type: "phase",
    phase: "lsp_document_send",
    filePath: normalizedPath,
    durationMs: 0,
    metadata: {
      version,
      contentLength: content.length,
      contentLineCount: newlineCount + 1,
    },
  });
}

function buildContentChanges(
  state: LSPClientState,
  normalizedPath: string,
  content: string,
): Array<{
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  text: string;
}> {
  if (state.syncKind !== TEXT_DOCUMENT_SYNC_KIND_INCREMENTAL) {
    return [{ text: content }];
  }
  const previousText = state.documentContentHashes.get(normalizedPath)?.text;
  if (previousText === undefined) {
    return [{ text: content }];
  }
  const previousLines = previousText.split(/\r\n|\r|\n/);
  const lastLine = previousLines.length - 1;
  const lastLineText = previousLines[lastLine] ?? "";
  return [
    {
      range: {
        start: { line: 0, character: 0 },
        end: {
          line: lastLine,
          character: convertCharacterOffset(
            state.positionEncoding,
            lastLineText,
            lastLineText.length,
          ),
        },
      },
      text: content,
    },
  ];
}

export function handleNotifyExternalChange(
  state: LSPClientState,
  filePath: string,
  type: number,
): void {
  if (!isClientAlive(state)) return;
  const normalizedPath = normalizeMapKey(filePath);
  const uri = state.openDocumentUris?.get(normalizedPath) ?? pathToFileURL(filePath).href;
  state.watchQueue.enqueue(uri, type);
}

export async function handleNotifyOpen(
  state: LSPClientState,
  filePath: string,
  content: string,
  languageId: string,
  preserveDiagnostics = false,
  silent = false,
): Promise<void> {
  if (!isClientAlive(state)) return;
  const normalizedPath = normalizeMapKey(filePath);
  const uri = state.openDocumentUris?.get(normalizedPath) ?? pathToFileURL(filePath).href;

  if (state.openDocuments.has(normalizedPath) || state.pendingOpens.has(normalizedPath)) {
    const version = (state.documentVersions.get(normalizedPath) ?? 0) + 1;
    state.documentVersions.set(normalizedPath, version);
    if (!preserveDiagnostics) {
      clearDiagnosticsForPath(state, normalizedPath);
    }
    if (getStrategy(state.serverId, state.launchVariant).reopenOnResync) {
      await safeSendNotification(state.connection, "textDocument/didClose", {
        textDocument: { uri },
      });
      state.openDocuments.delete(normalizedPath);
      state.openDocumentUris?.delete(normalizedPath);
      state.documentVersions.set(normalizedPath, version);
      state.documentOpenedAt.set(normalizedPath, Date.now());
      state.diagnosticPublicationCounts.set(normalizedPath, 0);
      if (!isClientAlive(state)) return;
      const reopenSent = await safeSendNotification(state.connection, "textDocument/didOpen", {
        textDocument: { uri, languageId, version, text: content },
      });
      if (reopenSent) recordSentContent(state, normalizedPath, version, content);
      state.openDocuments.add(normalizedPath);
      state.openDocumentUris?.set(normalizedPath, uri);
      return;
    }
    const changeSent = await safeSendNotification(state.connection, "textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: buildContentChanges(state, normalizedPath, content),
    });
    if (changeSent) recordSentContent(state, normalizedPath, version, content);
    return;
  }

  state.pendingOpens.add(normalizedPath);
  state.documentVersions.set(normalizedPath, 0);
  state.documentOpenedAt.set(normalizedPath, Date.now());
  state.diagnosticPublicationCounts.set(normalizedPath, 0);
  clearDiagnosticsForPath(state, normalizedPath);

  if (!silent) {
    let fileExists = true;
    try {
      await access(filePath);
    } catch {
      fileExists = false;
    }
    state.watchQueue.enqueue(uri, fileExists ? 2 : 1);
  }

  if (!isClientAlive(state)) return;

  const openSent = await safeSendNotification(state.connection, "textDocument/didOpen", {
    textDocument: { uri, languageId, version: 0, text: content },
  });
  if (openSent) recordSentContent(state, normalizedPath, 0, content);
  state.pendingOpens.delete(normalizedPath);
  state.openDocuments.add(normalizedPath);
  state.closedDocuments?.delete(normalizedPath);
  state.openDocumentUris?.set(normalizedPath, uri);
  void probeTsserverProjectIdentity({
    serverId: state.serverId,
    launchVariant: state.launchVariant,
    clientRoot: state.root,
    file: filePath,
    normalizedFile: normalizedPath,
    probedFiles: state.projectIdentityProbedFiles ?? (state.projectIdentityProbedFiles = new Set()),
    commandChannel: {
      executeCommand: (command, args) => runReadOnlyServerCommand(state, command, args),
    },
  });
}

export async function handleNotifyChange(
  state: LSPClientState,
  filePath: string,
  content: string,
): Promise<void> {
  if (!isClientAlive(state)) return;
  const normalizedPath = normalizeMapKey(filePath);
  const uri = state.openDocumentUris?.get(normalizedPath) ?? pathToFileURL(filePath).href;

  if (!state.openDocuments.has(normalizedPath)) {
    const fallbackOpenSent = await safeSendNotification(state.connection, "textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "plaintext",
        version: 0,
        text: content,
      },
    });
    state.documentVersions.set(normalizedPath, 0);
    state.documentOpenedAt.set(normalizedPath, Date.now());
    state.diagnosticPublicationCounts.set(normalizedPath, 0);
    if (fallbackOpenSent) recordSentContent(state, normalizedPath, 0, content);
    state.openDocuments.add(normalizedPath);
    state.openDocumentUris?.set(normalizedPath, uri);
    return;
  }

  const version = (state.documentVersions.get(normalizedPath) ?? 0) + 1;
  state.documentVersions.set(normalizedPath, version);
  clearDiagnosticsForPath(state, normalizedPath);
  const changeSent = await safeSendNotification(state.connection, "textDocument/didChange", {
    textDocument: { uri, version },
    contentChanges: buildContentChanges(state, normalizedPath, content),
  });
  if (changeSent) recordSentContent(state, normalizedPath, version, content);
}

export async function closeDocument(state: LSPClientState, filePath: string): Promise<void> {
  if (!isClientAlive(state)) return;
  const normalizedPath = normalizeMapKey(filePath);
  if (!state.openDocuments.has(normalizedPath)) return;
  await safeSendNotification(state.connection, "textDocument/didClose", {
    textDocument: {
      uri: state.openDocumentUris?.get(normalizedPath) ?? pathToFileURL(filePath).href,
    },
  });
  state.openDocuments.delete(normalizedPath);
  state.closedDocuments?.add(normalizedPath);
  state.openDocumentUris?.delete(normalizedPath);
  state.documentVersions.delete(normalizedPath);
  state.documentOpenedAt.delete(normalizedPath);
  state.diagnosticPublicationCounts.delete(normalizedPath);
  state.projectIdentityProbedFiles?.delete(normalizedPath);
  clearDiagnosticsForPath(state, normalizedPath);
}
