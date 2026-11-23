/**
 * web-tree-sitter runtime init, grammar discovery, fetch, verification, failure backoff, and language/parser loading.
 */
import { isFunction, type LspBoundaryValue } from "../runtime-guards.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  getDegradationLedgerGeneration,
  incrementDegradationCount,
  recordDegradation,
  recordDegradationOnce,
} from "../degradation-ledger.ts";
import { loadWebTreeSitter } from "../deps/web-tree-sitter.ts";
import { transientRetryDelayMs } from "../dispatch/runners/utils/availability-policy.ts";
import {
  downloadGrammarDetailed,
  fileHasWasmMagic,
  grammarBlockReason,
  isVendoredGrammar,
  vendoredGrammarRefusal,
  vendoredGrammarsDir,
} from "../grammar-source.ts";
import { resolvePackagePath } from "../package-root.ts";
import { assertInstallAllowed, getProjectTrustGeneration } from "../project-trust.ts";
import { logTreeSitterDiagnostic } from "../tree-sitter-logger.ts";
import { notifyUserDegradation } from "../user-notify.ts";
import type { TreeSitterClientInternals } from "./internals.ts";
import { dbg } from "./runtime.ts";
import {
  GRAMMAR_BY_LANGUAGE,
  _require,
  classifyWebTreeSitterLoadFailure,
  grammarFileStamp,
  type TreeSitterLanguage,
  type TreeSitterParserInstance,
} from "./shared.ts";

/**
 * Resolve a web-tree-sitter asset path using multiple strategies:
 * 1. Node module resolution via createRequire (handles hoisted installs — issue #20)
 * 2. Package-root walk from import.meta.url (handles on-the-fly TS compilation by pi)
 * 3. process.cwd() fallback
 */
function resolveWebTreeSitterAsset(asset: string): string | undefined {
  // Strategy 1: Node module resolution (hoisted installs, pnpm workspaces)
  try {
    const resolved = _require.resolve(`web-tree-sitter/${asset}`);
    if (fs.existsSync(resolved)) return resolved;
  } catch {
    /* fall through */
  }

  // Strategy 2: Walk up from this module to find package.json, then into node_modules.
  // This is required when pi compiles TS on-the-fly to a temp directory —
  // createRequire(import.meta.url) resolves from the temp dir and can't find
  // web-tree-sitter, but the package root (where package.json lives) still has
  // the correct node_modules layout.
  try {
    const candidate = resolvePackagePath(import.meta.url, "node_modules", "web-tree-sitter", asset);
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    /* fall through */
  }

  // Strategy 3: cwd fallback
  const cwdCandidate = path.join(process.cwd(), "node_modules", "web-tree-sitter", asset);
  if (fs.existsSync(cwdCandidate)) return cwdCandidate;

  return undefined;
}

function bundledGrammarsDir(core: TreeSitterClientInternals): string | undefined {
  // Cache only a positive hit; keep re-checking until it exists (prepare may
  // not have populated it yet at first probe).
  if (core._bundledGrammarsDir) return core._bundledGrammarsDir;
  try {
    const dir = resolvePackagePath(import.meta.url, "grammars");
    if (fs.existsSync(dir)) core._bundledGrammarsDir = dir;
    return core._bundledGrammarsDir;
  } catch {
    return undefined;
  }
}

/**
 * The committed `vendor/grammars` dir, if it exists. Cached only on a hit,
 * mirroring `bundledGrammarsDir`.
 */
function cachedVendoredGrammarsDir(core: TreeSitterClientInternals): string | undefined {
  if (core._vendoredGrammarsDir) return core._vendoredGrammarsDir;
  try {
    const dir = vendoredGrammarsDir();
    if (fs.existsSync(dir)) core._vendoredGrammarsDir = dir;
    return core._vendoredGrammarsDir;
  } catch {
    return undefined;
  }
}

