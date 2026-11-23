/**
 * LSP Service Layer for choco-pi-lsp
 *
 * Manages multiple LSP clients per workspace with:
 * - Auto-spawning based on file type
 * - Effect-TS service composition
 * - Bus event integration
 * - Resource cleanup
 */

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

// --- Service ---

export class LSPService {
  /** Former private fields; see {@link LSPServiceInternals}. */
  private readonly core: LSPServiceInternals;

  constructor(generationHandoff?: Promise<void>) {
    this.core = createLSPServiceInternals(this, generationHandoff);
  }

  /**
   * Get or create LSP client for a file
   * Prevents duplicate client creation via in-flight promise tracking
   */
  getClientForFile(
    filePath: string,
    maxWaitMs?: number,
    hardCapMs?: number,
  ): Promise<SpawnedServer | undefined> {
    return clients.getClientForFile(this.core, filePath, maxWaitMs, hardCapMs);
  }

  /**
   * Get or create ALL LSP clients that can serve a file.
   * Used for diagnostics aggregation across complementary servers.
   */
  getClientsForFile(
    filePath: string,
    excludeServerIds?: ReadonlySet<string>,
  ): Promise<{ clients: SpawnedServer[]; serverCountAttempted: number }> {
    return clients.getClientsForFile(this.core, filePath, excludeServerIds);
  }

  /**
   * Spawn/get the AUXILIARY clients for a file (role:"auxiliary") restricted to
   * the enabled set. These attach alongside the primary on the with-auxiliary
   * diagnostics path (cross-cutting scanners like opengrep).
   */
  getAuxiliaryClientsForFile(
    filePath: string,
    enabledIds: ReadonlySet<string>,
  ): Promise<SpawnedServer[]> {
    return clients.getAuxiliaryClientsForFile(this.core, filePath, enabledIds);
  }

  /**
   * Get a warm LSP client for a file without spawning.
   * Returns undefined if no matching client is already connected and alive.
   */
  getWarmClientForFile(filePath: string): Promise<SpawnedServer | undefined> {
    return clients.getWarmClientForFile(this.core, filePath);
  }

  /**
   * Read-only liveness check for one server/file pair. Unlike
   * `getClientForFile`, this never creates or warms a client; it only resolves
   * the server's root and checks the already-connected client map.
   */
  isServerAliveForFile(serverId: string, filePath: string): Promise<boolean> {
    return clients.isServerAliveForFile(this.core, serverId, filePath);
  }

  /**
   * #1668: deliver a `workspace/didChangeWatchedFiles` event for a disk
   * change the client did not author through open-document sync — a bash
   * write/delete, or any other external change. `type` is the LSP
   * `FileChangeType` (1 Created, 2 Changed, 3 Deleted).
   *
   * Only reaches ALREADY-ACTIVE clients for this file's servers — a server
   * that hasn't been spawned yet has no stale cache to correct, so this
   * never spawns one just to deliver the notification. Each affected
   * client enqueues into its own #271 debounced queue, so a burst of
   * external changes still coalesces into one notification per server.
   */
  notifyExternalFileChange(filePath: string, type: number): Promise<void> {
    return documents.notifyExternalFileChange(this.core, filePath, type);
  }

  /**
   * Open a file in LSP (sends textDocument/didOpen)
   */
  openFile(
    filePath: string,
    content: string,
    options?: { preserveDiagnostics?: boolean; spawnBudgetMs?: number },
  ): Promise<void> {
    return documents.openFile(this.core, filePath, content, options);
  }

  /**
   * Update file content (sends textDocument/didChange)
   */
  updateFile(filePath: string, content: string): Promise<void> {
    return documents.updateFile(this.core, filePath, content);
  }

