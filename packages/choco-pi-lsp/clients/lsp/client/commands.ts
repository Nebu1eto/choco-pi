/**
 * workspace/executeCommand, workspace-edit normalization, and code-action resolution.
 */
import { withTimeout } from "../../deadline-utils.ts";
import type { LspMutationContext } from "../../lsp-mutation.ts";
import { normalizeWorkspaceEditToUtf16 } from "../edits.ts";
import { normalizeMapKey, uriToPath } from "../../path-utils.ts";
import {
  EXECUTE_COMMAND_TIMEOUT_MS,
  NAV_REQUEST_TIMEOUT_MS,
  PROBE_COMMAND_TIMEOUT_MS,
} from "./constants.ts";
import { isClientAlive } from "./process.ts";
import {
  isLspCodeAction,
  isVersionedTextDocumentChange,
  parseWorkspaceEditPayload,
  type JsonValue,
} from "./schemas.ts";
import { safeSendRequest } from "./transport.ts";
import type { LSPClientState, LSPCodeAction, LSPWorkspaceEdit } from "./types.ts";

// Run an advertised server command via workspace/executeCommand, with the
// generous EXECUTE_COMMAND_TIMEOUT_MS anti-deadlock backstop. Preserves the
// hardening invariants: allowlist-by-advertisement (only commands the server
// declared) and the serverEditsAllowed window that gates server-driven
// applyEdit to the duration of an explicit call. Exported with an overridable
// `timeoutMs` for the #365 regression tests.
export async function runServerCommand(
  state: LSPClientState,
  command: string,
  args: unknown[] | undefined,
  timeoutMs: number = EXECUTE_COMMAND_TIMEOUT_MS,
  mutationContext?: LspMutationContext,
): Promise<{ executed: boolean; result?: unknown; reason?: string }> {
  if (!isClientAlive(state)) {
    return { executed: false, reason: "lsp client not alive" };
  }
  if (!state.advertisedCommands.has(command)) {
    return {
      executed: false,
      reason: `command "${command}" is not advertised by the ${state.serverId} server`,
    };
  }
  state.serverEditsAllowed += 1;
  state.activeMutationDepth = (state.activeMutationDepth ?? 0) + 1;
  if (state.activeMutationDepth === 1) state.activeMutationContext = mutationContext;
  else state.activeMutationContext = undefined;
  try {
    let result: unknown;
    try {
      result = await withTimeout(
        safeSendRequest<unknown>(state.connection, "workspace/executeCommand", {
          command,
          arguments: args ?? [],
        }),
        timeoutMs,
      );
    } catch (err) {
      // Generous backstop only: a timeout means the server is hung (or the
      // command is running longer than the ceiling). Surface it honestly — the
      // command may still be applying — instead of hanging the caller. Real
      // (non-timeout) errors still propagate.
      if (err instanceof Error && err.message.startsWith("Timeout after")) {
        return {
          executed: false,
          reason: `workspace/executeCommand timed out after ${timeoutMs}ms — the command may still be applying server-side`,
        };
      }
      throw err;
    }
    return { executed: true, result };
  } finally {
    state.serverEditsAllowed -= 1;
    state.activeMutationDepth = Math.max(0, (state.activeMutationDepth ?? 0) - 1);
    if (state.activeMutationDepth === 0) state.activeMutationContext = undefined;
  }
}

// #1412 H1/H2: read-only sibling of runServerCommand for telemetry/identity
// probes that must NOT participate in the mutation-acceptance window. Unlike
// runServerCommand this never touches serverEditsAllowed, activeMutationDepth,
// or activeMutationContext — a probe firing mid-flight must leave a concurrent
// real executeCommand's mutation context untouched, and must not itself open
// the workspace/applyEdit acceptance window (client.ts's applyEdit handler
// gates on serverEditsAllowed > 0). Preserves the allowlist-by-advertisement
// invariant. Short PROBE_COMMAND_TIMEOUT_MS backstop — this is a diagnostic
// sample, not a mutation, and must never hold anything up for anywhere near
// EXECUTE_COMMAND_TIMEOUT_MS.
export async function runReadOnlyServerCommand(
  state: LSPClientState,
  command: string,
  args: unknown[] | undefined,
  timeoutMs: number = PROBE_COMMAND_TIMEOUT_MS,
): Promise<{ executed: boolean; result?: unknown; reason?: string }> {
  if (!isClientAlive(state)) {
    return { executed: false, reason: "lsp client not alive" };
  }
  if (!state.advertisedCommands.has(command)) {
    return {
      executed: false,
      reason: `command "${command}" is not advertised by the ${state.serverId} server`,
    };
  }
  try {
    const result = await withTimeout(
      safeSendRequest<unknown>(state.connection, "workspace/executeCommand", {
        command,
        arguments: args ?? [],
      }),
      timeoutMs,
    );
    return { executed: true, result };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Timeout after")) {
      return {
        executed: false,
        reason: `workspace/executeCommand timed out after ${timeoutMs}ms`,
      };
    }
    throw err;
  }
}