/**
 * All directories that may hold grammar wasms, in precedence order: the
 * committed vendor dir, the bundled core dir, the resolved
 * `this.grammarsDir`, and the web-tree-sitter grammars dir (the lazy-fetch
 * write target). Deduped.
 *
 * `vendor/grammars` comes first because it is the ONLY source for a grammar
 * we build ourselves (`VENDORED_GRAMMARS`) — nothing downloads into the
 * later dirs for it, so a miss here is a miss everywhere.
 */
function grammarSourceDirs(core: TreeSitterClientInternals): string[] {
  const dirs: string[] = [];
  const push = (d: string | undefined): void => {
    if (d && !dirs.includes(d)) dirs.push(d);
  };
  push(cachedVendoredGrammarsDir(core));
  push(bundledGrammarsDir(core));
  push(core.grammarsDir || undefined);
  push(resolveWebTreeSitterAsset("grammars"));
  return dirs;
}

/**
 * Absolute path to `grammarFile` across all source dirs, else undefined.
 *
 * Existence is not enough (#1548): a file whose first four bytes aren't the
 * wasm preamble is not a grammar, and returning it would report the language
 * as available while every `Language.load` fails — the permanent-poisoning
 * shape this issue is about. #1548 stops NEW poisoned files from being
 * written, but a file poisoned before that shipped is already on disk, so
 * the resolve path has to reject it too: a rejected candidate is treated as
 * absent, which lets `ensureGrammar` re-download over it.
 */
export function resolveGrammarFile(
  core: TreeSitterClientInternals,
  grammarFile: string,
): string | undefined {
  for (const dir of grammarSourceDirs(core)) {
    const candidate = path.join(dir, grammarFile);
    const stamp = grammarFileStamp(candidate);
    if (!stamp) continue;
    // #1564: a file that passed the preamble check but failed
    // `Language.load` at this exact stamp is known-bad — treat it as
    // absent so `ensureGrammar` re-fetches over it, same as the
    // non-wasm-magic case below. A stamp mismatch (the file changed —
    // re-downloaded) falls through to re-examine it fresh.
    if (core.decodeFailedGrammarPaths.get(candidate) === stamp) continue;
    if (core.verifiedGrammarPaths.get(candidate) === stamp) return candidate;
    if (fileHasWasmMagic(candidate)) {
      core.verifiedGrammarPaths.set(candidate, stamp);
      return candidate;
    }
    core.verifiedGrammarPaths.delete(candidate);
    reportPoisonedGrammarFile(core, candidate, grammarFile);
  }
  return undefined;
}

/**
 * Clear the once-per-session grammar report gates when the degradation
 * ledger's own generation has moved (#1536 review F5). Lazy
 * compare-at-use-time against a monotonic counter, bumped by
 * `resetDegradationLedger`, which `handleSessionStart` calls first thing —
 * no listener, no retention. Every gate keyed to a SESSION rather than to
 * the process lives here, so a new one cannot forget to re-arm: a gate that
 * outlives the ledger it guards silently swallows the record it was only
 * ever meant to de-duplicate (#1560 review F1).
 */
function refreshGrammarSessionLatches(core: TreeSitterClientInternals): void {
  const ledgerGen = getDegradationLedgerGeneration();
  if (ledgerGen === core.grammarNotificationsLedgerGen) return;
  core.grammarNotificationsLedgerGen = ledgerGen;
  core.grammarLastNotifiedDelayMs.clear();
  core.poisonedGrammarPaths.clear();
}

/**
 * Log + record a grammar file on disk that isn't a wasm module, once per
 * path per session. No user notification here: the caller goes on to attempt
 * a re-download, and `recordGrammarFailure` is what interrupts the user if
 * that also fails. A silent recovery should stay silent.
 */
