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

export function shouldSkipTouch(
  core: LSPServiceInternals,
  filePath: string,
  content: string,
  clientScope: LSPTouchClientScope,
  waitForDiagnostics: boolean,
  serverIds: readonly string[],
): boolean {
  if (waitForDiagnostics) return false;
  if (serverIds.length === 0) return false;
  return serverIds.every((serverId) =>
    shouldSkipNotify(core, filePath, content, clientScope, serverId),
  );
}

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
  if (core.recentTouches.size > 800) {
    for (const [k, v] of core.recentTouches) {
      if (now - v.touchedAt > TOUCH_DEBOUNCE_MS) {
        core.recentTouches.delete(k);
      }
    }
  }
}

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
