import path from "node:path";
import { clearWorkspaceSweepHoldForSessionStart } from "./workspace-sweep-hold.ts";
import type { LSPPullFailure, LSPShutdownOptions } from "./client.ts";
import { type LspMutationContext } from "../lsp-mutation.ts";
import { type DiagnosticBinding, type TouchFileResult } from "./diagnostic-binding.ts";
import { resetClassicTsRepairGuard } from "./server.ts";
import { type LSPCapabilitySnapshot } from "./wait-policy/index.ts";
import { createLSPServiceInternals, type LSPServiceInternals } from "./service-internals.ts";
import { getMaxWorkspaceDiagnosticFiles } from "./service-tunables.ts";
import type {
  LSPDiagnosticsHealth,
  LSPDiagnosticsMode,
  LSPRenameFileResult,
  LSPTouchFileOptions,
  LSPWorkspaceDiagnosticResult,
  SpawnedServer,
} from "./service-types.ts";
import { collectWorkspaceDiagnosticFiles } from "./service-workspace-files.ts";
import * as clients from "./service-clients.ts";
import * as documents from "./service-documents.ts";
import * as touch from "./service-touch.ts";
import * as diagnostics from "./service-diagnostics.ts";
import * as navigation from "./service-navigation.ts";
import * as renaming from "./service-rename.ts";
import * as warmup from "./service-warmup.ts";
import * as workspace from "./service-workspace.ts";
import * as lifecycle from "./service-lifecycle.ts";
export type { LSPCapabilitySnapshot } from "./wait-policy/index.ts";
export { mergeInitializationOptions } from "./initialization-options.ts";
export type { LspInitializationOptions, LspInitializationValue } from "./initialization-options.ts";
export { getLspClientCeiling, getTypeScriptIdleEvictMs } from "./service-tunables.ts";
export type {
  LSPDiagnosticsHealth,
  LSPDiagnosticsMode,
  LSPRenameFileResult,
  LSPState,
  LSPTouchClientScope,
  LSPTouchFileOptions,
  LSPWorkspaceDiagnosticResult,
  LSPWorkspaceUnconfirmedReason,
  RenameNotifyDisposition,
  RenameNotifyFailure,
  SpawnedServer,
  SweepIndexGate,
} from "./service-types.ts";
export {
  createSweepIndexGate,
  groupFilesByPrimaryServer,
  runPerServerGroups,
} from "./service-workspace-files.ts";

export class LSPService {
  private readonly core: LSPServiceInternals;

  constructor(generationHandoff?: Promise<void>) {
    this.core = createLSPServiceInternals(this, generationHandoff);
  }

  getClientForFile(
    filePath: string,
    maxWaitMs?: number,
    hardCapMs?: number,
  ): Promise<SpawnedServer | undefined> {
    return clients.getClientForFile(this.core, filePath, maxWaitMs, hardCapMs);
  }

  getClientsForFile(
    filePath: string,
    excludeServerIds?: ReadonlySet<string>,
  ): Promise<{ clients: SpawnedServer[]; serverCountAttempted: number }> {
    return clients.getClientsForFile(this.core, filePath, excludeServerIds);
  }

  getAuxiliaryClientsForFile(
    filePath: string,
    enabledIds: ReadonlySet<string>,
  ): Promise<SpawnedServer[]> {
    return clients.getAuxiliaryClientsForFile(this.core, filePath, enabledIds);
  }

  getWarmClientForFile(filePath: string): Promise<SpawnedServer | undefined> {
    return clients.getWarmClientForFile(this.core, filePath);
  }

  isServerAliveForFile(serverId: string, filePath: string): Promise<boolean> {
    return clients.isServerAliveForFile(this.core, serverId, filePath);
  }

  notifyExternalFileChange(filePath: string, type: number): Promise<void> {
    return documents.notifyExternalFileChange(this.core, filePath, type);
  }

  openFile(
    filePath: string,
    content: string,
    options?: { preserveDiagnostics?: boolean; spawnBudgetMs?: number },
  ): Promise<void> {
    return documents.openFile(this.core, filePath, content, options);
  }

  updateFile(filePath: string, content: string): Promise<void> {
    return documents.updateFile(this.core, filePath, content);
  }