function reportPoisonedGrammarFile(
  core: TreeSitterClientInternals,
  candidate: string,
  grammarFile: string,
): void {
  // Per SESSION, not per process (#1560 review F1). The file is still
  // poisoned after a session boundary and still degrades the language, so
  // the new session's ledger has to carry the entry — a client-lifetime
  // gate would leave `resetDegradationLedger` with a permanently empty
  // grammar-blocked group and no record of why the language is degraded.
  refreshGrammarSessionLatches(core);
  if (core.poisonedGrammarPaths.has(candidate)) return;
  core.poisonedGrammarPaths.add(candidate);
  logTreeSitterDiagnostic({
    subsystem: "tree-sitter-client",
    level: "warn",
    message:
      `ignoring ${candidate}: the file is not a wasm module (missing the \\0asm preamble) — ` +
      `most likely a captive-portal or proxy page written by an earlier download (#1548). ` +
      `choco-pi-lsp will treat the grammar as missing and try to fetch it again.`,
    metadata: { grammarFile, path: candidate, outcome: "not-wasm" },
  });
  incrementDegradationCount({
    kind: "grammar-blocked",
    subject: grammarFile,
    reason: "on-disk grammar file is not a wasm module — ignored, re-fetching",
  });
}

/** Find tree-sitter grammar directory */
export function findGrammarsDir(): string {
  const grammarsDir = resolveWebTreeSitterAsset("grammars");
  if (grammarsDir && fs.existsSync(path.join(grammarsDir, "tree-sitter-typescript.wasm"))) {
    return grammarsDir;
  }

  // Fallback: a real `tree-sitter-wasms` package, if the user installed one
  // (it is not a choco-pi-lsp dependency — grammars ship bundled / lazy-fetched).
  try {
    const wasmsOut = path.join(
      path.dirname(_require.resolve("tree-sitter-wasms/package.json")),
      "out",
    );
    if (fs.existsSync(wasmsOut)) return wasmsOut;
  } catch {
    /* fall through */
  }

  const cwdWasms = path.join(process.cwd(), "node_modules", "tree-sitter-wasms", "out");
  if (fs.existsSync(cwdWasms)) return cwdWasms;

  return "";
}

/**
 * The directory where grammars SHOULD live (web-tree-sitter/grammars),
 * whether or not it exists yet — so we can create + populate it when the
 * postinstall download was skipped (pnpm/bun). Returns undefined if
 * web-tree-sitter itself can't be located.
 */