  /**
   * Touch a file like OpenCode's LSP flow: ensure document is open/synced,
   * and optionally collect diagnostics with explicit scope.
   */
  touchFile(
    filePath: string,
    content: string,
    options: LSPTouchFileOptions = {},
  ): Promise<
    // #1179 (shape-5 structural fix): a WRAPPER, not the bare array. `.diags`
    // carries the diagnostics; `.inconclusive` (#570/#1093) and `.binding`
    // (#1095) are EXPLICIT ENUMERABLE fields, so a `[...]`/`.map`/`.filter`/
    // `JSON` copy of `.diags` cannot silently drop them (was the #1094/#1096
    // copy-loss class — the flags used to ride the array as non-enumerable
    // side-channels). See `TouchFileResult` for the field-presence contract.
    TouchFileResult | undefined
  > {
    return touch.touchFile(this.core, filePath, content, options);
  }

  /**
   * Get diagnostics for a file
   */
  getDiagnosticsHealth(filePath: string): LSPDiagnosticsHealth | undefined {
    return diagnostics.getDiagnosticsHealth(this.core, filePath);
  }

  /**
   * Return whatever LSP diagnostics were last cached for this file without
   * triggering a fresh open / wait / merge. Returns `undefined` when nothing
   * was ever cached; callers should treat that as distinct from "cached but
   * empty" (`[]`), which means LSP confirmed no diagnostics last time.
   *
   * Intended for hot-path consumers (e.g. actionable-warnings at turn_end)
   * that already paid for a `touchFile` during dispatch and just want to
   * read the result without a second LSP round trip.
   *
   * Pass `expectedContentHash` (sha256 of the current file bytes) to guard
   * against staleness: the entry is returned only when it was primed by a
   * `touchFile` for the *same* content. On mismatch — or for an entry written
   * without content (the service-level merge) — this returns `undefined` so the
   * caller does a fresh check instead of serving a previous turn's diagnostics.
   * Omit it for display consumers (the widget) that accept last-known.
   */
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

  /**
   * Navigation: go to definition
   */
  definition(filePath: string, line: number, character: number) {
    return navigation.definition(this.core, filePath, line, character);
  }

  /**
   * Navigation: go to the type definition of the symbol at a position
   */
  typeDefinition(filePath: string, line: number, character: number) {
    return navigation.typeDefinition(this.core, filePath, line, character);
  }

  /**
   * Navigation: go to the declaration of the symbol at a position
   */
  declaration(filePath: string, line: number, character: number) {
    return navigation.declaration(this.core, filePath, line, character);
  }

  /**
   * Navigation: find all references
   */
  references(filePath: string, line: number, character: number, includeDeclaration = true) {
    return navigation.references(this.core, filePath, line, character, includeDeclaration);
  }

  /**
   * Navigation: hover info
   */
  hover(filePath: string, line: number, character: number) {
    return navigation.hover(this.core, filePath, line, character);
  }

  /**
   * Navigation: signature help at cursor position
   */
  signatureHelp(filePath: string, line: number, character: number) {
    return navigation.signatureHelp(this.core, filePath, line, character);
  }

  /**
   * Navigation: symbols in document
   */
  documentSymbol(filePath: string) {
    return navigation.documentSymbol(this.core, filePath);
  }

  /**
   * Navigation: workspace-wide symbol search
   */
  workspaceSymbol(query: string, filePath?: string) {
    return navigation.workspaceSymbol(this.core, query, filePath);
  }

  /**
   * Commands advertised for workspace/executeCommand. If filePath is given,
   * the server for that file; otherwise the first active client.
   */
  getAdvertisedCommands(filePath?: string): Promise<string[]> {
    return navigation.getAdvertisedCommands(this.core, filePath);
  }

  /**
   * Run a server command via workspace/executeCommand (hardened: allowlisted by
   * advertisement in the client). If filePath is given, target that file's
   * server; otherwise the first active client.
   */
  executeCommand(
    filePath: string | undefined,
    command: string,
    args?: unknown[],
    mutationContext?: LspMutationContext,
  ): Promise<{ executed: boolean; result?: unknown; reason?: string }> {
    return navigation.executeCommand(this.core, filePath, command, args, mutationContext);
  }