  touchFile(
    filePath: string,
    content: string,
    options: LSPTouchFileOptions = {},
  ): Promise<TouchFileResult | undefined> {
    return touch.touchFile(this.core, filePath, content, options);
  }

  getDiagnosticsHealth(filePath: string): LSPDiagnosticsHealth | undefined {
    return diagnostics.getDiagnosticsHealth(this.core, filePath);
  }

  getLastKnownDiagnostics(
    filePath: string,
    expectedContentHash?: string,
  ): import("./client.ts").LSPDiagnostic[] | undefined {
    return diagnostics.getLastKnownDiagnostics(this.core, filePath, expectedContentHash);
  }

  getDiagnostics(
    filePath: string,
    diagnosticsMode: LSPDiagnosticsMode = "full",
  ): Promise<import("./client.ts").LSPDiagnostic[]> {
    return diagnostics.getDiagnostics(this.core, filePath, diagnosticsMode);
  }

  definition(filePath: string, line: number, character: number) {
    return navigation.definition(this.core, filePath, line, character);
  }

  typeDefinition(filePath: string, line: number, character: number) {
    return navigation.typeDefinition(this.core, filePath, line, character);
  }

  declaration(filePath: string, line: number, character: number) {
    return navigation.declaration(this.core, filePath, line, character);
  }

  references(filePath: string, line: number, character: number, includeDeclaration = true) {
    return navigation.references(this.core, filePath, line, character, includeDeclaration);
  }

  hover(filePath: string, line: number, character: number) {
    return navigation.hover(this.core, filePath, line, character);
  }

  signatureHelp(filePath: string, line: number, character: number) {
    return navigation.signatureHelp(this.core, filePath, line, character);
  }

  documentSymbol(filePath: string) {
    return navigation.documentSymbol(this.core, filePath);
  }

  workspaceSymbol(query: string, filePath?: string) {
    return navigation.workspaceSymbol(this.core, query, filePath);
  }

  getAdvertisedCommands(filePath?: string): Promise<string[]> {
    return navigation.getAdvertisedCommands(this.core, filePath);
  }

  executeCommand(
    filePath: string | undefined,
    command: string,
    args?: unknown[],
    mutationContext?: LspMutationContext,
  ): Promise<{ executed: boolean; result?: unknown; reason?: string }> {
    return navigation.executeCommand(this.core, filePath, command, args, mutationContext);
  }

  executeReadOnlyCommandOnLiveClient(
    filePath: string,
    command: string,
    args?: unknown[],
  ): Promise<{ executed: boolean; result?: unknown; reason?: string }> {
    return navigation.executeReadOnlyCommandOnLiveClient(this.core, filePath, command, args);
  }

  getOperationSupport(
    filePath?: string,
  ): Promise<import("./client.ts").LSPOperationSupport | null> {
    return navigation.getOperationSupport(this.core, filePath);
  }

  getCapabilitySnapshots(filePath?: string): Promise<LSPCapabilitySnapshot[]> {
    return navigation.getCapabilitySnapshots(this.core, filePath);
  }

  getWorkspaceDiagnosticsSupport(
    filePath?: string,
  ): Promise<import("./client.ts").LSPWorkspaceDiagnosticsSupport | null> {
    return navigation.getWorkspaceDiagnosticsSupport(this.core, filePath);
  }

  codeAction(
    filePath: string,
    line: number,
    character: number,
    endLine: number,
    endCharacter: number,
  ) {
    return navigation.codeAction(this.core, filePath, line, character, endLine, endCharacter);
  }

  rename(filePath: string, line: number, character: number, newName: string) {
    return renaming.rename(this.core, filePath, line, character, newName);
  }

  renameFile(
    oldFilePath: string,
    newFilePath: string,
    options: { cwd: string; apply?: boolean; mutationContext?: LspMutationContext },
  ): Promise<LSPRenameFileResult> {
    return renaming.renameFile(this.core, oldFilePath, newFilePath, options);
  }

  implementation(filePath: string, line: number, character: number) {
    return navigation.implementation(this.core, filePath, line, character);
  }

  prepareCallHierarchy(filePath: string, line: number, character: number) {
    return navigation.prepareCallHierarchy(this.core, filePath, line, character);
  }

