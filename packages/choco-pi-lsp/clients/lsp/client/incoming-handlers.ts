import { pathToFileURL } from "node:url";
import { isRuntimeString } from "../../../tools/runtime-values.ts";
import { isBooleanValue } from "../schema-guards.ts";
import { incrementDegradationCount } from "../../degradation-ledger.ts";
import { logExtension } from "../../extension-log.ts";
import { logLatency } from "../../latency-logger.ts";
import { type LspMutationContext, newLspMutationCorrelationId } from "../../lsp-mutation.ts";
import { applyWorkspaceEdit } from "../edits.ts";
import { normalizeMapKey, uriToPath } from "../../path-utils.ts";
import { getStrategy } from "../wait-policy/index.ts";
import {
  clearAllWorkspaceDiagnosticsCaches,
  clearWorkspaceDiagnosticsCache,
} from "../workspace-diagnostics-cache.ts";
import { applyDynamicCapabilities, resolveConfigurationSection } from "./capabilities.ts";
import { REFRESH_REPULL_CONCURRENCY, mapWithConcurrency } from "./constants.ts";
import {
  bumpDiagnosticsVersion,
  clearDiagnosticsForPath,
  normalizeLspDiagnostics,
  retirePullSource,
} from "./diagnostics-store.ts";
import { disposeClientConnection } from "./process.ts";
import { clientRequestPullDiagnostics } from "./pull-diagnostics.ts";
import {
  PUB_DEBUG,
  isDynamicRegistrationParams,
  parseWorkspaceEditPayload,
  type JsonObject,
  type MutableDynamicRegistration,
} from "./schemas.ts";
import type { LSPClientState, LSPDiagnostic } from "./types.ts";

