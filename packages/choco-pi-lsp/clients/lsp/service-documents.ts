/**
 * Document open/change notifications and the per-server touch debounce for {@link LSPService}.
 *
 * Extracted from `clients/lsp/index.ts`; behavior is unchanged.
 */

import { normalizeMapKey } from "../path-utils.ts";
import { getServersForFileWithConfig } from "./config.ts";
import { getLanguageId } from "./language.ts";
import { checkDestroyed, resolveServerRoot, withClientForFileUse } from "./service-clients.ts";
import type { LSPServiceInternals } from "./service-internals.ts";
import { TOUCH_DEBOUNCE_MS } from "./service-tunables.ts";
import type { LSPTouchClientScope } from "./service-types.ts";

export function fingerprintContent(content: string): string {
  if (content.length <= 96) {
    return `${content.length}:${content}`;
  }
  return `${content.length}:${content.slice(0, 48)}:${content.slice(-48)}`;
}

/**
 * Should the whole touchFile call short-circuit? Only when the caller does
 * NOT need diagnostics — those callers still need to wait for the LSP to
 * publish, even if the notify itself is a no-op.
 */
export function shouldSkipTouch(
  core: LSPServiceInternals,
  filePath: string,
  content: string,
  clientScope: LSPTouchClientScope,
  waitForDiagnostics: boolean,
  serverIds: readonly string[],
): boolean {
  if (waitForDiagnostics) return false;
  // #743: only short-circuit the whole call when EVERY spawned server already
  // has this content. If even one still needs the push, fall through — the
  // write loop skips the servers that are covered and pushes only the rest.
  if (serverIds.length === 0) return false;
  return serverIds.every((serverId) =>
    shouldSkipNotify(core, filePath, content, clientScope, serverId),
  );
}

/**
 * Should the didOpen/didChange notify be skipped while keeping the
 * waitForDiagnostics step? True when the same content was already pushed
 * recently. Skipping the notify avoids the diagnostic-cache clear that
 * notify.open does, so the LSP doesn't restart computation it already
 * finished for the first push.
 *
 * Concretely: the post-write tool_result fires touchFile with
 * diagnosticsMode="none" first; the dispatch-lsp-runner fires it again
 * with diagnosticsMode="document" moments later. Without this check the
 * second call's notify clears in-progress diagnostics and the LSP has to
 * start over — observed as multi-second waits on slow TS projects.
 *
 * Decided PER SERVER (#743): a sibling's stalled write must not cost this
 * server its debounce. See {@link recentTouches}.
 */
export function shouldSkipNotify(
  core: LSPServiceInternals,
  filePath: string,
  content: string,
  clientScope: LSPTouchClientScope,
  serverId: string,
): boolean {
  if (TOUCH_DEBOUNCE_MS <= 0) return false;
  const previous = core.recentTouches.get(recentTouchKey(filePath, clientScope, serverId));
  if (!previous) return false;
  const now = Date.now();
  if (now - previous.touchedAt > TOUCH_DEBOUNCE_MS) return false;
  return previous.fingerprint === fingerprintContent(content);
}

export function recentTouchKey(
  filePath: string,
  clientScope: LSPTouchClientScope,
  serverId: string,
): string {
  return `${normalizeMapKey(filePath)}:${clientScope}:${serverId}`;
}

export function markTouched(
  core: LSPServiceInternals,
  filePath: string,
  content: string,
  clientScope: LSPTouchClientScope,
  serverId: string,
): void {
  const key = recentTouchKey(filePath, clientScope, serverId);
  const now = Date.now();
  core.recentTouches.set(key, {
    fingerprint: fingerprintContent(content),
    touchedAt: now,
    clientScope,
  });
  // Trim entries that are already past the debounce window — shouldSkipTouch
  // ignores them anyway, so they serve no purpose. Only sweep when the map
  // exceeds the threshold to avoid iterating on every call. The threshold is
  // per-ENTRY and entries are now per-server, so it is scaled up to keep the
  // same effective file capacity a file-level key gave a multi-server scope.
  if (core.recentTouches.size > 800) {
    for (const [k, v] of core.recentTouches) {
      if (now - v.touchedAt > TOUCH_DEBOUNCE_MS) {
        core.recentTouches.delete(k);
      }
    }
  }
}

/** Implements {@link LSPService.notifyExternalFileChange}. */
export async function notifyExternalFileChange(
  core: LSPServiceInternals,
  filePath: string,
  type: number,
): Promise<void> {
  if (checkDestroyed(core)) return;
  for (const server of getServersForFileWithConfig(filePath)) {
    const root = await resolveServerRoot(core, server, filePath);
    if (!root) continue;
    const key = `${server.id}:${normalizeMapKey(root)}`;
    const existing = core.state.clients.get(key);
    if (existing?.isAlive()) {
      existing.notify.watchedFileChange(filePath, type);
    }
  }
}

/** Implements {@link LSPService.openFile}. */
export async function openFile(
  core: LSPServiceInternals,
  filePath: string,
  content: string,
  options?: { preserveDiagnostics?: boolean; spawnBudgetMs?: number },
): Promise<void> {
  if (checkDestroyed(core)) return;
  await withClientForFileUse(core, filePath, undefined, options?.spawnBudgetMs, async (spawned) => {
    const languageId = getLanguageId(filePath) ?? "plaintext";
    await spawned.client.notify.open(filePath, content, languageId, options?.preserveDiagnostics);
  });
}

/** Implements {@link LSPService.updateFile}. */
export async function updateFile(
  core: LSPServiceInternals,
  filePath: string,
  content: string,
): Promise<void> {
  if (checkDestroyed(core)) return;
  await withClientForFileUse(core, filePath, undefined, undefined, (spawned) =>
    spawned.client.notify.change(filePath, content),
  );
}