function grammarsWriteDir(): string | undefined {
  try {
    let dir = path.dirname(_require.resolve("web-tree-sitter"));
    while (path.basename(dir) !== "web-tree-sitter" && dir !== path.dirname(dir)) {
      dir = path.dirname(dir);
    }
    if (path.basename(dir) === "web-tree-sitter") {
      return path.join(dir, "grammars");
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

/**
 * Ensure a single grammar wasm is on disk, fetching it at runtime if the
 * postinstall didn't (pnpm/bun skip lifecycle scripts — the documented
 * build-scripts gap). Idempotent and de-duplicated per file. Best-effort:
 * a failed fetch (e.g. offline) degrades to "grammar unavailable", never
 * throws.
 */
async function ensureGrammar(
  core: TreeSitterClientInternals,
  grammarFile: string,
): Promise<boolean> {
  if (resolveGrammarFile(core, grammarFile)) {
    return true;
  }
  if (!assertInstallAllowed(`tree-sitter grammar fetch: ${grammarFile}`)) {
    const unavailable =
      `tree-sitter grammar '${grammarFile}' is unavailable because the project is not trusted; ` +
      `runtime grammar downloads are disabled until trust is granted.`;
    logTreeSitterDiagnostic({
      subsystem: "tree-sitter-client",
      message: unavailable,
      metadata: { grammarFile, outcome: "trust-gated" },
    });
    recordDegradation({
      kind: "grammar-blocked",
      subject: grammarFile,
      reason: "runtime grammar download blocked because project is untrusted",
    });
    // Lazy clear-on-transition (#1363 review): compare the trust
    // generation at use time -- no listener registration, no retention.
    const generation = getProjectTrustGeneration();
    if (generation !== core.trustNotificationsGeneration) {
      core.trustNotificationsGeneration = generation;
      core.trustBlockedGrammarNotifications.clear();
    }
    if (!core.trustBlockedGrammarNotifications.has(grammarFile)) {
      core.trustBlockedGrammarNotifications.add(grammarFile);
      notifyUserDegradation(`choco-pi-lsp: ${unavailable}`);
    }
    return false;
  }
  const inflight = core.grammarEnsurePromises.get(grammarFile);
  if (inflight) return inflight;

  // A failed download only stays refused for its cooldown window (#1536):
  // past that, fall through and retry rather than remembering an offline
  // moment for the life of the process. No download is attempted while the
  // cooldown is live, so a hard-down CDN is not re-hit on every parse. A
  // DURABLE failure (grammarBlockDurable below) sets this to +Infinity,
  // which reads the same as "still cooling down" here — it just never
  // expires, matching the issue's "a genuinely unavailable grammar may
  // still latch" allowance.
  const retryAt = core.grammarRetryAtMs.get(grammarFile);
  if (retryAt !== undefined && Date.now() < retryAt) {
    return false;
  }

  const task = (async (): Promise<boolean> => {
    try {
      return await fetchGrammar(core, grammarFile);
    } catch (err) {
      // Defensive (#1548): nothing in `fetchGrammar` throws today —
      // `downloadGrammarDetailed` catches internally. But a thrown error
      // here used to skip the whole `else` arm, so NO cooldown was armed
      // and the rejection escaped through `task.finally` — the exact
      // pre-#1536 shape (no cooldown, possible unhandled rejection). Funnel
      // it into the same retryable failure path instead, so a future
      // refactor that lets an exception out cannot regress to it.
      const message = err instanceof Error ? err.message : String(err);
      recordGrammarFailure(
        core,
        grammarFile,
        `The runtime grammar fetch threw an unexpected error (${message}).`,
        /* retryable */ true,
      );
      return false;
    }
  })();
  core.grammarEnsurePromises.set(grammarFile, task);
  // Evict on settle regardless of outcome (#1536): a resolved TRUE is
  // superseded by resolveGrammarFile() finding the file on disk on the
  // next call, and a resolved FALSE must not be remembered as the
  // permanent verdict — only concurrent callers during the SAME in-flight
  // attempt should ever observe this promise.
  //
  // The trailing `.catch` is UNFALSIFIABLE scaffolding, not verified
  // defence (#1560 review F3): `finally` returns a DERIVED promise that
  // rejects whenever `task` does, but the task's own try/catch above means
  // it cannot reject, so no test can make this handler fire and removing it
  // changes nothing today. It is here for the day the try/catch above stops
  // being exhaustive — or the eviction callback itself throws — because at
  // that point the fork becomes an unhandled rejection nobody is awaiting.
  void task
    .finally(() => {
      if (core.grammarEnsurePromises.get(grammarFile) === task) {
        core.grammarEnsurePromises.delete(grammarFile);
      }
    })
    .catch(() => {
      /* see above: the task's own catch is the real handler */
    });
  return task;
}

/**
 * One grammar-fetch attempt: locate a writable dir, download, and record the
 * outcome. Split out of `ensureGrammar` so the whole body sits under one
 * try/catch that funnels any throw into `recordGrammarFailure` (#1548).
 */
async function fetchGrammar(
  core: TreeSitterClientInternals,
  grammarFile: string,
): Promise<boolean> {
  // BEFORE resolving a write directory: a vendored grammar is never
  // downloaded, so the write dir has no bearing on its verdict. Resolving
  // first let the "no writable grammars directory" branch below answer
  // RETRYABLE for a missing vendored wasm on any host where
  // web-tree-sitter isn't locatable — reporting a packaging fault as a
  // transient download failure, and arming a cooldown for a fetch that can
  // never happen.
  if (isVendoredGrammar(grammarFile)) {
    const { reason } = vendoredGrammarRefusal(grammarFile);
    recordGrammarFailure(
      core,
      grammarFile,
      reason ?? `${grammarFile} is missing from vendor/grammars/.`,
      /* retryable */ false,
    );
    return false;
  }
  const dir =
    core.grammarsDir && fs.existsSync(core.grammarsDir) ? core.grammarsDir : grammarsWriteDir();
  if (!dir) {
    // No writable grammars directory could be located (e.g. pi compiled
    // this module to a temp dir and web-tree-sitter isn't resolvable
    // from there yet). This is an environment condition, not a CDN
    // verdict — #1536 review F2: it must get the same cooldown +
    // notification treatment as a download failure, not a silent
    // unmemoized `false` that re-does the same failing resolution
    // sweep on every single demand.
    recordGrammarFailure(
      core,
      grammarFile,
      "No writable grammars directory could be located for the runtime fetch.",
      /* retryable */ true,
    );
    return false;
  }
  // Reuse the shared single-file downloader (same CDN/source as the
  // postinstall) — see clients/grammar-source.ts.
  const { ok, retryable, reason } = await downloadGrammarDetailed(dir, grammarFile);
  if (ok) {
    if (!core.grammarsDir) core.grammarsDir = dir;
    core.grammarRetryAtMs.delete(grammarFile);
    core.grammarFailureAttempts.delete(grammarFile);
    core.grammarLastNotifiedDelayMs.delete(grammarFile);
    logTreeSitterDiagnostic({
      subsystem: "tree-sitter-client",
      level: "warn",
      message: `fetched missing tree-sitter grammar ${grammarFile} at runtime (install scripts were skipped by the package manager)`,
      metadata: { grammarFile, outcome: "fetched" },
    });
  } else {
    // `retryable` distinguishes a durable CDN verdict (404/410 — a
    // retry hits the same answer) from everything else (offline, DNS,
    // a down CDN, a 5xx, a timeout), which says nothing durable about
    // the grammar (#1536 review F4). Only the retryable case gets the
    // bounded cooldown; a durable failure keeps the pre-#1536 latched
    // behavior, matching the issue's own allowance.
    //
    // `reason`, when the downloader supplies one, names the actual failure
    // shape (#1548: "returned an HTML page, not a wasm module") instead of
    // the generic guess — the difference between a diagnosable log line
    // and one that sends the user to inspect their package manager while a
    // captive portal is the real cause.
    recordGrammarFailure(
      core,
      grammarFile,
      reason ?? "The package manager skipped install scripts and the runtime download failed.",
      retryable,
    );
  }
  return ok;
}

/**
 * Record one failed grammar-ensure attempt: arm (or extend) the retry
 * cooldown, record the degradation, and notify the user at most once per
 * session per DISTINCT retry delay (#1536 review F1/F2/F4/F5/F6). Shared
 * by the "no writable directory" and "download failed" arms of
 * `ensureGrammar` — both are failures of the SAME ensure attempt, just
 * with a different point of failure.
 */
function recordGrammarFailure(
  core: TreeSitterClientInternals,
  grammarFile: string,
  detail: string,
  retryable: boolean,
): void {
  const attempts = (core.grammarFailureAttempts.get(grammarFile) ?? 0) + 1;
  core.grammarFailureAttempts.set(grammarFile, attempts);
  // A durable verdict (404/410) never expires -- matches the issue's "a
  // genuinely unavailable grammar may still latch" allowance. Everything
  // else gets the bounded exponential cooldown.
  const retryDelayMs = retryable ? transientRetryDelayMs(attempts, "probe-timeout") : undefined;
  core.grammarRetryAtMs.set(
    grammarFile,
    retryDelayMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + retryDelayMs,
  );

  const unavailable = retryable
    ? `tree-sitter grammar '${grammarFile}' is unavailable — symbol search, ` +
      `module reports and structural rules for this language will be degraded. ` +
      // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
      `${detail} choco-pi-lsp will retry automatically in ${Math.round((retryDelayMs as number) / 1000)}s; ` +
      `if the problem persists, allow the package manager's build scripts ` +
      `(pnpm approve-builds / bun trustedDependencies) or restore network access.`
    : `tree-sitter grammar '${grammarFile}' is unavailable — symbol search, ` +
      `module reports and structural rules for this language will be degraded. ` +
      `${detail} The grammar source reports it does not exist (not a network problem), so this will not ` +
      `resolve on retry. Fix: reinstall with a manager that runs postinstall, allow its build scripts ` +
      `(pnpm approve-builds / bun trustedDependencies), or restore network access.`;

  logTreeSitterDiagnostic({
    subsystem: "tree-sitter-client",
    message: unavailable,
    metadata: {
      grammarFile,
      outcome: "unavailable",
      retryable,
      retryDelayMs,
      attempts,
    },
  });
  // #1536 review F1: incrementDegradationCount keeps ONE ring-buffer slot
  // per subject (bumping its count in place) instead of recordDegradation's
  // one-new-entry-per-call — a grammar retrying every cooldown window would
  // otherwise flood the shared "grammar-blocked" kind's 20-slot ring and
  // evict unrelated entries (e.g. a different grammar's V8-crash block
  // reason from loadLanguage/grammarBlockReason) after ~20 cycles.
  incrementDegradationCount({
    kind: "grammar-blocked",
    subject: grammarFile,
    // #1548: carry `detail` into the RETRYABLE reason too. All retryable
    // failures used to share one string, so the ledger could not tell an
    // offline laptop from a captive portal serving HTML — the two need
    // different user actions, and the ledger is what a bug report shows.
    reason: retryable
      ? `runtime grammar download failed — retryable (${detail.trim()})`
      : `runtime grammar download failed — durable (${detail.trim()})`,
  });

  refreshGrammarSessionLatches(core);
  // HUMAN-audience: an offline grammar fetch silently degrades this
  // language's features, so it reaches the user through the HOST's render
  // path (#1333) rather than a raw terminal write. Notify once per DISTINCT
  // retry delay this session (#1536 review F6) -- a fresh failure streak or
  // an escalated backoff is new information worth surfacing; an unchanged
  // repeat during the same cooldown tier is not.
  const notifyKey = retryDelayMs ?? -1;
  if (core.grammarLastNotifiedDelayMs.get(grammarFile) !== notifyKey) {
    core.grammarLastNotifiedDelayMs.set(grammarFile, notifyKey);
    notifyUserDegradation(`choco-pi-lsp: ${unavailable}`);
  }
}

/**
 * Record a `Language.load` failure on a file `resolveGrammarFile` had just
 * vouched for (#1564) — the diagnosis gap #1548 left open: the preamble
 * check proves the first four bytes are `\0asm`, not that the whole body
 * decodes. A decode error here (a truncated download, on-disk corruption)
 * is evidence the FILE is bad, so it gets the exact same treatment as an
 * ensure-time download failure: invalidate the resolve memo so the next
 * demand re-fetches instead of reusing the same broken file forever, and
 * reuse `recordGrammarFailure`'s cooldown/degradation/notification
 * machinery rather than hand-rolling a parallel one — a persistently
 * truncated CDN response would otherwise re-download and re-fail on every
 * single parse.
 *
 * A DURABLE decode failure (the bytes are complete and correct, but ABI-
 * incompatible with the installed `web-tree-sitter` — a version drift, not
 * a truncation) is classified `retryable` here too, same as everything
 * else this method sees: there is no way to tell "truncated" from "wrong
 * ABI" from the error message alone, so it re-downloads and re-fails once
 * per cooldown tier instead of latching forever. That is bounded by the
 * cooldown ladder (this never re-fetches faster than #1536's backoff) and
 * by `BLOCKED_GRAMMARS` for the narrower case that's fatal to the process
 * rather than just wrong (`grammar-source.ts`). The redownload only helps
 * if a fresh fetch could actually be a DIFFERENT (compatible) build,
 * which is exactly what the `grammar-source.test.ts` version/lock sync
 * guard (`lock.version === TREE_SITTER_WASMS_VERSION`) exists to keep
 * true — without it, a version bump with a stale lock would make every
 * redownload land the identical bytes and spin the ladder against a file
 * that can never pass.
 */

function recordGrammarLoadFailure(
  core: TreeSitterClientInternals,
  grammarPath: string,
  grammarFile: string,
  err: LspBoundaryValue,
): void {
  const stamp = grammarFileStamp(grammarPath);
  core.verifiedGrammarPaths.delete(grammarPath);
  if (stamp) core.decodeFailedGrammarPaths.set(grammarPath, stamp);
  const message = err instanceof Error ? err.message : String(err);
  logTreeSitterDiagnostic({
    subsystem: "tree-sitter-client",
    level: "warn",
    message:
      `Language.load failed for ${grammarPath} even though the wasm preamble check ` +
      `passed (${message}) — most likely a truncated download (#1564). Treating the ` +
      `grammar as missing so the next demand re-fetches it.`,
    metadata: { grammarFile, path: grammarPath, outcome: "load-failed" },
  });
  recordGrammarFailure(
    core,
    grammarFile,
    `Language.load failed on a resolved grammar file (${message}).`,
    /* retryable */ true,
  );
}

/** Initialize tree-sitter WASM runtime */
export async function init(core: TreeSitterClientInternals): Promise<boolean> {
  if (core.wasmAborted) return false;
  if (core.initialized) return true;
  if (core.webTreeSitterLoadFailed) return false;
  if (core.initPromise) return core.initPromise;

  core.initPromise = (async () => {
    try {
      let mod: Awaited<ReturnType<typeof loadWebTreeSitter>>;
      try {
        mod = await loadWebTreeSitter();
      } catch (err) {
        // See webTreeSitterLoadFailed's doc: an EVALUATION-shaped
        // rejection is a dead retry, so latch instead of leaving
        // initPromise clearable (the finally below would otherwise let
        // the very next parse call re-import the same doomed URL). A
        // RESOLUTION-shaped rejection is left alone — initPromise still
        // clears below, so the next init() call retries for real.
        const classification = classifyWebTreeSitterLoadFailure(err);
        if (classification === "evaluation") {
          core.webTreeSitterLoadFailed = true;
        }
        recordDegradationOnce({
          kind: "web-tree-sitter-load-failed",
          subject: "web-tree-sitter",
          reason:
            (err instanceof Error ? err.message : String(err)) +
            (classification === "resolution"
              ? " (resolution failure — retryable)"
              : " (evaluation failure — latched for the session)"),
        });
        throw err;
      }
      // biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter module shape varies (Parser direct / default-wrapped)

      // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
      const anyMod = mod as any;
      const ParserClass = anyMod.Parser || anyMod.default || anyMod;

      if (!ParserClass || !isFunction(ParserClass.init)) {
        dbg(core, "Parser class not found or missing init method");
        return false;
      }

      // biome-ignore lint/suspicious/noExplicitAny: Parser class type

      // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
      core.ParserClass = ParserClass as any;
      // Store Language loader from module (not from Parser)
      core.LanguageLoader = mod.Language;

      // Resolve WASM path using same multi-strategy helper (hoisted installs +
      // on-the-fly compilation by pi).
      const wasmPath = resolveWebTreeSitterAsset("tree-sitter.wasm");
      if (!wasmPath) {
        dbg(core, "Could not resolve tree-sitter.wasm");
        return false;
      }
      const wasmDir = path.dirname(wasmPath);
      dbg(core, `Looking for WASM at: ${wasmPath}, exists: ${fs.existsSync(wasmPath)}`);

      await ParserClass.init({
        locateFile: (scriptName: string) => {
          const fullPath = path.join(wasmDir, scriptName);
          dbg(core, `locateFile: ${scriptName} -> ${fullPath}`);
          return fullPath;
        },
      });
      core.initialized = true;
      return true;
    } catch (err) {
      core.client.reportWasmAbort(err);
      dbg(core, `Init error: ${err}`);
      return false;
    } finally {
      core.initPromise = null;
    }
  })();

  return core.initPromise;
}

/**
 * Re-arm the web-tree-sitter load latch for a new session (#1592 review
 * round 2 F2). Deliberately does NOT touch `wasmAborted` or `initialized`
 * — see `webTreeSitterLoadFailed`'s doc for why the abort case stays
 * process-lifetime, and a successful init has nothing to re-arm. Called
 * from `resetTreeSitterClientLoadState()` (tree-sitter-shared.ts), wired
 * into `resetDispatchBaselines()` beside `resetAstGrepNapiLoadState()`.
 */
export function resetLoadStateForSession(core: TreeSitterClientInternals): void {
  core.webTreeSitterLoadFailed = false;
}

/** Load language grammar */
export async function loadLanguage(
  core: TreeSitterClientInternals,
  languageId: string,
): Promise<TreeSitterLanguage | null> {
  if (core.wasmAborted) return null;
  dbg(core, `Loading language: ${languageId}`);

  if (core.languages.has(languageId)) {
    dbg(core, `Language ${languageId} already loaded`);
    return core.languages.get(languageId)!;
  }

  if (!core.ParserClass) {
    dbg(core, `ParserClass not initialized`);
    return null;
  }

  const grammarFile = GRAMMAR_BY_LANGUAGE.get(languageId);
  if (!grammarFile) {
    dbg(core, `No grammar file for ${languageId}`);
    return null;
  }

  // A grammar that fatally crashes this runtime (uncatchable V8 abort) must
  // never be loaded — skip it and degrade to "unavailable" (#423/#432). The
  // grammar-health nightly is what decides membership of BLOCKED_GRAMMARS.
  const blockReason = grammarBlockReason(grammarFile);
  if (blockReason) {
    dbg(core, `Grammar ${grammarFile} blocked on this runtime — ${blockReason}`);
    recordDegradation({
      kind: "grammar-blocked",
      subject: grammarFile,
      reason: blockReason,
    });
    return null;
  }

  // Look across the bundled core `grammars/` dir and the postinstall/lazy
  // dir. Lazily fetch only if the grammar is in neither (pnpm/bun skip
  // postinstall; the long-tail grammars aren't bundled). Only the language
  // actually being parsed is fetched.
  let grammarPath = resolveGrammarFile(core, grammarFile);
  if (!grammarPath) {
    if (await ensureGrammar(core, grammarFile)) {
      grammarPath = resolveGrammarFile(core, grammarFile);
    }
  }
  dbg(core, `Grammar path: ${grammarPath}, exists: ${grammarPath && fs.existsSync(grammarPath)}`);

  if (!grammarPath || !fs.existsSync(grammarPath)) {
    dbg(core, `Grammar file not found: ${grammarPath}`);
    return null;
  }

  try {
    if (!core.LanguageLoader?.load) {
      dbg(core, `LanguageLoader.load not available`);
      return null;
    }
    dbg(core, `Calling Language.load...`);
    const language = await core.LanguageLoader.load(grammarPath);
    dbg(core, `Language loaded: ${language?.name || "unknown"}`);
    if (language) {
      core.languages.set(languageId, language);
    }
    return language;
  } catch (err) {
    // An uncatchable-shaped WASM abort poisons the whole process (#402) —
    // `reportWasmAbort` already records + handles it. Everything else
    // (#1564) is a DECODE failure on a file `resolveGrammarFile` just
    // vouched for — e.g. "Code section extends past end of the module" on
    // a truncated-but-magic-valid download. That is evidence the file
    // itself is bad, not the runtime, so record it and stop vouching for
    // this exact file so the next demand can re-fetch it.
    if (!core.client.reportWasmAbort(err)) {
      recordGrammarLoadFailure(core, grammarPath, grammarFile, err);
    }
    dbg(core, `Language load error: ${err}`);
    return null;
  }
}

/** Get or create parser for a language */
export async function getParser(
  core: TreeSitterClientInternals,
  languageId: string,
): Promise<TreeSitterParserInstance | null> {
  if (core.wasmAborted) return null;
  if (core.parsers.has(languageId)) {
    return core.parsers.get(languageId)!;
  }

  const language = await loadLanguage(core, languageId);
  if (!language || !core.ParserClass) return null;

  const parser = new core.ParserClass();
  parser.setLanguage(language);
  core.parsers.set(languageId, parser);
  return parser;
}