export function setupIncomingHandlers(
  state: LSPClientState,
  initialization: JsonObject | undefined,
): void {
  state.connection.onNotification(
    "textDocument/publishDiagnostics",
    (params: { uri: string; diagnostics?: LSPDiagnostic[]; version?: number }) => {
      const publishReceivedAt = Date.now();
      const filePath = uriToPath(params.uri);
      const normalizedPath = normalizeMapKey(filePath);
      if (state.closedDocuments?.has(normalizedPath)) return;
      const newDiags = normalizeLspDiagnostics(params.diagnostics || []);
      const docVersion = params.version;
      if (PUB_DEBUG) {
        logExtension({
          subsystem: "lsp-pub",
          level: "debug",
          message: `server=${state.serverId} pubVersion=${docVersion} docVersion=${state.documentVersions?.get(normalizedPath)} diags=${newDiags.length}`,
        });
      }
      const strategy = getStrategy(state.serverId, state.launchVariant);
      const isTypeScriptTelemetry = state.serverId === "typescript";
      const publicationIndex = isTypeScriptTelemetry
        ? (state.diagnosticPublicationCounts.get(normalizedPath) ?? 0) + 1
        : 0;
      if (isTypeScriptTelemetry) {
        state.diagnosticPublicationCounts.set(normalizedPath, publicationIndex);
      }
      const diagnosticCodes = isTypeScriptTelemetry
        ? [
            ...new Set(
              newDiags
                .map((diagnostic) => diagnostic.code)
                .filter((code): code is string | number => code !== undefined)
                .map(String),
            ),
          ].slice(0, 8)
        : [];
      const logSequence = (
        settledReturn: boolean,
        settleSource: "first-push" | "quiet-window" | "publication",
        durationMs: number,
      ): void => {
        if (state.serverId !== "typescript") return;
        const elapsedSinceDidOpenMs = Math.max(
          0,
          Date.now() - (state.documentOpenedAt.get(normalizedPath) ?? Date.now()),
        );
        logLatency({
          type: "phase",
          phase: "lsp_typescript_diagnostic_sequence",
          filePath: normalizedPath,
          durationMs,
          metadata: {
            launchVariant: state.launchVariant ?? "unknown",
            publicationIndex,
            version: docVersion ?? "push-unversioned",
            diagnosticCount: newDiags.length,
            diagnosticCodes,
            elapsedSinceDidOpenMs,
            settledReturn,
            settleSource,
          },
        });
      };
      const recordDocVersion = (): void => {
        if (docVersion !== undefined) {
          state.diagnosticDocVersions.set(normalizedPath, docVersion);
        }
        recordBinding();
      };
      const recordBinding = (): void => {
        if (docVersion === undefined) {
          state.diagnosticBindings.delete(normalizedPath);
          return;
        }
        const sent = state.documentContentHashes.get(normalizedPath);
        state.diagnosticBindings.set(normalizedPath, {
          version: docVersion,
          contentHash: sent && sent.version === docVersion ? sent.hash : undefined,
        });
      };

      const isSupersededPush = (): boolean => {
        if (docVersion === undefined) return false;
        const currentVersion = state.documentVersions.get(normalizedPath);
        return currentVersion !== undefined && docVersion < currentVersion;
      };

      if (strategy.seedFirstPush && !state.pushDiagnostics.has(normalizedPath)) {
        if (isSupersededPush()) return;
        state.pushDiagnostics.set(normalizedPath, newDiags);
        state.pushDiagnosticTimestamps.set(normalizedPath, Date.now());
        recordDocVersion();
        bumpDiagnosticsVersion(state, normalizedPath);
        state.diagnosticEmitter.emit("diagnostics", normalizedPath);
        logSequence(true, "first-push", 0);
        return;
      }
      logSequence(false, "publication", 0);

      const existingTimer = state.pendingDiagnostics.get(normalizedPath);
      if (existingTimer) clearTimeout(existingTimer);

      const timer = setTimeout(() => {
        state.pendingDiagnostics.delete(normalizedPath);
        if (isSupersededPush()) return;
        state.pushDiagnostics.set(normalizedPath, newDiags);
        state.pushDiagnosticTimestamps.set(normalizedPath, Date.now());
        recordDocVersion();
        bumpDiagnosticsVersion(state, normalizedPath);
        state.diagnosticEmitter.emit("diagnostics", normalizedPath);
        logSequence(true, "quiet-window", Date.now() - publishReceivedAt);
      }, strategy.debounceMs);

      state.pendingDiagnostics.set(normalizedPath, timer);
    },
  );

  state.connection.onRequest("workspace/workspaceFolders", () => [
    { name: "workspace", uri: pathToFileURL(state.root).href },
  ]);
  state.connection.onRequest("client/registerCapability", async (rawParams) => {
    if (!isDynamicRegistrationParams(rawParams)) return;
    for (const reg of rawParams.registrations ?? []) {
      const options = reg.registerOptions ?? undefined;
      const commands = Array.isArray(options?.commands)
        ? options.commands.filter((command): command is string => isRuntimeString(command))
        : undefined;
      const identifier = isRuntimeString(options?.identifier) ? options.identifier : undefined;
      const workspaceDiagnostics = isBooleanValue(options?.workspaceDiagnostics)
        ? options.workspaceDiagnostics
        : undefined;
      if (reg.id && reg.method) {
        const registration: MutableDynamicRegistration = { method: reg.method };
        if (identifier) registration.identifier = identifier;
        if (workspaceDiagnostics !== undefined) {
          registration.workspaceDiagnostics = workspaceDiagnostics;
        }
        if (commands) registration.commands = commands;
        state.dynamicRegistrations.set(reg.id, registration);
      }
      if (reg.method === "workspace/executeCommand" && commands) {
        for (const cmd of commands) state.advertisedCommands.add(cmd);
      }
    }
    applyDynamicCapabilities(state);
  });
  state.connection.onRequest(
    "client/unregisterCapability",
    async (params: { unregisterations?: Array<{ id: string }> }) => {
      const retiredIdentifiers = new Set<string>();
      for (const unreg of params?.unregisterations ?? []) {
        if (!unreg.id) continue;
        const registration = state.dynamicRegistrations.get(unreg.id);
        state.dynamicRegistrations.delete(unreg.id);
        if (registration?.method === "textDocument/diagnostic" && registration.identifier) {
          retiredIdentifiers.add(registration.identifier);
        }
      }
      const stillRegistered = new Set(
        [...state.dynamicRegistrations.values()]
          .filter((r) => r.method === "textDocument/diagnostic")
          .map((r) => r.identifier),
      );
      for (const identifier of retiredIdentifiers) {
        if (!stillRegistered.has(identifier)) {
          retirePullSource(state, identifier);
        }
      }
      applyDynamicCapabilities(state);
    },
  );
  state.connection.onRequest(
    "workspace/applyEdit",
    async (params: {
      edit?: { changes?: unknown; documentChanges?: unknown };
    }): Promise<{ applied: boolean; failureReason?: string }> => {
      if (state.serverEditsAllowed <= 0 || !params?.edit) {
        return { applied: false, failureReason: "edit not solicited" };
      }
      const edit = parseWorkspaceEditPayload(params.edit);
      if (!edit) return { applied: false, failureReason: "malformed workspace edit" };
      const context =
        (state.activeMutationDepth ?? 0) === 1 ? state.activeMutationContext : undefined;
      const telemetryContext: LspMutationContext = context ?? {
        cwd: state.root,
        correlationId: newLspMutationCorrelationId(),
        tool: "lsp-workspace-applyEdit",
        source: "lsp-edit",
      };
      try {
        await applyWorkspaceEdit(edit, state.root, {
          positionEncoding: state.positionEncoding,
          documentVersions: state.documentVersions,
          mutationContext: telemetryContext,
        });
        return { applied: true };
      } catch (err) {
        return {
          applied: false,
          failureReason: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
  state.connection.onRequest(
    "workspace/configuration",
    async (params: { items?: Array<{ section?: string }> }) => {
      const items = params?.items ?? [];
      return items.map((item) => resolveConfigurationSection(initialization, item?.section));
    },
  );
  state.connection.onRequest("window/workDoneProgress/create", async () => {});
  let refreshRepullRunning = false;
  let refreshRepullRerunRequested = false;

  const runRefreshRepullPool = async (): Promise<void> => {
    do {
      refreshRepullRerunRequested = false;
      const toRepull =
        state.workspaceDiagnosticsSupport.mode === "pull" ? [...state.openDocuments] : [];
      if (toRepull.length > 0) {
        try {
          await mapWithConcurrency(toRepull, REFRESH_REPULL_CONCURRENCY, async (normalizedPath) => {
            const uri = state.openDocumentUris?.get(normalizedPath);
            const filePath = uri ? uriToPath(uri) : normalizedPath;
            await clientRequestPullDiagnostics(state, filePath);
          });
        } catch (err) {
          incrementDegradationCount({
            kind: "lsp-pull-unconfirmed",
            subject: state.serverId,
            reason: `refresh re-pull threw: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    } while (refreshRepullRerunRequested);
    refreshRepullRunning = false;
  };

  state.connection.onRequest("workspace/diagnostic/refresh", async () => {
    state.workspacePullResultCache.clear();
    clearAllWorkspaceDiagnosticsCaches();
    clearWorkspaceDiagnosticsCache(state.root);
    for (const normalizedPath of state.openDocuments) {
      clearDiagnosticsForPath(state, normalizedPath);
    }
    if (state.workspaceDiagnosticsSupport.mode === "pull" && state.openDocuments.size > 0) {
      if (refreshRepullRunning) {
        refreshRepullRerunRequested = true;
      } else {
        refreshRepullRunning = true;
        setImmediate(() => {
          void runRefreshRepullPool();
        });
      }
    }
    return null;
  });
}

function markExitedIfUnset(state: LSPClientState): void {
  if (state.exitedAt === undefined) {
    state.exitedAt = Date.now();
  }
}

export function setupConnectionLifecycle(
  state: LSPClientState,
  recentStderr: (lines?: number) => string,
): void {
  state.connection.onError(([error]: [Error, ...unknown[]]) => {
    state.lastError = error instanceof Error ? error : new Error(String(error));
    state.isConnected = false;
    state.isDestroyed = true;
    markExitedIfUnset(state);
    disposeClientConnection(state);
  });

  state.connection.onClose(() => {
    state.isConnected = false;
    state.isDestroyed = true;
    markExitedIfUnset(state);
    disposeClientConnection(state);
  });

  state.lspProcess.process.on("exit", (code, signal) => {
    const wasIntentional = state.shutdownRequested;
    state.isConnected = false;
    state.isDestroyed = true;
    markExitedIfUnset(state);
    disposeClientConnection(state);
    if (!wasIntentional) {
      logLatency({
        type: "phase",
        phase: "lsp_server_unexpected_exit",
        filePath: state.root,
        durationMs: 0,
        metadata: {
          serverId: state.serverId,
          pid: state.lspProcess.pid,
          exitCode: code ?? null,
          exitSignal: signal ?? null,
          stderrTail: recentStderr(20),
        },
      });
    }
  });
}
