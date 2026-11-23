/**
 * The TreeSitterClientInternals record that holds the former private state of TreeSitterClient.
 */
import type { AsyncLocalStorage } from "node:async_hooks";
import type { TreeCache } from "../tree-sitter-cache.ts";
import type { TreeSitterNavigator } from "../tree-sitter-navigator.ts";
import type { TreeSitterQueryLoader } from "../tree-sitter-query-loader.ts";
import type { TreeSitterClient } from "./client.ts";
import type {
  ParseCacheMeasurement,
  QueryBatch,
  TreeSitterLanguage,
  TreeSitterParserCounters,
  TreeSitterParserInstance,
} from "./shared.ts";

export const QUERY_CACHE_MAX_ENTRIES = 256;

export const QUERY_BATCH_CACHE_MAX_ENTRIES = 256;

/** Former private state of TreeSitterClient; the class holds one record and its method bodies take it first. */
export interface TreeSitterClientInternals {
  client: TreeSitterClient;

  initialized: boolean;

  initPromise: Promise<boolean> | null;

  /**
   * Set when `loadWebTreeSitter()` itself rejects with an EVALUATION-shaped
   * error (#1592, review round 2 F1/F2) — `classifyWebTreeSitterLoadFailure`
   * above draws that line. That call is a dynamic `import()` of a fixed
   * resolved URL, and Node's ESM loader permanently memoizes a module
   * record that threw during evaluation — a later `import()` of the SAME
   * URL from a later `init()` call would just replay the cached rejection,
   * not re-attempt the load. Without this latch, every `withTreeSitterRoot()`
   * call (one per file parse) would re-invoke `init()`, see `initPromise`
   * cleared by the previous attempt's `finally`, and dynamically re-import —
   * a dead retry on the hot path. A RESOLUTION-shaped rejection does NOT
   * set this: it leaves `initPromise` cleared as before, so the next
   * `init()` call retries for real, because that class of failure can
   * plausibly clear before the next call arrives.
   *
   * SESSION-scoped, not process-lifetime (round 2 F2, the #1567/#1575
   * `sgSessionHold` precedent): re-armed by `resetLoadStateForSession()`,
   * wired into `resetDispatchBaselines()` via `tree-sitter-shared.ts`'s
   * `resetTreeSitterClientLoadState()`. Re-arming does not guarantee the
   * next attempt succeeds — if the process itself didn't restart between
   * sessions, Node's module cache is unchanged and the replay will just
   * fail fast again — but it gives a fresh degradation record for the new
   * session (the ledger's own `onceKeys` are cleared at session_start too)
   * instead of silently reusing a stale verdict forever, and it does let a
   * genuinely fixed install (process WAS restarted) recover.
   *
   * Distinct from `wasmAborted`, which stays process-lifetime and is
   * deliberately NOT included in the session reset: that flag means the
   * Emscripten WASM heap itself aborted mid-use — a runtime that DID load
   * and then corrupted its own memory. Reusing that heap after a "session"
   * boundary that isn't an actual process restart is not a retry, it's
   * operating on data already documented (tree-sitter-shared.ts) as
   * requiring a real restart to recover. `webTreeSitterLoadFailed` only
   * ever covers a runtime that never loaded in the first place, so nothing
   * corrupted survives a re-arm.
   */
  webTreeSitterLoadFailed: boolean;

  languages: Map<string, TreeSitterLanguage>;

  parsers: Map<string, TreeSitterParserInstance>;

  treeCache: TreeCache;

  navigator: TreeSitterNavigator;

  grammarsDir: string;

  /** In-flight lazy grammar fetches, keyed by wasm filename. Evicted on
   * settle (#1536) — a rejected/false attempt must not be remembered as the
   * permanent answer for the session; only concurrent demands during the
   * SAME probe share it. */
  grammarEnsurePromises: Map<string, Promise<boolean>>;

  /** Epoch ms before which a failed grammar download is not retried
   * (#1536). A transient download failure — offline, DNS hiccup, CDN blip —
   * says nothing durable about the grammar, so it gets a bounded cooldown
   * (the `transientRetryDelayMs` shape from availability-policy.ts) instead
   * of latching for the process lifetime. */
  grammarRetryAtMs: Map<string, number>;

  /**
   * Grammar path → the `size:mtimeMs` stamp at which its wasm preamble was
   * verified (#1548). A POSITIVE-only memo, so the steady-state resolve costs
   * one `stat` (which the old `existsSync` already paid) and re-reads the
   * header only when the stamp moves. Stamped rather than a bare `Set`
   * because a memo that never expires is defect-shape 6: the file it vouches
   * for can be replaced under it. Failures are deliberately NOT memoized — a
   * poisoned path must be re-examined on the next resolve so a successful
   * re-download over it is picked up immediately.
   */
  verifiedGrammarPaths: Map<string, string>;

