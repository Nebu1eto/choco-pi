import type { EventEmitter } from "node:events";
import type { MessageConnection } from "../../deps/vscode-jsonrpc.ts";
import type { LspMutationContext } from "../../lsp-mutation.ts";
import type { StoredDiagnosticBinding } from "../diagnostic-binding.ts";
import type { LSPProcess } from "../launch.ts";
import type { PositionEncoding } from "../position-encoding.ts";
import type { TextDocumentSyncKind } from "../sync-kind.ts";
import type { WatchedFilesQueue } from "../watch-queue.ts";
import type { JsonObject } from "./schemas.ts";

export interface LSPDiagnostic {
  severity: 1 | 2 | 3 | 4;
  message: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  code?: string | number;
  source?: string;
}

export interface LSPPullFailure {
  timestamp: number;
  method: "textDocument/diagnostic" | "workspace/diagnostic";
  code?: number | string;
  message: string;
}

export interface LSPLocation {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

export interface LSPHover {
  contents:
    | string
    | { kind: string; value: string }
    | Array<string | { language: string; value: string }>;
  range?: LSPLocation["range"];
}

export interface LSPSignatureHelp {
  signatures: Array<{
    label: string;
    documentation?: string | { kind: string; value: string };
    parameters?: Array<{
      label: string | [number, number];
      documentation?: string | { kind: string; value: string };
    }>;
  }>;
  activeSignature?: number;
  activeParameter?: number;
}

export interface LSPCodeAction {
  title: string;
  kind?: string;
  diagnostics?: LSPDiagnostic[];
  edit?: unknown;
  command?: unknown;
  data?: unknown;
  isPreferred?: boolean;
  disabled?: { reason?: string };
}

export interface LSPWorkspaceEdit {
  changes?: Record<string, unknown[]>;
  documentChanges?: unknown[];
  changeAnnotations?: JsonObject;
}

export interface LSPWorkspaceDiagnosticsSupport {
  advertised: boolean;
  mode: "pull" | "push-only";
  workspaceDiagnostics: boolean;
  diagnosticProviderKind: string;
}

export interface LSPShutdownOptions {
  fast?: boolean;
  processExiting?: boolean;
  reason?: string;
}

export interface LSPOperationSupport {
  definition: boolean;
  typeDefinition: boolean;
  declaration: boolean;
  references: boolean;
  hover: boolean;
  signatureHelp: boolean;
  documentSymbol: boolean;
  workspaceSymbol: boolean;
  codeAction: boolean;
  rename: boolean;
  implementation: boolean;
  callHierarchy: boolean;
}

export interface LSPSymbol {
  name: string;
  kind: number;
  containerName?: string;
  location?: LSPLocation;
  range?: LSPLocation["range"];
  selectionRange?: LSPLocation["range"];
  detail?: string;
  children?: LSPSymbol[];
}

export interface LSPCallHierarchyItem {
  name: string;
  kind: number;
  uri: string;
  range: LSPLocation["range"];
  selectionRange: LSPLocation["range"];
}

export interface LSPCallHierarchyIncomingCall {
  from: LSPCallHierarchyItem;
  fromRanges: LSPLocation["range"][];
}

export interface LSPCallHierarchyOutgoingCall {
  to: LSPCallHierarchyItem;
  fromRanges: LSPLocation["range"][];
}

export interface LSPClientInfo {
  serverId: string;
  root: string;
  connection: MessageConnection;
  isAlive: () => boolean;
  processExited: () => boolean;
  wasShutdownIntentional: () => boolean;
  getExitedAt: () => number | undefined;
  recentStderr: (lines?: number) => string;
  getPullFailureHistory?: () => LSPPullFailure[];
  checkAlive: () => string | undefined;
  pingLiveness?: (timeoutMs?: number) => Promise<boolean>;
  notify: {
    open(
      filePath: string,
      content: string,
      languageId: string,
      preserveDiagnostics?: boolean,
      silent?: boolean,
    ): Promise<void>;
    change(filePath: string, content: string): Promise<void>;
    watchedFileChange(filePath: string, type: number): void;
  };
  getDiagnostics(filePath: string): LSPDiagnostic[];
  getDiagnosticBinding(filePath: string): StoredDiagnosticBinding | undefined;
  readonly diagnosticsVersion: number;
  getDiagnosticsVersionForPath(filePath: string): number;
  waitForDiagnostics(
    filePath: string,
    timeoutMs?: number,
    options?: {
      minVersion?: number;
      pullOnly?: boolean;
      pullSettleSource?: "pull" | "pull-warmup";
    },
  ): Promise<void>;
  getAllDiagnostics(): Map<
    string,
    { diags: LSPDiagnostic[]; ts: number; binding?: StoredDiagnosticBinding }
  >;
  pruneDiagnostics(
    predicate: (filePath: string, ts: number, diags: LSPDiagnostic[]) => boolean,
  ): number;
  getTrackedDiagnosticPaths(): string[];
  getWorkspaceDiagnosticsSupport(): LSPWorkspaceDiagnosticsSupport;
  requestWorkspaceDiagnostics(budgetMs: number): Promise<
    | Array<{
        filePath: string;
        diagnostics: LSPDiagnostic[];
        contentHash?: string;
      }>
    | undefined
  >;
  getOperationSupport(): LSPOperationSupport;
  getAdvertisedCommands(): string[];
  getRawCapabilityKeys(): string[];
  getLaunchVariant(): "classic" | "native-ts7" | undefined;
  executeCommand(
    command: string,
    args?: unknown[],
    mutationContext?: LspMutationContext,
  ): Promise<{ executed: boolean; result?: unknown; reason?: string }>;
  executeReadOnlyCommand(
    command: string,
    args?: unknown[],
  ): Promise<{ executed: boolean; result?: unknown; reason?: string }>;
  definition(filePath: string, line: number, character: number): Promise<LSPLocation[]>;
  typeDefinition(filePath: string, line: number, character: number): Promise<LSPLocation[]>;
  declaration(filePath: string, line: number, character: number): Promise<LSPLocation[]>;
  references(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration?: boolean,
  ): Promise<LSPLocation[]>;
  hover(filePath: string, line: number, character: number): Promise<LSPHover | null>;
  signatureHelp(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LSPSignatureHelp | null>;
  documentSymbol(filePath: string): Promise<LSPSymbol[]>;
  isDocumentOpen(filePath: string): boolean;
  isBusy?(): boolean;
  getDocumentUri(filePath: string): string | undefined;
  closeDocument(filePath: string): Promise<void>;
  workspaceSymbol(query: string): Promise<LSPSymbol[]>;
  codeAction(
    filePath: string,
    line: number,
    character: number,
    endLine: number,
    endCharacter: number,
  ): Promise<LSPCodeAction[]>;
  rename(
    filePath: string,
    line: number,
    character: number,
    newName: string,
  ): Promise<LSPWorkspaceEdit | null>;
  willRenameFiles(oldFilePath: string, newFilePath: string): Promise<LSPWorkspaceEdit | null>;
  didRenameFiles(
    oldFilePath: string,
    newFilePath: string,
    oldUri?: string,
    newUri?: string,
  ): Promise<void>;
  implementation(filePath: string, line: number, character: number): Promise<LSPLocation[]>;
  prepareCallHierarchy(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LSPCallHierarchyItem[]>;
  incomingCalls(item: LSPCallHierarchyItem): Promise<LSPCallHierarchyIncomingCall[]>;
  outgoingCalls(item: LSPCallHierarchyItem): Promise<LSPCallHierarchyOutgoingCall[]>;
  shutdown(options?: LSPShutdownOptions): Promise<void>;
}

export interface DynamicRegistration {
  readonly method: string;
  readonly identifier?: string;
  readonly workspaceDiagnostics?: boolean;
  readonly commands?: readonly string[];
}

export interface LSPClientState {
  isConnected: boolean;
  isDestroyed: boolean;
  shutdownRequested: boolean;
  exitedAt: number | undefined;
  connectionDisposed: boolean;
  lastError: Error | undefined;
  readonly connection: MessageConnection;
  readonly pushDiagnostics: Map<string, LSPDiagnostic[]>;
  readonly pushDiagnosticTimestamps: Map<string, number>;
  readonly documentPullDiagnostics: Map<string, LSPDiagnostic[]>;
  readonly documentPullDiagnosticTimestamps: Map<string, number>;
  readonly pullFailureHistory: LSPPullFailure[];
  readonly pendingDiagnostics: Map<string, ReturnType<typeof setTimeout>>;
  readonly diagnosticPublicationCounts: Map<string, number>;
  readonly documentOpenedAt: Map<string, number>;
  readonly diagnosticEmitter: EventEmitter;
  diagnosticsVersion: number;
  readonly diagnosticsVersionsByPath: Map<string, number>;
  readonly documentVersions: Map<string, number>;
  readonly diagnosticDocVersions: Map<string, number>;
  readonly documentContentHashes: Map<string, { version: number; hash: string; text?: string }>;
  readonly diagnosticBindings: Map<string, StoredDiagnosticBinding>;
  readonly pullResultIds: Map<string, string>;
  documentPullDiagnosticsBySource?: Map<string, Map<string, LSPDiagnostic[]>>;
  pullGenerations?: Map<string, number>;
  pullRequestSequences?: Map<string, number>;
  readonly workspacePullResultCache: Map<
    string,
    {
      uri: string;
      resultId: string;
      diagnostics: LSPDiagnostic[];
      contentHash?: string;
    }
  >;
  readonly openDocuments: Set<string>;
  readonly closedDocuments?: Set<string>;
  readonly openDocumentUris?: Map<string, string>;
  readonly pendingOpens: Set<string>;
  projectIdentityProbedFiles?: Set<string>;
  workspaceDiagnosticsSupport: LSPWorkspaceDiagnosticsSupport;
  operationSupport: LSPOperationSupport;
  rawCapabilityKeys?: string[];
  positionEncoding: PositionEncoding;
  syncKind?: TextDocumentSyncKind;
  staticDiagnosticsMode: "pull" | "push-only";
  readonly dynamicRegistrations: Map<string, DynamicRegistration>;
  advertisedCommands: Set<string>;
  serverEditsAllowed: number;
  activeMutationContext?: LspMutationContext;
  activeMutationDepth?: number;
  readonly serverId: string;
  readonly launchVariant?: "classic" | "native-ts7";
  readonly root: string;
  readonly lspProcess: LSPProcess;
  watchQueue: WatchedFilesQueue;
}