function validateWorkspaceEditVersions(
  state: LSPClientState,
  edit: { documentChanges?: unknown[] },
): void {
  for (const change of edit.documentChanges ?? []) {
    if (!isVersionedTextDocumentChange(change)) continue;
    const textDocument = change.textDocument;
    if (textDocument.uri === undefined || textDocument.version == null) continue;
    const current = state.documentVersions.get(normalizeMapKey(uriToPath(textDocument.uri)));
    if (current === undefined || current !== textDocument.version) {
      throw new Error(`stale workspace edit document version for ${textDocument.uri}`);
    }
  }
}

// Neutralize numeric `textDocument.version` stamps AFTER they have been
// validated against the live document map. The tool apply paths (rename
// apply:true in tools/lsp-navigation.ts, code-action autofix in
// actionable-warnings.ts) call applyWorkspaceEdit without a documentVersions
// map, so a preserved numeric version would fail preflight 100% of the time for
// servers that stamp real versions (gopls stamps open documents). Setting the
// version to null is the spec's "do not check" — the freshness guarantee has
// already been provided here by validateWorkspaceEditVersions at the correct
// moment. The server-initiated workspace/applyEdit handler does NOT route
// through here (it applies params.edit directly with state.documentVersions),
// so its real preflight version check is left fully intact.
function stripDocumentVersions(edit: LSPWorkspaceEdit): LSPWorkspaceEdit {
  if (!Array.isArray(edit.documentChanges)) return edit;
  const documentChanges = edit.documentChanges.map((change) => {
    if (
      isVersionedTextDocumentChange(change) &&
      Object.hasOwn(change, "edits") &&
      change.textDocument.version !== undefined &&
      change.textDocument.version !== null
    ) {
      return {
        ...change,
        textDocument: { ...change.textDocument, version: null },
      };
    }
    return change;
  });
  return { ...edit, documentChanges };
}

export async function normalizeClientWorkspaceEdit(
  state: LSPClientState,
  edit: LSPWorkspaceEdit,
): Promise<LSPWorkspaceEdit> {
  validateWorkspaceEditVersions(state, edit);
  const normalized = await normalizeWorkspaceEditToUtf16(edit, state.positionEncoding, state.root);
  return stripDocumentVersions(normalized);
}

export async function resolveCodeActionBestEffort(
  state: LSPClientState,
  action: LSPCodeAction,
): Promise<LSPCodeAction> {
  if (!isClientAlive(state)) return action;
  if (action.edit) {
    const edit = parseWorkspaceEditPayload(action.edit);
    if (!edit) return action;
    return {
      ...action,
      edit: await normalizeClientWorkspaceEdit(state, edit),
    };
  }
  let resolved: LSPCodeAction | undefined;
  try {
    const rawResolved = await withTimeout(
      safeSendRequest<JsonValue, LSPCodeAction>(state.connection, "codeAction/resolve", action),
      NAV_REQUEST_TIMEOUT_MS,
    );
    resolved = isLspCodeAction(rawResolved) ? rawResolved : undefined;
  } catch {
    // codeAction/resolve is optional. Keep the original lightweight action when
    // the server does not support resolve or fails to populate an edit.
    return action;
  }
  if (!resolved) return action;
  const merged = { ...action, ...resolved };
  if (!merged.edit) return merged;
  const edit = parseWorkspaceEditPayload(merged.edit);
  if (!edit) return merged;
  return {
    ...merged,
    edit: await normalizeClientWorkspaceEdit(state, edit),
  };
}