  /**
   * Grammar path → the `size:mtimeMs` stamp at which `Language.load` failed
   * on it despite passing the wasm-preamble check (#1564) — e.g. a truncated
   * download whose first four bytes are a genuine `\0asm` preamble but whose
   * body decodes short ("Code section extends past end of the module"). The
   * preamble check alone can't see this; only a real decode attempt can.
   * `resolveGrammarFile` treats a path recorded here (at the SAME stamp) as
   * absent, so the next demand re-fetches instead of reusing the same broken
   * file forever. Stamped so a fresh download (new mtime) is re-examined
   * rather than permanently distrusted — same shape as `verifiedGrammarPaths`.
   */
  decodeFailedGrammarPaths: Map<string, string>;

  /** Paths already reported as non-wasm, to log/record them once each. */
  poisonedGrammarPaths: Set<string>;

  /** Consecutive download failures per grammar, for the exponential
   * cooldown; reset on success. */
  grammarFailureAttempts: Map<string, number>;

  /**
   * Retry delay (ms) last SHOWN to the user for this grammar, or `-1` for a
   * durable (non-retryable) failure already announced. The cooldown lets
   * the ensure loop retry silently in the background — only the delay's
   * FIRST appearance, and any later escalation the user was never told
   * about, needs to interrupt them (#1536 review F6): a fresh 30s cooldown
   * re-notifies the same as an escalated 300s one once it's a genuinely new
   * number, but two consecutive 30s cooldowns (identical, nothing new to
   * say) do not. Absence means "not yet notified this streak."
   *
   * Session-scoped (#1536 review F5): cleared whenever the degradation
   * ledger's own generation moves past `grammarNotificationsLedgerGen`,
   * mirroring `trustBlockedGrammarNotifications` below — a lazy
   * compare-at-use-time against a monotonic counter, not a listener. Tied to
   * the LEDGER's generation (bumped by `resetDegradationLedger`, which
   * `handleSessionStart` calls first thing) rather than trust, since this
   * is a session boundary, not a trust transition.
   */
  grammarLastNotifiedDelayMs: Map<string, number>;

  grammarNotificationsLedgerGen: number;

  trustBlockedGrammarNotifications: Set<string>;

  trustNotificationsGeneration: number;

  // biome-ignore lint/suspicious/noExplicitAny: Optional dependency loaded dynamically
  ParserClass: any;

  // biome-ignore lint/suspicious/noExplicitAny: Language loader from module
  LanguageLoader: any;

  // biome-ignore lint/suspicious/noExplicitAny: Compiled query cache by language+pattern hash
  queryCache: Map<string, any>;

  /** Combined multi-rule queries by language + rule-set identity (null = don't retry). */
  queryBatchCache: Map<string, QueryBatch | null>;

  /** Consecutive grammar-load failures per batch key — bounds load retries (#889). */
  queryBatchLoadFailures: Map<string, number>;

  queryLoader: TreeSitterQueryLoader;

  verbose: boolean;

  parserCounters: TreeSitterParserCounters;

  parseCacheMeasurement: AsyncLocalStorage<ParseCacheMeasurement>;

  activeMeasurements: number;

  onWasmAbort: (() => void) | undefined;

  wasmAborted: boolean;

  /**
   * The `grammars/` dir bundled inside the choco-pi-lsp package (the core grammars
   * shipped in the tarball, so common languages parse offline on every package
   * manager). Resolved from the package root; cached. Absent in a source
   * checkout where `prepare` hasn't populated it.
   */
  _bundledGrammarsDir?: string;

  _vendoredGrammarsDir?: string;

  reportedCompileFailures: Set<string>;

  reportedMissingPostFilters: Set<string>;

  reportedPostFilterFailures: Set<string>;

  /**
   * Latch so the "textPredicates is malformed" diagnostic log line fires once
   * per `TreeSitterClient` instance for the life of the process (this client is
   * a process-wide singleton in production — see clients/tree-sitter-shared.ts),
   * not once per call. This gates ONLY the log line: process-wide log volume is
   * the concern here, not the user-facing degradation record below, which must
   * re-arm every session (see recordDegradationOnce) — including for a Query
   * object the LRU query cache (queryCache/queryBatchCache above) kept alive
   * across a session boundary, since the cache is evicted, never cleared.
   */
  textPredicatesInvalidLogged: boolean;
}
