import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { withTimeout } from "../../deadline-utils.ts";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "../../deps/vscode-jsonrpc.ts";
import { recordLspChild, removeLspChild } from "../../instance-registry.ts";
import { logLatency } from "../../latency-logger.ts";
import type { StoredDiagnosticBinding } from "../diagnostic-binding.ts";
import { installLspCrashGuard } from "../crash-guard.ts";
import type { LSPProcess } from "../launch.ts";
import { normalizeMapKey } from "../../path-utils.ts";
import { negotiatePositionEncoding } from "../position-encoding.ts";
import { negotiateSyncKind, TEXT_DOCUMENT_SYNC_KIND_FULL } from "../sync-kind.ts";
import { WatchedFilesQueue } from "../watch-queue.ts";
import {
  detectExecuteCommands,
  detectOperationSupport,
  detectWorkspaceDiagnosticsSupport,
} from "./capabilities.ts";
import {
  normalizeClientWorkspaceEdit,
  resolveCodeActionBestEffort,
  runReadOnlyServerCommand,
  runServerCommand,
} from "./commands.ts";
import {
  CLIENT_CAPABILITIES,
  DIAGNOSTICS_WAIT_TIMEOUT_MS,
  EXECUTE_COMMAND_TIMEOUT_MS,
  INITIALIZE_TIMEOUT_MS,
} from "./constants.ts";
import {
  clearDiagnosticsForPath,
  diagnosticsVersionForPath,
  getMergedDiagnosticsForPath,
} from "./diagnostics-store.ts";
import {
  closeDocument,
  handleNotifyChange,
  handleNotifyExternalChange,
  handleNotifyOpen,
} from "./document-sync.ts";
import { setupConnectionLifecycle, setupIncomingHandlers } from "./incoming-handlers.ts";
import { clientPingLiveness, navRequest, toWirePosition } from "./navigation.ts";
import { clientShutdown, isClientAlive, killProcessTree } from "./process.ts";
import {
  extractSpawnMarker,
  isInitializeResult,
  isLspCodeAction,
  parseWorkspaceEditPayload,
  type InitializeResult,
  type JsonObject,
  type JsonValue,
} from "./schemas.ts";
import { activeRequestsByConnection, safeSendNotification, safeSendRequest } from "./transport.ts";
import type {
  LSPCallHierarchyIncomingCall,
  LSPCallHierarchyItem,
  LSPCallHierarchyOutgoingCall,
  LSPClientInfo,
  LSPClientState,
  LSPCodeAction,
  LSPDiagnostic,
  LSPHover,
  LSPLocation,
  LSPShutdownOptions,
  LSPSignatureHelp,
  LSPSymbol,
} from "./types.ts";
import {
  clientRequestWorkspaceDiagnostics,
  clientWaitForDiagnostics,
} from "./workspace-diagnostics.ts";

interface LspStartupState {
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  closeCode: number | null;
  closeSignal: NodeJS.Signals | null;
  stderr: string;
}

