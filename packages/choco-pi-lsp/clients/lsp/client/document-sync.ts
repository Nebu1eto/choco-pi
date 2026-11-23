/**
 * Document synchronization: sent-content tracking, incremental content changes, and open/change/close notifications.
 */
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

/**
 * #1095: fingerprint the EXACT didOpen/didChange payload text at SEND time and
 * tag it with the document version it was sent as, so a later
 * `publishDiagnostics` echoing that version can bind its diagnostics to the
 * content they were computed against. Runs on in-memory content — never a disk
 * read on the notification path (I1). Bounded by the same file-size gates the
 * caller already applies to the content it hands us.
 */
function recordSentContent(
  state: LSPClientState,
  normalizedPath: string,
  version: number,
  content: string,
): void {
  state.documentContentHashes.set(normalizedPath, {
    version,
    hash: hashDiagnosticContent(content),
    // #1669: retain the full text only for Incremental — the sole reader
    // (`buildContentChanges`) needs it to compute the NEXT change against
    // what the server last saw; Full/None never read this field.
    ...(state.syncKind === TEXT_DOCUMENT_SYNC_KIND_INCREMENTAL && {
      text: content,
    }),
  });
  // #1641 criterion 3: the in-memory document's version + content length AT
  // SEND TIME, so a later "diagnostic cited a line past current disk EOF"
  // record (`diagnostic_past_eof`, clients/diagnostic-line-freshness.ts) can be
  // paired with the send that produced the divergent in-memory document —
  // today only the symptom (the stale citation) is observable; this is the
  // cause side of the same timeline.
  //
  // Review round F4/F1: `contentLineCount` MUST use the same LSP-addressable
  // convention as the gate itself (newline count + 1 — a trailing `\n` adds
  // one more, empty, addressable line; an empty document is still 1 line),
  // or the two records disagree by one at exactly the boundary this counter
  // exists to help debug. Counted directly (no `.split("\n")`, which
  // allocates one substring per line — measured at 13.3ms/200k allocations
  // on a 7MB send) since only the COUNT is needed here, not the lines.
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

/**
 * #1669: the `contentChanges` array for a `textDocument/didChange` notification.
 *
 * Full/None (or unrecognized/absent) sync kind: unchanged — a single
 * whole-document `{ text }` event, the shape choco-pi-lsp has always sent.
 *
 * Incremental: a server registering Incremental-only expects every change
 * event to carry a `range`; a shapeless whole-document event is out of spec
 * for it. Rather than hand-roll a real diff, send the SAFEST incremental
 * representation of a full update — one ranged edit spanning the entire
 * PREVIOUS document (start of file to its last character), replacing it with
 * the entire new content. That is spec-valid for any Incremental server and
 * semantically identical to the Full-sync event it replaces.
 *
 * The previous document's end position is computed from the text
 * `recordSentContent` retained for THIS path the last time content was sent
 * (reusing that seam rather than a second parallel content store — see its
 * doc comment). No prior text on record (first change since Incremental was
 * negotiated, or the path was never sent before) falls back to the
 * whole-document shape — still spec-valid, and self-heals once the next
 * change has a retained previous text to diff against.
 */
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
  // #1669 review F6: split on every LSP line terminator (\r\n, lone \r, or
  // \n), not just \n — a document using CRLF or lone-CR line endings would
  // otherwise be undercounted, computing a range that ends mid-document
  // instead of at the real last line.
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

/**
 * Queue a watched-files change for a file this client did not learn about
 * through textDocument/didOpen or didChange — an external bash write/delete,
 * or any other disk change outside the open-document sync path (#1668).
 * Shares `handleNotifyOpen`'s per-client debounced queue (#271), so a burst
 * of external changes coalesces into one notification per debounce window
 * instead of flooding the server with one per file.
 */
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
    // preserveDiagnostics: skip cache clear for format-only resyncs so
    // waitForDiagnostics fast-paths instead of waiting up to 5s for TypeScript
    // to re-publish what it already knows (formatting doesn't change semantics).
    // #1095 note: this also retains the prior content `binding`. Until the
    // server republishes for the new version, a binding read compares the OLD
    // content hash against the NEW disk bytes → boundToCurrentDisk `false` →
    // the consumer demotes to inconclusive. That's the SAFE (#533) direction (a
    // transient "unconfirmed", never a false-clean), self-healing on the next
    // publish — not a correctness hazard, unlike the reopen false-TRUE above.
    if (!preserveDiagnostics) {
      clearDiagnosticsForPath(state, normalizedPath);
    }
    // Scanners that only re-scan on a fresh open (opengrep ignores didChange):
    // close + reopen so the re-edit actually triggers a re-scan instead of
    // silently publishing nothing.
    if (getStrategy(state.serverId, state.launchVariant).reopenOnResync) {
      await safeSendNotification(state.connection, "textDocument/didClose", {
        textDocument: { uri },
      });
      state.openDocuments.delete(normalizedPath);
      state.openDocumentUris?.delete(normalizedPath);
      // #1095 (P2-3): carry the version counter FORWARD across the
      // close+reopen instead of resetting to 0. LSP lets a didOpen use any
      // version, and reusing 0 for successive resyncs made the version
      // ambiguous — a late publish for an earlier resync's content echoed the
      // SAME 0 as the current send, so the superseded-push guard (0 < 0 is
      // false) accepted it and `recordBinding` bound STALE diagnostics to the
      // CURRENT content's fingerprint → an affirmative boundToCurrentDisk TRUE
      // for a stale view (worse than "unknown"). Monotonic versions make that
      // late echo strictly older → dropped by isSupersededPush → never bound.
      state.documentVersions.set(normalizedPath, version);
      state.documentOpenedAt.set(normalizedPath, Date.now());
      state.diagnosticPublicationCounts.set(normalizedPath, 0);
      if (!isClientAlive(state)) return;
      const reopenSent = await safeSendNotification(state.connection, "textDocument/didOpen", {
        textDocument: { uri, languageId, version, text: content },
      });
      // #1669 review F7: only mirror the send locally once it actually left
      // the process — see safeSendNotification's doc comment.
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
  clearDiagnosticsForPath(state, normalizedPath); // always clear for initial open

  // Send workspace notification first (like opencode does).
  // Skipped in silent mode — cascade reads a file for diagnostics,
  // not reporting a real filesystem change. Avoids N project-wide
  // rechecks on push-diagnostics LSPs (TypeScript, Python) per CR-1.
  if (!silent) {
    // Async existence probe (was a synchronous existsSync on the document-open
    // path — a stat that blocks the loop during first-read/warm). The notify
    // type is unchanged: 2 (Changed) when the file exists on disk, else 1
    // (Created). access() rejects when absent.
    let fileExists = true;
    try {
      await access(filePath);
    } catch {
      fileExists = false;
    }
    // #271: enqueue instead of sending now — the per-client queue coalesces a
    // turn's file opens into a single notification, so push-diagnostics servers
    // re-analyze the project once per burst rather than once per file. didOpen
    // (below) still carries this file's content immediately, so the open
    // document is analyzed without waiting on the batched watcher notify.
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
  // Telemetry is deliberately detached after didOpen succeeds.
  // #1412 H1: routed through runReadOnlyServerCommand, NOT runServerCommand —
  // the probe must never open the serverEditsAllowed/activeMutationContext
  // mutation-acceptance window; it is a diagnostic sample, not a mutation, and
  // carries its own short PROBE_COMMAND_TIMEOUT_MS backstop. The probe itself
  // is classic-only and swallows every failure.
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
    // Safety fallback: keep protocol ordering valid even if caller sends
    // didChange before first didOpen for this document.
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
  // Clear stale diagnostics before sending new content so waitForDiagnostics
  // doesn't return immediately with the previous edit's results.
  clearDiagnosticsForPath(state, normalizedPath);
  const changeSent = await safeSendNotification(state.connection, "textDocument/didChange", {
    textDocument: { uri, version },
    contentChanges: buildContentChanges(state, normalizedPath, content),
  });
  if (changeSent) recordSentContent(state, normalizedPath, version, content);
}

/** Close a document through the same lifecycle path exposed by the client. */
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
  // #1412 L1: projectIdentityProbedFiles is a claim-once memo scoped to the
  // document's open lifetime (re-probing a closed-then-reopened file is
  // harmless and cheap) — mirror openDocuments' own per-close cleanup so it
  // doesn't grow unbounded across a long session's worth of open/close churn.
  state.projectIdentityProbedFiles?.delete(normalizedPath);
  clearDiagnosticsForPath(state, normalizedPath);
}