  /**
   * #1640: run a read-only probe command against a server that is ALREADY
   * running for this file. Two hard guarantees the mutation-channel
   * `executeCommand` above cannot give a render-path probe:
   *
   * - **Never spawns.** It resolves the already-connected client map the way
   *   `isServerAliveForFile` does, instead of routing through
   *   `getClientForFile` → `ensureClientForServer`. A probe that spawns a
   *   language-server fleet to answer a question about how to RENDER a
   *   diagnostic is a cost the caller never asked for — and under warm attach
   *   the freshly spawned server's answer would not even be the warm session's
   *   answer.
   * - **Never opens the mutation window.** `executeReadOnlyCommand` leaves
   *   `serverEditsAllowed` and `activeMutationContext` alone, so an in-flight
   *   real command's mutation context survives a concurrent probe.
   *
   * Returns `{executed:false}` — never a thrown error and never a spawn — when
   * no live client owns the file. Callers must read that as UNKNOWN.
   */
  executeReadOnlyCommandOnLiveClient(
    filePath: string,
    command: string,
    args?: unknown[],
  ): Promise<{ executed: boolean; result?: unknown; reason?: string }> {
    return navigation.executeReadOnlyCommandOnLiveClient(this.core, filePath, command, args);
  }

  /**
   * Capability snapshot for LSP operations.
   * If filePath is provided, probes that server; otherwise uses first active client.
   */
  getOperationSupport(
    filePath?: string,
  ): Promise<import("./client.ts").LSPOperationSupport | null> {
    return navigation.getOperationSupport(this.core, filePath);
  }

  /**
   * Capability snapshot for workspace diagnostics support.
   * If filePath is provided, probes that server; otherwise uses first active client.
   */
  getCapabilitySnapshots(filePath?: string): Promise<LSPCapabilitySnapshot[]> {
    return navigation.getCapabilitySnapshots(this.core, filePath);
  }

  getWorkspaceDiagnosticsSupport(
    filePath?: string,
  ): Promise<import("./client.ts").LSPWorkspaceDiagnosticsSupport | null> {
    return navigation.getWorkspaceDiagnosticsSupport(this.core, filePath);
  }

  /**
   * Navigation: available code actions at position/range
   */
  codeAction(
    filePath: string,
    line: number,
    character: number,
    endLine: number,
    endCharacter: number,
  ) {
    return navigation.codeAction(this.core, filePath, line, character, endLine, endCharacter);
  }

  /**
   * Navigation: rename symbol at position
   */
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

  /**
   * Navigation: go to implementation
   */
  implementation(filePath: string, line: number, character: number) {
    return navigation.implementation(this.core, filePath, line, character);
  }

  /**
   * Navigation: prepare call hierarchy at position
   */
  prepareCallHierarchy(filePath: string, line: number, character: number) {
    return navigation.prepareCallHierarchy(this.core, filePath, line, character);
  }

  /**
   * Navigation: find incoming calls (callers)
   */
  incomingCalls(item: import("./client.ts").LSPCallHierarchyItem) {
    return navigation.incomingCalls(this.core, item);
  }

  /**
   * Navigation: find outgoing calls (callees)
   */
  outgoingCalls(item: import("./client.ts").LSPCallHierarchyItem) {
    return navigation.outgoingCalls(this.core, item);
  }

