import type { LSPClientInfo } from "./client.ts";
import { type BoundToCurrentDisk } from "./diagnostic-binding.ts";
import type { LSPServerInfo } from "./server.ts";

export interface LSPState {
  clients: Map<string, LSPClientInfo>;
  servers: Map<string, LSPServerInfo>;
  broken: Map<string, number>;
  inFlight: Map<string, Promise<SpawnedServer | undefined>>;
  clientSpawnedAt: Map<string, number>;
  demonstratedReady: Set<string>;
  demonstratedCold: Set<string>;
}

export interface SpawnedServer {
  client: LSPClientInfo;
  info: LSPServerInfo;
}

export type RenameNotifyDisposition = "timedOut" | "rejected";

export interface RenameNotifyFailure {
  serverId: string;
  error: string;
  disposition: RenameNotifyDisposition;
}

export interface LSPRenameFileResult {
  applied: boolean;
  serverIds: string[];
  willRenameFailures: Array<{ serverId: string; error: string }>;
  didRenameFailures: RenameNotifyFailure[];
  droppedConflicts: number;
  inputEditCount: number;
  summary: string[];
  descriptions?: string[];
  files?: string[];
}

export interface LSPDiagnosticsHealth {
  health: "ok" | "ok_empty" | "no_clients" | "no_clients_stale" | "destroyed";
  failureKind: string;
  serverCountAttempted: number;
  serverCountReady: number;
  candidateServerIds: string[];
  mergedCount: number;
  dedupDroppedCount: number;
  checkedAt: string;
}

export type LSPDiagnosticsMode = "none" | "document" | "full";

export type LSPTouchClientScope = "primary" | "all" | "with-auxiliary";

export interface LSPTouchFileOptions {
  diagnostics?: LSPDiagnosticsMode;
  source?: string;
  clientScope?: LSPTouchClientScope;
  auxiliaryServerIds?: readonly string[];
  excludeServerIds?: ReadonlySet<string>;
  maxClientWaitMs?: number;
  maxDiagnosticsWaitMs?: number;
  collectDiagnostics?: boolean;
  silent?: boolean;
  sweepIndexGate?: SweepIndexGate;
  warmupOverride?: boolean;
  warmupAttempt?: number;
}

export type LSPWorkspaceUnconfirmedReason =
  | "budget"
  | "inconclusive"
  | "coverage_gap"
  | "service_destroyed"
  | "error"
  | "binding_mismatch";

export interface LSPWorkspaceDiagnosticResult {
  filePath: string;
  diagnostics: import("./client.ts").LSPDiagnostic[];
  count: number;
  error?: string;
  timedOut?: boolean;
  unconfirmedReason?: LSPWorkspaceUnconfirmedReason;
  skippedWarmupFailure?: boolean;
  observedAt?: number;
  contentHash?: string;
  writeIndex?: number;
  boundToCurrentDisk?: BoundToCurrentDisk;
}

export interface SweepIndexGate {
  consumeFirstTouch(serverId: string): boolean;
}
