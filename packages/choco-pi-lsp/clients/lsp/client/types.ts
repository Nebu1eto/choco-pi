/**
 * Public LSP client types (diagnostics, locations, symbols, operation support, client info) and the internal client state record.
 */
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
  severity: 1 | 2 | 3 | 4; // Error, Warning, Info, Hint
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
  /**
   * The server advertises `workspace/diagnostic` (a single project-wide pull),
   * distinct from `mode: "pull"` which only reflects per-document
   * `textDocument/diagnostic` support.
   */
  workspaceDiagnostics: boolean;
  diagnosticProviderKind: string;
}

export interface LSPShutdownOptions {
  /**
   * Fast shutdown is for process/session teardown paths where extension cleanup
   * must not keep the TUI or Node process alive. It sends exit/kill signals and
   * unreferences child handles/timers instead of waiting for graceful escalation.
   */
  fast?: boolean;
  /**
   * Set only when the host process itself is exiting (e.g. `session_shutdown`
   * during `pi update`), i.e. the event loop is already closing. In that state,
   * spawning a child process (the Windows `taskkill /T` tree-kill) makes libuv
   * call `uv_async_send` on the closing loop-wakeup handle and hard-aborts
   * (Assertion `!(handle->flags & UV_HANDLE_CLOSING)`, `src\win\async.c`). When
   * set, we kill via the handle we already hold (synchronous `TerminateProcess`,
   * no new async handle) instead of spawning. Distinct from `fast`, which also
   * covers mid-session teardowns (subagent/turn boundaries) where the host keeps
   * running and the `/T` tree-kill is still wanted to avoid zombie accumulation.
   */
  processExiting?: boolean;
  /**
   * Human-readable label identifying why this shutdown was triggered — e.g.
   * `"session_start"`, `"idle"`, `"session_shutdown"`, `"pipeline_crash"`.
   * Written to latency.log as `lsp_service_reset.metadata.reason` so the death
   * side of the LSP lifecycle is distinguishable from the birth side.
   */
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

// --- Call Hierarchy Types ---

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
  /** Check if the connection is still alive */
  isAlive: () => boolean;
  /** True if the server process has exited or been killed */
  processExited: () => boolean;
  /**
   * #1127: true only when THIS client's own `shutdown()` was called before
   * it went dead (session teardown, `#743` notify-backpressure eviction,
   * generation resets, …). False for a genuine crash — process exit/signal
   * with no preceding `shutdown()` call — so a caller respawning a dead
   * client can tell a deliberate kill apart from an unexpected runtime exit
   * and only count the latter toward the failure breaker.
   */
  wasShutdownIntentional: () => boolean;
  /**
   * #1127: wall-clock time this client FIRST observed its own death
   * (connection close/error or process exit, whichever fires first), or
   * `undefined` if it hasn't died yet. A caller computing server lifetime
   * MUST use this, not the time it happened to notice the client was dead —
   * detection is lazy (the next file attach) and can trail the actual death
   * by minutes to hours (#1127's documented opengrep pattern), which would
   * make every early crash look like a long, healthy run.
   */
  getExitedAt: () => number | undefined;
  /** Last N lines of server stderr for diagnostics */
  recentStderr: (lines?: number) => string;
  /** Bounded operational pull failures; unsupported-method errors are omitted. */
  getPullFailureHistory?: () => LSPPullFailure[];
  /** Pre-request health check — returns error string if process is dead */
  checkAlive: () => string | undefined;
  /**
   * #1277: cheap request round-trip proving the server is actually
   * responding, not merely that the process/connection hasn't died.
   * `isAlive()`/`checkAlive()` can't tell a wedged server (accepted the
   * notify write, then stopped answering) from a healthy one — this sends a
   * bounded real request and reports whether anything came back in time.
   * Optional so existing test/mock clients (pre-#1277) that don't implement
   * it don't need updating; callers treat a missing implementation as alive
   * (`pingLiveness?.() ?? true`), matching the codebase's existing optional-
   * capability-accessor pattern (`getRawCapabilityKeys`, `getLaunchVariant`).
   */
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
    /**
     * #1668: queue a `workspace/didChangeWatchedFiles` entry for a disk
     * change this client did not learn about through didOpen/didChange —
     * an external bash write/delete outside the open-document sync path.
     * `type` is the LSP `FileChangeType` (1 Created, 2 Changed, 3 Deleted).
     * Routes through the same #271 debounced queue as a first-time open, so
     * a burst of external changes still flushes as one notification.
     */
    watchedFileChange(filePath: string, type: number): void;
  };
  getDiagnostics(filePath: string): LSPDiagnostic[];
  /**
   * #1095: the stored content binding for the diagnostics currently tracked
   * for `filePath` — {version?, contentHash?} of the document version those
   * diagnostics were computed against. `undefined` when nothing is tracked or
   * the server never reported a version (a version-less server → caller treats
   * the binding as "unknown", i.e. pre-#1095 behavior).
   */
  getDiagnosticBinding(filePath: string): StoredDiagnosticBinding | undefined;
  /** Monotonic counter bumped when fresh diagnostics are stored for this client.
   *  Client-GLOBAL: any path's publication advances it, so it cannot answer
   *  "did this server report on file X?" — use `getDiagnosticsVersionForPath`. */
  readonly diagnosticsVersion: number;
  /**
   * #1531: the value `diagnosticsVersion` held when diagnostics were last stored
   * for `filePath` — 0 when this client has stored none. Compare a baseline read
   * before a notify against a later read to prove a publication landed for THAT
   * file, rather than for an unrelated one on the same client. REQUIRED: an
   * optional accessor let a double silently fall back to the global counter,
   * which is the very defect this closes — every client, real or test, answers
   * per path.
   */
  getDiagnosticsVersionForPath(filePath: string): number;
  waitForDiagnostics(
    filePath: string,
    timeoutMs?: number,
    options?: {
      minVersion?: number;
      pullOnly?: boolean;
      /** #1639: distinguishes a genuine content-collecting settle from a
       *  warm-up-only touch (`ensureWarmForSweep`'s readiness probe, which
       *  runs a real pull round trip but never wants the diagnostics
       *  content). Both are legitimate `lsp_typescript_diagnostic_sequence`
       *  observations for the same file, often seconds or milliseconds
       *  apart — tagging the source keeps them distinguishable instead of
       *  reading as duplicates. Defaults to "pull". */
      pullSettleSource?: "pull" | "pull-warmup";
    },
  ): Promise<void>;
  /** Get all tracked diagnostics with timestamps (for cascade checking). #1095:
   *  each entry also carries the stored content `binding` (absent when no
   *  version-bearing publish set it). */
  getAllDiagnostics(): Map<
    string,
    { diags: LSPDiagnostic[]; ts: number; binding?: StoredDiagnosticBinding }
  >;
  pruneDiagnostics(
    predicate: (filePath: string, ts: number, diags: LSPDiagnostic[]) => boolean,
  ): number;
  /**
   * Paths of every file with tracked diagnostics. Lets callers resolve
   * file existence asynchronously (off the event loop) and then prune with a
   * synchronous, in-memory predicate — instead of a blocking `existsSync` per
   * file inside `pruneDiagnostics`.
   */
  getTrackedDiagnosticPaths(): string[];
  /** Capability snapshot for workspace diagnostics support */
  getWorkspaceDiagnosticsSupport(): LSPWorkspaceDiagnosticsSupport;
  /**
   * Issue one project-wide `workspace/diagnostic` pull. Resolves per-file
   * reports, or `undefined` when unsupported/dead/timed-out/malformed.
   */
  requestWorkspaceDiagnostics(budgetMs: number): Promise<
    | Array<{
        filePath: string;
        diagnostics: LSPDiagnostic[];
        /** #1104: sha256 of the file bytes active at the moment this pull's
         *  answer for `filePath` was resolved — present for a "full" report
         *  (fresh read) or inherited from the prior pull for an "unchanged"
         *  one; absent only when the file could not be read. */
        contentHash?: string;
      }>
    | undefined
  >;
  /** Capability snapshot for navigation/edit operations */
  getOperationSupport(): LSPOperationSupport;
  /** Commands the server advertised for workspace/executeCommand (the allowlist) */
  getAdvertisedCommands(): string[];
  /** Top-level keys of the raw ServerCapabilities advertised at initialize —
   *  the full advertised surface (incl. providers choco-pi-lsp does not parse). */
  getRawCapabilityKeys(): string[];
  /** See `LSPServerInfo.spawn`'s `launchVariant` (server.ts) — which concrete
   *  binary/protocol variant this client instance is actually running.
   *  Undefined = single-variant server or not yet reported (fail-safe:
   *  consumers must treat that as classic/default behavior). */
  getLaunchVariant(): "classic" | "native-ts7" | undefined;
  /**
   * Run a server command via workspace/executeCommand. Hardened: the command
   * MUST be in the server's advertised list or this rejects without sending.
   * Any resulting server-initiated workspace/applyEdit is applied during the
   * call (and only then).
   */
  executeCommand(
    command: string,
    args?: unknown[],
    mutationContext?: LspMutationContext,
  ): Promise<{ executed: boolean; result?: unknown; reason?: string }>;
  /**
   * #1412/#1640: read-only sibling of `executeCommand` for identity and
   * telemetry probes. Same allowlist-by-advertisement hardening, but it never
   * touches `serverEditsAllowed` / `activeMutationContext` — so a probe firing
   * mid-flight cannot wipe a concurrent real command's mutation context, and
   * cannot itself open the `workspace/applyEdit` acceptance window. Carries the
   * short probe timeout, not the generous mutation backstop.
   */
  executeReadOnlyCommand(
    command: string,
    args?: unknown[],
  ): Promise<{ executed: boolean; result?: unknown; reason?: string }>;
  /** Go to definition — returns Location[] */
  definition(filePath: string, line: number, character: number): Promise<LSPLocation[]>;
  /** Go to the type definition of the symbol at a position */
  typeDefinition(filePath: string, line: number, character: number): Promise<LSPLocation[]>;
  /** Go to the declaration of the symbol at a position */
  declaration(filePath: string, line: number, character: number): Promise<LSPLocation[]>;
  /** Find all references */
  references(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration?: boolean,
  ): Promise<LSPLocation[]>;
  /** Hover info at position */
  hover(filePath: string, line: number, character: number): Promise<LSPHover | null>;
  /** Signature help at position */
  signatureHelp(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LSPSignatureHelp | null>;
  /** Symbols in a document */
  documentSymbol(filePath: string): Promise<LSPSymbol[]>;
  /** Whether this exact document has already been opened on the server. */
  isDocumentOpen(filePath: string): boolean;
  /** Whether this client currently has an LSP request in flight. */
  isBusy?(): boolean;
  /** URI spelling used when this document was opened. */
  getDocumentUri(filePath: string): string | undefined;
  /** Close an open document, if present, without opening or spawning anything. */
  closeDocument(filePath: string): Promise<void>;
  /** Workspace-wide symbol search */
  workspaceSymbol(query: string): Promise<LSPSymbol[]>;
  /** Available code actions at a range */
  codeAction(
    filePath: string,
    line: number,
    character: number,
    endLine: number,
    endCharacter: number,
  ): Promise<LSPCodeAction[]>;
  /** Rename symbol at position */
  rename(
    filePath: string,
    line: number,
    character: number,
    newName: string,
  ): Promise<LSPWorkspaceEdit | null>;
  /** Ask server for edits before a source file rename. */
  willRenameFiles(oldFilePath: string, newFilePath: string): Promise<LSPWorkspaceEdit | null>;
  /** Notify server after a source file rename. */
  didRenameFiles(
    oldFilePath: string,
    newFilePath: string,
    oldUri?: string,
    newUri?: string,
  ): Promise<void>;
  /** Go to implementation */
  implementation(filePath: string, line: number, character: number): Promise<LSPLocation[]>;
  /** Prepare call hierarchy at position */
  prepareCallHierarchy(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LSPCallHierarchyItem[]>;
  /** Find incoming calls (callers) */
  incomingCalls(item: LSPCallHierarchyItem): Promise<LSPCallHierarchyIncomingCall[]>;
  /** Find outgoing calls (callees) */
  outgoingCalls(item: LSPCallHierarchyItem): Promise<LSPCallHierarchyOutgoingCall[]>;
  shutdown(options?: LSPShutdownOptions): Promise<void>;
}

// The crash guard lives in ./crash-guard.ts and is installed once per process:
// a module-local flag let every re-evaluated module graph add its own
// process listeners, each pinning that graph for the process lifetime.

// --- Client State + Module-level helpers ---

/**
 * #1667: one live `client/registerCapability` entry, with the fields of
 * `registerOptions` this client actually acts on.
 *
 * The map used to store the method name alone. That silently discarded
 * `identifier` — the diagnostic SOURCE a `textDocument/diagnostic` registration
 * speaks for. Roslyn registers "syntax", "semantic" and "analyzers" as separate
 * sources; vtsls does the same. With the identifier gone the pull path issued
 * one bare request and every other source's findings were never asked for.
 * `workspaceDiagnostics` was discarded the same way, so workspace-pull support
 * had to be guessed from the method name.
 */
export interface DynamicRegistration {
  readonly method: string;
  /** `registerOptions.identifier`. Absent = the server's default/bare source. */
  readonly identifier?: string;
  /** `registerOptions.workspaceDiagnostics` — whether THIS registration also
   *  serves a workspace-wide pull. Absent = the server did not say. */
  readonly workspaceDiagnostics?: boolean;
  /** `registerOptions.commands` for a `workspace/executeCommand` registration. */
  readonly commands?: readonly string[];
}

export interface LSPClientState {
  isConnected: boolean;
  isDestroyed: boolean;
  /** Set only by clientShutdown() — distinguishes an intentional kill from a
   *  genuine crash so the exit handler below logs the latter even when the
   *  JSON-RPC connection's onClose/onError already flipped isConnected false
   *  before the process 'exit' event fires (the ordering that previously
   *  made every crash silently look "expected"). */
  shutdownRequested: boolean;
  /**
   * #1127: wall-clock time the client FIRST observed its own death (whichever
   * of connection close/error or the process 'exit' event fires first — see
   * `setupConnectionLifecycle`). Detection of a dead client happens lazily,
   * on the next `getClientForFile` attach — which, per #1127's real-world
   * pattern, can be minutes to hours after the process actually died. A
   * caller computing "how long did this server live" MUST use
   * `exitedAt - spawnedAt`, never `detectionTime - spawnedAt`: the latter
   * conflates "dead quickly" with "attached to rarely" and would wrongly
   * exempt an early-crashing server from the runtime-exit breaker just
   * because nobody happened to touch it again for a while. `undefined`
   * until the client actually dies.
   */
  exitedAt: number | undefined;
  connectionDisposed: boolean;
  lastError: Error | undefined;
  readonly connection: MessageConnection;
  readonly pushDiagnostics: Map<string, LSPDiagnostic[]>;
  readonly pushDiagnosticTimestamps: Map<string, number>;
  readonly documentPullDiagnostics: Map<string, LSPDiagnostic[]>;
  readonly documentPullDiagnosticTimestamps: Map<string, number>;
  /** Most recent operational pull failures, capped to avoid unbounded telemetry. */
  readonly pullFailureHistory: LSPPullFailure[];
  readonly pendingDiagnostics: Map<string, ReturnType<typeof setTimeout>>;
  /** Receive sequence and didOpen epoch used only for bounded TypeScript
   * diagnostic-publication telemetry. Plain Maps keyed by the already
   * normalized document path: every access site passes `normalizedPath`, and
   * a PathKeyedMap here would re-run the uncached realpath normalizer on the
   * hot JSON-RPC receive path (~60µs/call) for a value only telemetry reads. */
  readonly diagnosticPublicationCounts: Map<string, number>;
  readonly documentOpenedAt: Map<string, number>;
  readonly diagnosticEmitter: EventEmitter;
  diagnosticsVersion: number;
  /** #1531: the value `diagnosticsVersion` had when fresh diagnostics were last
   *  STORED for each path. It records the global counter's value rather than a
   *  private per-path sequence, so the numbers stay globally monotonic: a
   *  baseline captured for path A remains comparable even after A's entry is
   *  evicted, while a publication for path B never moves A's stamp. That is what
   *  lets the auxiliary evidence check ask "did this aux publish for THIS file?"
   *  instead of "did anything at all land on this client?". Written in lockstep
   *  with `pushDiagnostics`/`documentPullDiagnostics`, cleared by
   *  `clearDiagnosticsForPath`. A plain Map keyed by the already normalized path
   *  for the same hot-receive-path reason as `diagnosticPublicationCounts`
   *  above; readers fold their input through `normalizeMapKey`. */
  readonly diagnosticsVersionsByPath: Map<string, number>;
  readonly documentVersions: Map<string, number>;
  /** The LSP document version (`publishDiagnostics.version`) the cached
   *  diagnostics for a path were computed against. Only set when the server
   *  reports a version; absent entries mean "version unknown" and are treated
   *  as fresh so version-less servers keep working. */
  readonly diagnosticDocVersions: Map<string, number>;
  /** #1095: the exact content fingerprint of the LAST didOpen/didChange payload
   *  we sent for a path, tagged with the document version it was sent as.
   *  Captured at SEND time on in-memory content (never a disk read on the
   *  notification path) so a later `publishDiagnostics` echoing that version can
   *  bind its diagnostics to the content they were computed against.
   *
   *  #1669: `text` additionally retains that same payload's full content, but
   *  ONLY when `syncKind` is Incremental — the one case that needs it, to
   *  compute the NEXT change's full-range replace against the document as the
   *  server last saw it (see `buildContentChanges`). Full/None servers never
   *  populate it, so the common case pays no extra retained memory. */
  readonly documentContentHashes: Map<string, { version: number; hash: string; text?: string }>;
  /** #1095: the content binding for the diagnostics currently stored for a path
   *  — {version, contentHash} of the document those diagnostics were computed
   *  against. Set only when the accepted publish carried a version; a version-
   *  less server never populates this, so its binding reads "unknown" and
   *  behavior is unchanged. Kept in lockstep with `pushDiagnostics`: written on
   *  publish accept, cleared by `clearDiagnosticsForPath`. */
  readonly diagnosticBindings: Map<string, StoredDiagnosticBinding>;
  /** #1104: the server-issued `resultId` from the last `textDocument/diagnostic`
   *  pull for a path (primary or a `relatedDocuments` entry), so the NEXT pull
   *  can send it as `previousResultId` and receive an `unchanged` report instead
   *  of a full recompute. Cleared with the rest of a path's diagnostic state by
   *  `clearDiagnosticsForPath` so a resync never inherits a stale basis.
   *
   *  #1667: keyed by (path, diagnostic identifier), not by path alone — result
   *  ids are per SOURCE. A server registering several diagnostic sources
   *  (Roslyn: syntax/semantic/analyzers) issues an independent id per source,
   *  and echoing one source's id to another makes the server answer
   *  `unchanged` against a basis it never issued. Build keys with
   *  `pullSourceKey`; the bare (identifier-less) source keys on the plain path
   *  so single-source servers are byte-identical to before. */
  readonly pullResultIds: Map<string, string>;
  /** #1667: per-source pull diagnostics for a path — outer key the normalized
   *  path, inner key the diagnostic identifier (`""` for the bare source).
   *  `documentPullDiagnostics` holds the DEDUPED UNION of these, recomputed
   *  after every source's report, so each source can be replaced independently
   *  without one source's answer wiping another's. Optional: a state built
   *  before this field existed lazily gains it on first pull. */
  documentPullDiagnosticsBySource?: Map<string, Map<string, LSPDiagnostic[]>>;
  /** #1667: per-path pull generation, bumped by `clearDiagnosticsForPath`. The
   *  fan-out leaves losing pulls running so their results still merge into the
   *  cache; a resync that lands in that window must not be overwritten by a
   *  pull computed against the content it just replaced. A late write whose
   *  captured generation no longer matches is dropped. */
  pullGenerations?: Map<string, number>;
  /** #1667: the sequence number of the NEWEST request issued for each
   *  `pullSourceKey(path, identifier)`. The generation counter above only
   *  guards against a resync; it says nothing about two overlapping fan-outs
   *  for the SAME unchanged content. `ensureWarmForSweep` touches a file and
   *  the real touch follows ~60ms later, so touch 2 can re-pull a source and
   *  store a fresh answer while touch 1's slow answer for that same source is
   *  still in flight - and the late loser would clobber the newer result.
   *  Each request stamps its own number here; a write whose stamp is no longer
   *  the newest is dropped. */
  pullRequestSequences?: Map<string, number>;
  /** #1104: per-path cache of the last `workspace/diagnostic` pull's resultId +
   *  diagnostics + content binding, so an `unchanged` report in a LATER pull can
   *  inherit the prior basis instead of the record site staying stuck at
   *  "unknown" forever. Keyed by normalized path; `uri` retains the server's
   *  exact spelling for echoing back in `previousResultIds`. */
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
  /** Paths explicitly closed during this client lifetime; late publishes are dropped. */
  readonly closedDocuments?: Set<string>;
  /** Original URI spelling for each open document; path keys are normalized. */
  readonly openDocumentUris?: Map<string, string>;
  readonly pendingOpens: Set<string>;
  /** Normalized files already claimed by the classic tsserver project probe. */
  projectIdentityProbedFiles?: Set<string>;
  /** Mutable: updated by applyDynamicCapabilities after registerCapability events */
  workspaceDiagnosticsSupport: LSPWorkspaceDiagnosticsSupport;
  /** Mutable: upgraded by applyDynamicCapabilities after registerCapability events */
  operationSupport: LSPOperationSupport;
  /** Top-level keys of the raw ServerCapabilities from initialize (sorted) —
   *  captured once; the full advertised surface for diagnostics/documentation. */
  rawCapabilityKeys?: string[];
  /** Position encoding the server negotiated at initialize (#269). UTF-16 unless
   *  the server advertised otherwise; drives character-offset translation on
   *  outgoing navigation requests. */
  positionEncoding: PositionEncoding;
  /** #1669: `textDocumentSync.change` kind the server negotiated at initialize
   *  — None (0), Full (1) or Incremental (2). Optional so existing state
   *  literals across the test suite don't all need updating; every read site
   *  falls back to `TEXT_DOCUMENT_SYNC_KIND_FULL`, which is the whole-document
   *  `{ text }` shape choco-pi-lsp has always sent — an absent value never changes
   *  behavior. Set once at initialize, next to `positionEncoding`. */
  syncKind?: TextDocumentSyncKind;
  /** Baseline mode from static initResult — used to revert on unregister */
  staticDiagnosticsMode: "pull" | "push-only";
  /** Live dynamic registrations from client/registerCapability: id → record.
   *  #1667: the record carries the registration's `registerOptions`, not just
   *  its method. Dropping `identifier` made every diagnostic source of a
   *  multi-source server collapse into one bare pull. */
  readonly dynamicRegistrations: Map<string, DynamicRegistration>;
  /**
   * Commands the server advertised it can run via workspace/executeCommand
   * (initialize `executeCommandProvider.commands` + any dynamically registered
   * `registerOptions.commands`). Mutable — dynamic registration adds to it.
   * This is the executeCommand allowlist: only members may be executed.
   */
  advertisedCommands: Set<string>;
  /**
   * Gate for server-initiated `workspace/applyEdit`. Bumped only for the
   * duration of an explicit executeCommand call; outside that window an
   * unsolicited server applyEdit is refused (a server must not push edits to
   * disk whenever it likes — only as the direct effect of an opted-in command).
   */
  serverEditsAllowed: number;
  /** One active command context is safe to associate with a nested applyEdit.
   * Concurrent commands deliberately clear this rather than cross-correlate. */
  activeMutationContext?: LspMutationContext;
  activeMutationDepth?: number;
  readonly serverId: string;
  /** See `LSPServerInfo.spawn`'s `launchVariant` (server.ts). Undefined =
   *  single-variant server or not yet reported. */
  readonly launchVariant?: "classic" | "native-ts7";
  readonly root: string;
  readonly lspProcess: LSPProcess;
  /**
   * Per-client debounced `workspace/didChangeWatchedFiles` batcher (#271).
   * Two-phase init (needs `state` for its flush closure) — assigned right after
   * the state literal, like `workspaceDiagnosticsSupport`.
   */
  watchQueue: WatchedFilesQueue;
}