export async function createLSPClient(options: {
  serverId: string;
  process: LSPProcess;
  root: string;
  initialization?: JsonObject;
  initializeTimeoutMs?: number;
  launchVariant?: "classic" | "native-ts7";
}): Promise<LSPClientInfo> {
  installLspCrashGuard();

  const {
    serverId,
    process: lspProcess,
    root,
    initialization,
    initializeTimeoutMs = INITIALIZE_TIMEOUT_MS,
    launchVariant,
  } = options;

  void recordLspChild({
    pid: lspProcess.pid,
    serverId,
    command: lspProcess.command,
    marker: extractSpawnMarker(lspProcess.args),
  }).catch((err) => {
    logLatency({
      type: "phase",
      phase: "lsp_registry_write_failed",
      filePath: "",
      durationMs: 0,
      metadata: { op: "record", pid: lspProcess.pid, error: String(err) },
    });
  });

  const startupState: LspStartupState = {
    exitCode: null,
    exitSignal: null,
    closeCode: null,
    closeSignal: null,
    stderr: "",
  };

  const stderrRing: string[] = [];
  const MAX_STDERR_LINES = 100;

  const onStderr = (chunk: Buffer | string): void => {
    stderrRing.push(chunk.toString());
    if (stderrRing.length > MAX_STDERR_LINES) stderrRing.shift();
    if (startupState.stderr.length < 4096) {
      startupState.stderr += chunk.toString();
    }
  };

  const recentStderr = (lines = 10): string => stderrRing.slice(-lines).join("").trim();

  const checkProcessAlive = (): string | undefined => {
    const exited = lspProcess.process.exitCode;
    if (exited !== null) {
      const tail = recentStderr(20);
      return `LSP server ${serverId} exited with code ${exited}${tail ? `. stderr: ${tail}` : ""}`;
    }
    if (lspProcess.process.killed) {
      return `LSP server ${serverId} was killed`;
    }
    return undefined;
  };

  const onProcessExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    startupState.exitCode = code;
    startupState.exitSignal = signal;
  };
  const onProcessClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    startupState.closeCode = code;
    startupState.closeSignal = signal;
  };

  lspProcess.stderr.on("data", onStderr);
  lspProcess.process.on("exit", onProcessExit);
  lspProcess.process.on("close", onProcessClose);

  const streamErrorHandler = (_label: string) => (err: Error & { code?: string }) => {
    if (
      err.code === "ERR_STREAM_DESTROYED" ||
      err.code === "ERR_STREAM_WRITE_AFTER_END" ||
      err.code === "EPIPE" ||
      err.code === "ECONNRESET"
    )
      return;
  };
  lspProcess.stdin.on("error", streamErrorHandler("stdin"));
  lspProcess.stdout.on("error", streamErrorHandler("stdout"));
  lspProcess.stderr.on("error", streamErrorHandler("stderr"));

  const connection = createMessageConnection(
    new StreamMessageReader(lspProcess.stdout),
    new StreamMessageWriter(lspProcess.stdin),
  );

  const diagnosticEmitter = new EventEmitter();
  diagnosticEmitter.setMaxListeners(50);

  let state: LSPClientState;
  const watchQueue = new WatchedFilesQueue((changes) => {
    if (!isClientAlive(state)) return;
    void safeSendNotification(state.connection, "workspace/didChangeWatchedFiles", { changes });
  });

  state = {
    isConnected: true,
    isDestroyed: false,
    shutdownRequested: false,
    exitedAt: undefined,
    connectionDisposed: false,
    lastError: undefined,
    connection,
    pushDiagnostics: new Map(),
    pushDiagnosticTimestamps: new Map(),
    documentPullDiagnostics: new Map(),
    documentPullDiagnosticTimestamps: new Map(),
    pullFailureHistory: [],
    pendingDiagnostics: new Map(),
    diagnosticPublicationCounts: new Map(),
    documentOpenedAt: new Map(),
    diagnosticEmitter,
    diagnosticsVersion: 0,
    diagnosticsVersionsByPath: new Map(),
    documentVersions: new Map(),
    diagnosticDocVersions: new Map(),
    documentContentHashes: new Map(),
    diagnosticBindings: new Map(),
    pullResultIds: new Map(),
    documentPullDiagnosticsBySource: new Map(),
    pullGenerations: new Map(),
    pullRequestSequences: new Map(),
    workspacePullResultCache: new Map(),
    openDocuments: new Set(),
    closedDocuments: new Set(),
    openDocumentUris: new Map(),
    pendingOpens: new Set(),
    projectIdentityProbedFiles: new Set(),
    workspaceDiagnosticsSupport: detectWorkspaceDiagnosticsSupport(undefined),
    operationSupport: detectOperationSupport(undefined),
    staticDiagnosticsMode: "push-only",
    positionEncoding: "utf-16",
    syncKind: TEXT_DOCUMENT_SYNC_KIND_FULL,
    dynamicRegistrations: new Map(),
    advertisedCommands: new Set(),
    serverEditsAllowed: 0,
    activeMutationDepth: 0,
    serverId,
    launchVariant,
    root,
    lspProcess,
    watchQueue,
  };

  setupIncomingHandlers(state, initialization);
  connection.listen();
  setupConnectionLifecycle(state, recentStderr);

  let rawInitResult: Awaited<ReturnType<typeof safeSendRequest>>;
  try {
    rawInitResult = await withTimeout(
      safeSendRequest(connection, "initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(root).href,
        workspaceFolders: [{ name: "workspace", uri: pathToFileURL(root).href }],
        capabilities: CLIENT_CAPABILITIES,
        initializationOptions: initialization,
      }),
      initializeTimeoutMs,
    );
  } catch (err) {
    const pid = lspProcess.pid;
    void killProcessTree(lspProcess.process, pid);
    void removeLspChild(pid, extractSpawnMarker(lspProcess.args)).catch((err) => {
      logLatency({
        type: "phase",
        phase: "lsp_registry_write_failed",
        filePath: "",
        durationMs: 0,
        metadata: { op: "remove", pid, error: String(err) },
      });
    });
    setTimeout(() => {
      if (
        lspProcess.process.exitCode === null &&
        lspProcess.process.signalCode === null &&
        process.platform !== "win32"
      ) {
        lspProcess.process.kill("SIGKILL");
      }
    }, 2000);
    throw err;
  } finally {
    lspProcess.stderr.off("data", onStderr);
  }

  if (rawInitResult === undefined) {
    const compactStderr = startupState.stderr.replace(/\s+/g, " ").trim().slice(0, 320);
    const reinstallHint =
      serverId === "cpp"
        ? "Install clangd (LLVM/clang-tools) and ensure clangd.exe is on PATH."
        : `Try reinstalling: npm install -g ${serverId}-language-server.`;
    const telemetry = [
      `pid=${lspProcess.pid}`,
      `exitCode=${startupState.exitCode ?? "none"}`,
      `exitSignal=${startupState.exitSignal ?? "none"}`,
      `closeCode=${startupState.closeCode ?? "none"}`,
      `closeSignal=${startupState.closeSignal ?? "none"}`,
      `root=${root}`,
      compactStderr ? `stderr=${compactStderr}` : "stderr=<empty>",
    ].join(" ");
    throw new Error(
      `[lsp] ${serverId} failed to initialize - stream may have been destroyed. ` +
        `The server binary may be missing or crashed immediately. ${reinstallHint} ` +
        `telemetry: ${telemetry}`,
    );
  }

  const initResult: InitializeResult = isInitializeResult(rawInitResult) ? rawInitResult : {};
  const serverCapabilities = initResult.capabilities ?? undefined;
  state.workspaceDiagnosticsSupport = detectWorkspaceDiagnosticsSupport(serverCapabilities);
  state.operationSupport = detectOperationSupport(serverCapabilities);
  state.positionEncoding = negotiatePositionEncoding(serverCapabilities);
  state.syncKind = negotiateSyncKind(serverCapabilities);
  state.rawCapabilityKeys = Object.keys(serverCapabilities ?? {}).sort((a, b) =>
    a.localeCompare(b),
  );
  for (const cmd of detectExecuteCommands(serverCapabilities)) {
    state.advertisedCommands.add(cmd);
  }
  state.staticDiagnosticsMode = state.workspaceDiagnosticsSupport.mode;

  await safeSendNotification(connection, "initialized", {});
  if (initialization) {
    await safeSendNotification(connection, "workspace/didChangeConfiguration", {
      settings: initialization,
    });
  }

  return {
    serverId,
    root,
    connection,
    isAlive: () => isClientAlive(state),

    processExited: () => lspProcess.process.exitCode !== null || lspProcess.process.killed === true,

    wasShutdownIntentional: () => state.shutdownRequested,

    getExitedAt: () => state.exitedAt,

    recentStderr: (lines?: number) => recentStderr(lines),
    getPullFailureHistory: () =>
      state.pullFailureHistory.map((entry) => ({
        ...entry,
        message: entry.message.slice(0, 200),
      })),

    checkAlive: () => checkProcessAlive(),

    pingLiveness: (timeoutMs?: number) => clientPingLiveness(state, timeoutMs),

    notify: {
      async open(filePath, content, languageId, preserveDiagnostics, silent) {
        return handleNotifyOpen(state, filePath, content, languageId, preserveDiagnostics, silent);
      },
      async change(filePath, content) {
        return handleNotifyChange(state, filePath, content);
      },
      watchedFileChange(filePath, type) {
        handleNotifyExternalChange(state, filePath, type);
      },
    },

    getDiagnostics(filePath) {
      return getMergedDiagnosticsForPath(state, normalizeMapKey(filePath));
    },

    getDiagnosticBinding(filePath) {
      return state.diagnosticBindings.get(normalizeMapKey(filePath));
    },

    getDiagnosticsVersionForPath(filePath) {
      return diagnosticsVersionForPath(state, normalizeMapKey(filePath));
    },

    getAllDiagnostics() {
      const result = new Map<
        string,
        {
          diags: LSPDiagnostic[];
          ts: number;
          binding?: StoredDiagnosticBinding;
        }
      >();
      const keys = new Set([
        ...state.pushDiagnostics.keys(),
        ...state.documentPullDiagnostics.keys(),
      ]);
      for (const key of keys) {
        result.set(key, {
          diags: getMergedDiagnosticsForPath(state, key),
          ts: Math.max(
            state.pushDiagnosticTimestamps.get(key) ?? 0,
            state.documentPullDiagnosticTimestamps.get(key) ?? 0,
          ),
          binding: state.diagnosticBindings.get(key),
        });
      }
      return result;
    },

    getTrackedDiagnosticPaths() {
      return [
        ...new Set([...state.pushDiagnostics.keys(), ...state.documentPullDiagnostics.keys()]),
      ].map((filePath) =>
        process.platform === "win32" ? filePath.replace(/\//g, "\\") : filePath,
      );
    },

    pruneDiagnostics(predicate) {
      let removed = 0;
      const keys = new Set([
        ...state.pushDiagnostics.keys(),
        ...state.documentPullDiagnostics.keys(),
      ]);
      for (const key of keys) {
        const diags = getMergedDiagnosticsForPath(state, key);
        const ts = Math.max(
          state.pushDiagnosticTimestamps.get(key) ?? 0,
          state.documentPullDiagnosticTimestamps.get(key) ?? 0,
        );
        if (!predicate(key, ts, diags)) continue;
        clearDiagnosticsForPath(state, key);
        removed++;
      }
      return removed;
    },

    getWorkspaceDiagnosticsSupport() {
      return state.workspaceDiagnosticsSupport;
    },

    requestWorkspaceDiagnostics(budgetMs: number) {
      return clientRequestWorkspaceDiagnostics(state, budgetMs);
    },

    getOperationSupport() {
      return state.operationSupport;
    },

    getAdvertisedCommands() {
      return [...state.advertisedCommands];
    },

    getRawCapabilityKeys() {
      return state.rawCapabilityKeys ?? [];
    },

    getLaunchVariant() {
      return state.launchVariant;
    },

    async executeCommand(command, args, mutationContext) {
      return runServerCommand(state, command, args, EXECUTE_COMMAND_TIMEOUT_MS, mutationContext);
    },

    async executeReadOnlyCommand(command, args) {
      return runReadOnlyServerCommand(state, command, args);
    },

    get diagnosticsVersion() {
      return state.diagnosticsVersion;
    },

    async waitForDiagnostics(filePath, timeoutMs = DIAGNOSTICS_WAIT_TIMEOUT_MS, options) {
      return clientWaitForDiagnostics(state, filePath, timeoutMs, options);
    },

    async definition(filePath, line, character) {
      const result = await navRequest<LSPLocation | LSPLocation[]>(
        state,
        "textDocument/definition",
        {
          textDocument: { uri: pathToFileURL(filePath).href },
          position: await toWirePosition(state, filePath, line, character),
        },
        filePath,
      );
      if (!result) return [];
      return Array.isArray(result) ? result : [result];
    },

    async typeDefinition(filePath, line, character) {
      const result = await navRequest<LSPLocation | LSPLocation[]>(
        state,
        "textDocument/typeDefinition",
        {
          textDocument: { uri: pathToFileURL(filePath).href },
          position: await toWirePosition(state, filePath, line, character),
        },
        filePath,
      );
      if (!result) return [];
      return Array.isArray(result) ? result : [result];
    },

    async declaration(filePath, line, character) {
      const result = await navRequest<LSPLocation | LSPLocation[]>(
        state,
        "textDocument/declaration",
        {
          textDocument: { uri: pathToFileURL(filePath).href },
          position: await toWirePosition(state, filePath, line, character),
        },
        filePath,
      );
      if (!result) return [];
      return Array.isArray(result) ? result : [result];
    },

    async references(filePath, line, character, includeDeclaration = true) {
      const result = await navRequest<LSPLocation[]>(
        state,
        "textDocument/references",
        {
          textDocument: { uri: pathToFileURL(filePath).href },
          position: await toWirePosition(state, filePath, line, character),
          context: { includeDeclaration },
        },
        filePath,
      );
      return result ?? [];
    },

    async hover(filePath, line, character) {
      const result = await navRequest<LSPHover>(
        state,
        "textDocument/hover",
        {
          textDocument: { uri: pathToFileURL(filePath).href },
          position: await toWirePosition(state, filePath, line, character),
        },
        filePath,
      );
      return result ?? null;
    },

    async signatureHelp(filePath, line, character) {
      const result = await navRequest<LSPSignatureHelp>(
        state,
        "textDocument/signatureHelp",
        {
          textDocument: { uri: pathToFileURL(filePath).href },
          position: await toWirePosition(state, filePath, line, character),
        },
        filePath,
      );
      return result ?? null;
    },

    async documentSymbol(filePath) {
      const result = await navRequest<LSPSymbol[]>(
        state,
        "textDocument/documentSymbol",
        { textDocument: { uri: pathToFileURL(filePath).href } },
        filePath,
      );
      return result ?? [];
    },

    isDocumentOpen(filePath) {
      return state.openDocuments.has(normalizeMapKey(filePath));
    },

    isBusy() {
      return (activeRequestsByConnection.get(connection) ?? 0) > 0;
    },

    getDocumentUri(filePath) {
      return state.openDocumentUris?.get(normalizeMapKey(filePath));
    },

    async workspaceSymbol(query) {
      if (!isClientAlive(state)) return [];
      const result = await navRequest<LSPSymbol[]>(state, "workspace/symbol", {
        query,
      });
      return result ?? [];
    },

    async codeAction(filePath, line, character, endLine, endCharacter) {
      if (!isClientAlive(state)) return [];
      const uri = pathToFileURL(filePath).href;
      const result = await navRequest<JsonValue[]>(
        state,
        "textDocument/codeAction",
        {
          textDocument: { uri },
          range: {
            start: await toWirePosition(state, filePath, line, character),
            end: await toWirePosition(state, filePath, endLine, endCharacter),
          },
          context: {
            diagnostics: getMergedDiagnosticsForPath(state, normalizeMapKey(filePath)),
          },
        },
        filePath,
      );
      if (!result || !Array.isArray(result)) return [];
      const actions: LSPCodeAction[] = [];
      for (const item of result) {
        if (isLspCodeAction(item)) actions.push(item);
      }
      return Promise.all(actions.map((action) => resolveCodeActionBestEffort(state, action)));
    },

    async rename(filePath, line, character, newName) {
      const result = await navRequest<JsonValue>(
        state,
        "textDocument/rename",
        {
          textDocument: { uri: pathToFileURL(filePath).href },
          position: await toWirePosition(state, filePath, line, character),
          newName,
        },
        filePath,
      );
      const edit = parseWorkspaceEditPayload(result);
      return edit ? await normalizeClientWorkspaceEdit(state, edit) : null;
    },

    closeDocument: (filePath) => closeDocument(state, filePath),

    async willRenameFiles(oldFilePath, newFilePath) {
      const result = await navRequest<JsonValue>(state, "workspace/willRenameFiles", {
        files: [
          {
            oldUri: pathToFileURL(oldFilePath).href,
            newUri: pathToFileURL(newFilePath).href,
          },
        ],
      });
      const edit = parseWorkspaceEditPayload(result);
      return edit ? await normalizeClientWorkspaceEdit(state, edit) : null;
    },

    async didRenameFiles(oldFilePath, newFilePath, oldUri, newUri) {
      if (!isClientAlive(state)) return;
      await safeSendNotification(state.connection, "workspace/didRenameFiles", {
        files: [
          {
            oldUri: oldUri ?? pathToFileURL(oldFilePath).href,
            newUri: newUri ?? pathToFileURL(newFilePath).href,
          },
        ],
      });
    },

    async implementation(filePath, line, character) {
      const result = await navRequest<LSPLocation | LSPLocation[]>(
        state,
        "textDocument/implementation",
        {
          textDocument: { uri: pathToFileURL(filePath).href },
          position: await toWirePosition(state, filePath, line, character),
        },
        filePath,
      );
      if (!result) return [];
      return Array.isArray(result) ? result : [result];
    },

    async prepareCallHierarchy(filePath, line, character) {
      const result = await navRequest<LSPCallHierarchyItem | LSPCallHierarchyItem[]>(
        state,
        "textDocument/prepareCallHierarchy",
        {
          textDocument: { uri: pathToFileURL(filePath).href },
          position: await toWirePosition(state, filePath, line, character),
        },
        filePath,
      );
      if (!result) return [];
      return Array.isArray(result) ? result : [result];
    },

    async incomingCalls(item) {
      const result = await navRequest<LSPCallHierarchyIncomingCall[]>(
        state,
        "callHierarchy/incomingCalls",
        { item },
      );
      return result ?? [];
    },

    async outgoingCalls(item) {
      const result = await navRequest<LSPCallHierarchyOutgoingCall[]>(
        state,
        "callHierarchy/outgoingCalls",
        { item },
      );
      return result ?? [];
    },

    async shutdown(options?: LSPShutdownOptions) {
      return clientShutdown(state, options);
    },
  };
}