  /**
   * #667: shared warm-check/ensure-warm step for BOTH `lsp_diagnostics`
   * (`tools/lsp-diagnostics.ts`'s batch/directory sweep) and
   * `diagnostics_report mode=full` (`runWorkspaceDiagnostics` below) — one
   * implementation instead of two hand-copied ones, since both already
   * share `groupFilesByPrimaryServer`/`runPerServerGroups` (#631).
   *
   * Root cause this closes (#667): `serverCountReady:1` only proves the
   * server process spawned and passed the LSP `initialize` handshake — it
   * does NOT prove the server can usefully answer a diagnostics request
   * yet. tsserver-style servers can still be loading/indexing the project
   * internally for seconds after `initialize` resolves, and without this
   * check whichever file(s) land first in a sweep pay that cost as
   * individual per-file timeouts (observed: the first 5 files of a
   * 100-file sweep all hit the exact per-file ceiling with
   * `serverCountReady:1`, file 6 onward clean and fast).
   *
   * `representativeFile` should be one file from the group/batch about to
   * be swept — used only to resolve which server(s) serve it and, if
   * needed, to perform the warm-up touch itself.
   *
   * Cheap/no-op when every non-auxiliary server for `representativeFile`
   * has already answered a confirmed diagnostics touch earlier in THIS
   * session (`isDemonstratedReady` — set by `touchFile` above): resolves
   * the server list and root(s) (no spawn, no I/O beyond that) and
   * returns immediately. Only when at least one candidate server hasn't
   * demonstrated readiness does this perform one deliberate warm-up
   * `touchFile` round trip against `representativeFile`, bounded by its
   * OWN generous budget (`warmupTimeoutMs`/`CHOCO_PI_LSP_LSP_WARMUP_TIMEOUT_MS`
   * — distinct from the per-file sweep budget), and waits for it to
   * settle (success, timeout, or abort) before returning. This does NOT
   * change the per-file wait budgets or confirmed/unconfirmed contract
   * (#242/#611/#634) the sweep itself uses — it only runs once, before
   * the sweep's own loop starts.
   *
   * Returns `performedWarmup: true` only when the round trip actually ran
   * (false = already warm, no-op) — tests assert on this to guard against
   * the warm-up becoming a mandatory extra round trip on every sweep.
   *
   * #744: a warm-up that TIMES OUT is no longer left as a silent dead end.
   * The old one-shot behavior left a wedged server (observed live: marksman,
   * a `workspaceIndexing` server, burned the full 20s and stayed cold) with
   * no re-warm and no skip — so every subsequent per-file touch in the sweep
   * re-paid a full per-file budget against it and timed out again, dragging
   * the whole sweep. Now: on a failed warm-up this retries exactly once (after
   * a short `warmupRetryBackoffMs` breather — the state where warm-up fails is
   * usually a server mid-relaunch/index that just needs a moment), and if the
   * retry ALSO leaves the server cold it is reported in `failedServerIds`. The
   * caller (the sweep loop) skips that server's files up front and marks them
   * unconfirmed, so per-file touches stop paying its timeout. This is a
   * sweep-scoped skip (the caller discards `failedServerIds` when the sweep
   * ends), deliberately NOT the global `broken` cooldown map: a server that is
   * merely still indexing is not broken and must not be cooldown-banned across
   * the whole session — it just wasn't ready for THIS sweep.
   *
   * "Failed warm-up" is measured per non-auxiliary server via the SAME
   * `demonstratedReady` signal `touchFile` marks on a confirmed round trip: a
   * server whose key is still absent from `demonstratedReady` after both
   * attempts never proved it can answer diagnostics. Warm-up stays
   * `clientScope:"primary"` (not the sweep's `"all"`) on purpose: `"all"`
   * would additionally spawn the sweep-EXCLUDED auxiliaries
   * (`WORKSPACE_SWEEP_EXCLUDED_SERVER_IDS`), which is work this warm-up does not
   * need. (Before #1549 it was also unsafe: `touchFile`'s `inconclusive` flag was
   * touch-wide, so one slow advisory auxiliary suppressed the `demonstratedReady`
   * marking for a perfectly healthy primary — falsely condemning it. The verdict is
   * per-server now, and the marking loop skips only the servers that did not answer
   * for themselves, so the scope choice is a cost argument rather than a
   * correctness one.) Recording per-primary-server outcomes and skipping
   * on those is the correct, non-regressing way to cover the servers the sweep
   * actually gates on (the sweep groups by primary server, so the group this
   * warms IS the one whose per-file touches would drag).
   */
  ensureWarmForSweep(
    representativeFile: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{
    performedWarmup: boolean;
    failedServerIds: string[];
    /** #799: true when `failedServerIds` came from the negative cache
     * (`demonstratedCold`) rather than a fresh warm-up attempt — lets a
     * caller/log distinguish "we already knew this was cold" from "this
     * attempt just failed". */
    skippedFromCache?: boolean;
  }> {
    return warmup.ensureWarmForSweep(this.core, representativeFile, options);
  }

  /**
   * Actively scan every LSP-supported source file under a project root.
   * This is intentionally expensive and used only by explicit project-wide tools.
   */
  runWorkspaceDiagnostics(
    cwd: string,
    options: {
      maxFiles?: number;
      signal?: AbortSignal;
      onProgress?: (completed: number, total: number) => void;
      /** Called after a cold sweep warm-up successfully brings a server group
       * online. The caller may use this to refresh host observability UI. */
      onServerReady?: () => void;
      /**
       * Reserve per-file reconciliation order at scan admission time. The
       * callback is never called at result-settlement time (#1198).
       */
      nextWriteIndex?: () => number;
      /**
       * Explicit file list (#461): skip the project walk entirely and route
       * exactly these files through the sweep. Used by diagnostics_report'
       * `paths` scope restrictor so a wrapper (e.g. "git-staged files only")
       * gets the full mode=full treatment without paying for a whole-project
       * walk. Caller is responsible for resolving/deduping/filtering these
       * (diagnostics-report.ts already applies the ignore matcher the same way
       * the walk does before calling in).
       */
      files?: string[];
    } = {},
  ): Promise<LSPWorkspaceDiagnosticResult[]> {
    return workspace.runWorkspaceDiagnostics(this.core, cwd, options);
  }

  /**
   * Get all diagnostics across all tracked files (for cascade checking)
   */
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

  /**
   * Check whether a file type/root has any configured LSP support.
   * Pure capability check — does not spawn or wait for clients.
   */
  supportsLSP(filePath: string): boolean {
    return clients.supportsLSP(filePath);
  }

  /**
   * Check whether the PRIMARY server for this file is currently mid-spawn
   * (`state.inFlight`, keyed `${server.id}:${normalizeMapKey(root)}` — see
   * :2413). Lets a caller whose own wait budget expires distinguish "the
   * server hasn't finished its first spawn yet" from "the server is running
   * but slow/wedged" (#1766) — a cold spawn still in flight is not a verdict
   * on a server that doesn't exist yet.
   *
   * Mirrors the `role !== "auxiliary"` filter getClientForFile applies at
   * :2146-2148 (kept coupled to that line intentionally): auxiliary servers
   * (opengrep, typos, …) spawn routinely and concurrently with an ALREADY
   * ALIVE primary (dispatch/runners/lsp.ts's with-auxiliary path fires one
   * per edit for most files via TYPOS_EXTENSIONS). Without this filter, an
   * unrelated auxiliary spawn would downgrade a genuinely wedged primary to
   * a benign "spawn-in-flight" verdict — the worse misreport direction.
   *
   * Root-blind: the match is a `${server.id}:` PREFIX over inFlight keys, not
   * an exact `${server.id}:${root}` match, because root resolution
   * (resolveServerRoot) is async and this must stay synchronous for the
   * caller's bail path. A same-server spawn in an unrelated workspace root
   * also reports true. Rare in practice (this codebase is single-root per
   * choco-pi-lsp session in the overwhelming common case) and the failure mode is
   * the same "downgrade wedged to spawn-in-flight" direction as the
   * auxiliary case above — acceptable for a log-wording hint, not a gate.
   * Pure lookup — does not spawn or wait for a client.
   */
  isSpawnInFlight(filePath: string): boolean {
    return clients.isSpawnInFlight(this.core, filePath);
  }

  /**
   * Check whether an LSP client is already alive for a file.
   * Lightweight — does not spawn or wait for a client.
   */
  hasWarmLSP(filePath: string): Promise<boolean> {
    return clients.hasWarmLSP(this.core, filePath);
  }

  /**
   * Check if LSP is available for a file.
   * May spawn a client; prefer supportsLSP()/hasWarmLSP() when you only need
   * a capability or warm-state check.
   */
  hasLSP(filePath: string): Promise<boolean> {
    return clients.hasLSP(this.core, filePath);
  }

  /**
   * Shutdown all LSP clients
   */
  shutdown(options: LSPShutdownOptions = {}): Promise<void> {
    return lifecycle.shutdown(this.core, options);
  }

  /**
   * Get status of all active clients
   */
  getStatus(): Array<{
    serverId: string;
    root: string;
    connected: boolean;
    pullFailureHistory: LSPPullFailure[];
  }> {
    return lifecycle.getStatus(this.core);
  }

  /**
   * Read-only circuit-breaker status, including server/root pairs that have no
   * live client and would therefore be absent from getStatus().
   *
   * #1127: `failureCounts` (spawn/init failures) and `runtimeExitCounts`
   * (early post-init runtime exits) are two INDEPENDENT streams feeding one
   * circuit — either can trip its own cooldown/permanent-disable on its own
   * threshold, without the other. `failures` below is their SUM, purely for
   * display: it is the total churn behind whatever cooldown/permanent state
   * is showing, not a claim that both streams are at that count.
   */
  getBrokenStatus(): Array<{
    serverId: string;
    root: string;
    failures: number;
    permanentlyBroken: boolean;
    cooldownUntil: number;
  }> {
    return lifecycle.getBrokenStatus(this.core);
  }

  /**
   * Count clients that are currently alive (connected and initialized).
   * Lightweight — does not spawn or wait for anything.
   */
  getAliveClientCount(): number {
    return lifecycle.getAliveClientCount(this.core);
  }

  /**
   * Distinct serverIds of currently-alive clients, ordered primary-first then
   * auxiliary (cross-cutting scanners like opengrep/ast-grep), stable within
   * each group. Deduped across roots — one warm server serving two roots
   * collapses to a single id. Lightweight: does not spawn or wait. (#267)
   */
  getAliveServerIds(): string[] {
    return lifecycle.getAliveServerIds(this.core);
  }
}

// --- Singleton Instance ---

let globalLSPService: LSPService | null = null;
/**
 * #850: all singleton generations whose teardown is still pending. A new
 * generation may be allocated synchronously, but its first spawn waits on this
 * handoff so two generations can never own the same server/root concurrently.
 */
let globalLSPGenerationHandoff: Promise<void> | undefined;

export function getLSPService(): LSPService {
  if (!globalLSPService) {
    globalLSPService = new LSPService(globalLSPGenerationHandoff);
  }
  return globalLSPService;
}

/**
 * Cross-layer liveness seam for dispatch-side auxiliary gates. This is a
 * liveness read only: it does not spawn, wait for initialization, or probe a
 * binary.
 */
export async function isAuxiliaryLspAlive(serverId: string, filePath: string): Promise<boolean> {
  return getLSPService().isServerAliveForFile(serverId, filePath);
}

/**
 * Cross-layer seam (#1668) for callers outside `lsp/` (bash/write tool-result
 * handling) that observe a disk change no open-document sync path will ever
 * report — an external delete/create/modify. Delivers to already-active
 * clients only; see `LSPService.notifyExternalFileChange`.
 */
export async function notifyExternalFileChange(filePath: string, type: number): Promise<void> {
  return getLSPService().notifyExternalFileChange(filePath, type);
}

export function resetLSPService(options: LSPShutdownOptions = {}): void {
  // A new session must get its own classic-tsserver-repair attempt: the
  // guard is a process-lifetime flag (see resetClassicTsRepairGuard), so a
  // repair that failed transiently in an earlier session must not stay
  // latched for the rest of the extension-host process (#1570).
  if (options.reason === "session_start") {
    resetClassicTsRepairGuard();
    // #1618 (R3): a hold from a PRIOR generation's sweep must never survive
    // a session boundary — state that must re-arm at session_start cannot
    // hide behind a leaked/stuck guard from the generation before it.
    clearWorkspaceSweepHoldForSessionStart();
  }
  const retiringService = globalLSPService;
  globalLSPService = null;
  if (!retiringService) return;

  // shutdown() marks the service destroyed synchronously before its first
  // await. Include both that teardown and every earlier pending generation:
  // repeated resets may retire a replacement that is itself still waiting on
  // its predecessor. allSettled keeps teardown best-effort without ever
  // rejecting (and therefore permanently poisoning) the next generation.
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

/**
 * Test-only: exposes the async workspace-diagnostics file walk so its
 * event-loop occupancy can be guarded (see workspace-diagnostics-occupancy
 * test). Not part of the public API.
 */
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