  incomingCalls(item: import("./client.ts").LSPCallHierarchyItem) {
    return navigation.incomingCalls(this.core, item);
  }

  outgoingCalls(item: import("./client.ts").LSPCallHierarchyItem) {
    return navigation.outgoingCalls(this.core, item);
  }

  ensureWarmForSweep(
    representativeFile: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{
    performedWarmup: boolean;
    failedServerIds: string[];
    skippedFromCache?: boolean;
  }> {
    return warmup.ensureWarmForSweep(this.core, representativeFile, options);
  }

  runWorkspaceDiagnostics(
    cwd: string,
    options: {
      maxFiles?: number;
      signal?: AbortSignal;
      onProgress?: (completed: number, total: number) => void;
      onServerReady?: () => void;
      nextWriteIndex?: () => number;
      files?: string[];
    } = {},
  ): Promise<LSPWorkspaceDiagnosticResult[]> {
    return workspace.runWorkspaceDiagnostics(this.core, cwd, options);
  }

  getAllDiagnostics(): Promise<
    Map<
      string,
      {
        diags: import("./client.ts").LSPDiagnostic[];
        ts: number;
        binding?: DiagnosticBinding;
      }
    >
  > {
    return diagnostics.getAllDiagnostics(this.core);
  }

  supportsLSP(filePath: string): boolean {
    return clients.supportsLSP(filePath);
  }

  isSpawnInFlight(filePath: string): boolean {
    return clients.isSpawnInFlight(this.core, filePath);
  }

  hasWarmLSP(filePath: string): Promise<boolean> {
    return clients.hasWarmLSP(this.core, filePath);
  }

  hasLSP(filePath: string): Promise<boolean> {
    return clients.hasLSP(this.core, filePath);
  }

  shutdown(options: LSPShutdownOptions = {}): Promise<void> {
    return lifecycle.shutdown(this.core, options);
  }

  getStatus(): Array<{
    serverId: string;
    root: string;
    connected: boolean;
    pullFailureHistory: LSPPullFailure[];
  }> {
    return lifecycle.getStatus(this.core);
  }

  getBrokenStatus(): Array<{
    serverId: string;
    root: string;
    failures: number;
    permanentlyBroken: boolean;
    cooldownUntil: number;
  }> {
    return lifecycle.getBrokenStatus(this.core);
  }

  getAliveClientCount(): number {
    return lifecycle.getAliveClientCount(this.core);
  }

  getAliveServerIds(): string[] {
    return lifecycle.getAliveServerIds(this.core);
  }
}

let globalLSPService: LSPService | null = null;
let globalLSPGenerationHandoff: Promise<void> | undefined;

export function getLSPService(): LSPService {
  if (!globalLSPService) {
    globalLSPService = new LSPService(globalLSPGenerationHandoff);
  }
  return globalLSPService;
}

export async function isAuxiliaryLspAlive(serverId: string, filePath: string): Promise<boolean> {
  return getLSPService().isServerAliveForFile(serverId, filePath);
}

export async function notifyExternalFileChange(filePath: string, type: number): Promise<void> {
  return getLSPService().notifyExternalFileChange(filePath, type);
}

export function resetLSPService(options: LSPShutdownOptions = {}): void {
  if (options.reason === "session_start") {
    resetClassicTsRepairGuard();
    clearWorkspaceSweepHoldForSessionStart();
  }
  const retiringService = globalLSPService;
  globalLSPService = null;
  if (!retiringService) return;

  const teardown = retiringService.shutdown(options);
  const pending = globalLSPGenerationHandoff ? [globalLSPGenerationHandoff, teardown] : [teardown];
  const handoff = Promise.allSettled(pending).then(() => undefined);
  globalLSPGenerationHandoff = handoff;
  void handoff.then(() => {
    if (globalLSPGenerationHandoff === handoff) {
      globalLSPGenerationHandoff = undefined;
    }
  });
}

export function __collectWorkspaceDiagnosticFilesForTest(
  root: string,
  maxFiles?: number,
  signal?: AbortSignal,
  homeDir?: string,
): Promise<string[]> {
  return collectWorkspaceDiagnosticFiles(
    path.resolve(root),
    maxFiles ?? getMaxWorkspaceDiagnosticFiles(),
    signal,
    homeDir,
  );
}
