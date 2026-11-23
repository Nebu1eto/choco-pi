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

function resolveWebTreeSitterAsset(asset: string): string | undefined {
  try {
    const resolved = _require.resolve(`web-tree-sitter/${asset}`);
    if (fs.existsSync(resolved)) return resolved;
  } catch {}

  try {
    const candidate = resolvePackagePath(import.meta.url, "node_modules", "web-tree-sitter", asset);
    if (fs.existsSync(candidate)) return candidate;
  } catch {}

  const cwdCandidate = path.join(process.cwd(), "node_modules", "web-tree-sitter", asset);
  if (fs.existsSync(cwdCandidate)) return cwdCandidate;

  return undefined;
}

function bundledGrammarsDir(core: TreeSitterClientInternals): string | undefined {
  if (core._bundledGrammarsDir) return core._bundledGrammarsDir;
  try {
    const dir = resolvePackagePath(import.meta.url, "grammars");
    if (fs.existsSync(dir)) core._bundledGrammarsDir = dir;
    return core._bundledGrammarsDir;
  } catch {
    return undefined;
  }
}

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

export function resolveGrammarFile(
  core: TreeSitterClientInternals,
  grammarFile: string,
): string | undefined {
  for (const dir of grammarSourceDirs(core)) {
    const candidate = path.join(dir, grammarFile);
    const stamp = grammarFileStamp(candidate);
    if (!stamp) continue;
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

function refreshGrammarSessionLatches(core: TreeSitterClientInternals): void {
  const ledgerGen = getDegradationLedgerGeneration();
  if (ledgerGen === core.grammarNotificationsLedgerGen) return;
  core.grammarNotificationsLedgerGen = ledgerGen;
  core.grammarLastNotifiedDelayMs.clear();
  core.poisonedGrammarPaths.clear();
}

function reportPoisonedGrammarFile(
  core: TreeSitterClientInternals,
  candidate: string,
  grammarFile: string,
): void {
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

export function findGrammarsDir(): string {
  const grammarsDir = resolveWebTreeSitterAsset("grammars");
  if (grammarsDir && fs.existsSync(path.join(grammarsDir, "tree-sitter-typescript.wasm"))) {
    return grammarsDir;
  }

  try {
    const wasmsOut = path.join(
      path.dirname(_require.resolve("tree-sitter-wasms/package.json")),
      "out",
    );
    if (fs.existsSync(wasmsOut)) return wasmsOut;
  } catch {}

  const cwdWasms = path.join(process.cwd(), "node_modules", "tree-sitter-wasms", "out");
  if (fs.existsSync(cwdWasms)) return cwdWasms;

  return "";
}

function grammarsWriteDir(): string | undefined {
  try {
    let dir = path.dirname(_require.resolve("web-tree-sitter"));
    while (path.basename(dir) !== "web-tree-sitter" && dir !== path.dirname(dir)) {
      dir = path.dirname(dir);
    }
    if (path.basename(dir) === "web-tree-sitter") {
      return path.join(dir, "grammars");
    }
  } catch {}
  return undefined;
}

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

  const retryAt = core.grammarRetryAtMs.get(grammarFile);
  if (retryAt !== undefined && Date.now() < retryAt) {
    return false;
  }

  const task = (async (): Promise<boolean> => {
    try {
      return await fetchGrammar(core, grammarFile);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordGrammarFailure(
        core,
        grammarFile,
        `The runtime grammar fetch threw an unexpected error (${message}).`,
        true,
      );
      return false;
    }
  })();
  core.grammarEnsurePromises.set(grammarFile, task);
  void task
    .finally(() => {
      if (core.grammarEnsurePromises.get(grammarFile) === task) {
        core.grammarEnsurePromises.delete(grammarFile);
      }
    })
    .catch(() => {});
  return task;
}

async function fetchGrammar(
  core: TreeSitterClientInternals,
  grammarFile: string,
): Promise<boolean> {
  if (isVendoredGrammar(grammarFile)) {
    const { reason } = vendoredGrammarRefusal(grammarFile);
    recordGrammarFailure(
      core,
      grammarFile,
      reason ?? `${grammarFile} is missing from vendor/grammars/.`,
      false,
    );
    return false;
  }
  const dir =
    core.grammarsDir && fs.existsSync(core.grammarsDir) ? core.grammarsDir : grammarsWriteDir();
  if (!dir) {
    recordGrammarFailure(
      core,
      grammarFile,
      "No writable grammars directory could be located for the runtime fetch.",
      true,
    );
    return false;
  }
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
    recordGrammarFailure(
      core,
      grammarFile,
      reason ?? "The package manager skipped install scripts and the runtime download failed.",
      retryable,
    );
  }
  return ok;
}

function recordGrammarFailure(
  core: TreeSitterClientInternals,
  grammarFile: string,
  detail: string,
  retryable: boolean,
): void {
  const attempts = (core.grammarFailureAttempts.get(grammarFile) ?? 0) + 1;
  core.grammarFailureAttempts.set(grammarFile, attempts);
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
  incrementDegradationCount({
    kind: "grammar-blocked",
    subject: grammarFile,
    reason: retryable
      ? `runtime grammar download failed — retryable (${detail.trim()})`
      : `runtime grammar download failed — durable (${detail.trim()})`,
  });

  refreshGrammarSessionLatches(core);
  const notifyKey = retryDelayMs ?? -1;
  if (core.grammarLastNotifiedDelayMs.get(grammarFile) !== notifyKey) {
    core.grammarLastNotifiedDelayMs.set(grammarFile, notifyKey);
    notifyUserDegradation(`choco-pi-lsp: ${unavailable}`);
  }
}

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
    true,
  );
}

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

      // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
      const anyMod = mod as any;
      const ParserClass = anyMod.Parser || anyMod.default || anyMod;

      if (!ParserClass || !isFunction(ParserClass.init)) {
        dbg(core, "Parser class not found or missing init method");
        return false;
      }

      // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
      core.ParserClass = ParserClass as any;
      core.LanguageLoader = mod.Language;

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

export function resetLoadStateForSession(core: TreeSitterClientInternals): void {
  core.webTreeSitterLoadFailed = false;
}

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
    if (!core.client.reportWasmAbort(err)) {
      recordGrammarLoadFailure(core, grammarPath, grammarFile, err);
    }
    dbg(core, `Language load error: ${err}`);
    return null;
  }
}

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
