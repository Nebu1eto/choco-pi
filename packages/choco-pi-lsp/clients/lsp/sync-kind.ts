import { obj, opt, union, compile } from "@earendil-works/pi-schema";
import { finiteNum } from "./schema-guards.ts";

export type TextDocumentSyncKind = 0 | 1 | 2;

export const TEXT_DOCUMENT_SYNC_KIND_NONE: TextDocumentSyncKind = 0;
export const TEXT_DOCUMENT_SYNC_KIND_FULL: TextDocumentSyncKind = 1;
export const TEXT_DOCUMENT_SYNC_KIND_INCREMENTAL: TextDocumentSyncKind = 2;

const SyncCapabilitiesSchema = obj(
  {
    textDocumentSync: opt(union([finiteNum(), obj({ change: opt(finiteNum()) }, { open: true })])),
  },
  { open: true },
);
const isSyncCapabilities = compile(SyncCapabilitiesSchema).check;
const isSyncOptions = compile(obj({ change: opt(finiteNum()) }, { open: true })).check;

function isSyncKind<T>(value: T): value is T & TextDocumentSyncKind {
  return value === 0 || value === 1 || value === 2;
}

export function negotiateSyncKind<T>(serverCapabilities: T): TextDocumentSyncKind {
  if (!isSyncCapabilities(serverCapabilities)) {
    return TEXT_DOCUMENT_SYNC_KIND_FULL;
  }
  const sync = serverCapabilities.textDocumentSync;
  if (isSyncKind(sync)) return sync;
  if (isSyncOptions(sync)) {
    const change = sync.change;
    if (isSyncKind(change)) return change;
  }
  return TEXT_DOCUMENT_SYNC_KIND_FULL;
}
