/**
 * ast-grep NAPI runner for dispatch system
 *
 * Uses @ast-grep/napi for programmatic parsing instead of CLI.
 * Handles TypeScript/JavaScript/CSS/HTML files with YAML rule support.
 *
 * Replaces CLI-based runners for faster performance (100x speedup).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	type AstGrepNapi,
	loadAstGrepNapi,
	type SgRoot,
} from "../../deps/ast-grep-napi.js";
import { minimatch } from "../../deps/minimatch.js";
import {
	type AstGrepRuleSource,
	getAstGrepRuleSources,
} from "../../sgconfig.js";
import { logLatency } from "../../latency-logger.js";
import { hasEslintConfig } from "../../tool-policy.js";
import { enabledAuxiliaryLspServerIds } from "../auxiliary-lsp.js";
import { classifyDefect } from "../diagnostic-taxonomy.js";
import { recordDegradationOnce } from "../../degradation-ledger.js";
import { isAuxiliaryLspAlive } from "../../lsp/index.js";
import { resolveAstGrepNativeExe } from "../../lsp/wait-policy/index.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	calculateRuleComplexity,
	isOverlyBroadPattern,
	isStructuredRule,
	loadYamlRules,
	loadYamlRulesFresh,
	MAX_BLOCKING_RULE_COMPLEXITY,
	type YamlRule,
} from "./yaml-rule-parser.js";

const defaultUnsupportedLanguageLog = new Set<string>();
const UNSUPPORTED_RULE_ID_SAMPLE_SIZE = 5;

/** Clear per-session unsupported-language telemetry dedupe. */
export function resetAstGrepUnsupportedLanguageLog(): void {
	defaultUnsupportedLanguageLog.clear();
}

// Lazy load the napi package.
let sg: AstGrepNapi | undefined;
/**
 * In-flight load, shared by every caller (#1567). The per-edit fallback
 * runner and the session-start scanner (clients/project-diagnostics/scanner.ts)
 * both call `loadSg()` and can race. Pre-fix, the "attempted" flag was set
 * before the load and read by the SECOND caller as "already tried" while the
 * first load was still pending and about to succeed — a false-negative
 * STARVATION, not a duplicate load: the second caller got back `undefined`
 * for a load that was in flight and would have succeeded, not a second
 * redundant `import()`. Sharing one promise means every concurrent caller
 * observes the SAME outcome instead of a subset of them starving.
 *
 * Evicted on settle (#1536's pattern, see clients/tree-sitter-client.ts) — a
 * rejected load must not be remembered as the permanent answer; only
 * concurrent callers during the SAME attempt observe this promise.
 */
let sgLoadPromise: Promise<AstGrepNapi | undefined> | undefined;
/**
 * Set on ANY load failure and cleared only by `resetAstGrepNapiLoadState()`
 * at session_start (#1567 review round 2, F2).
 *
 * This holds for BOTH genuine and classified-transient failures, which is
 * narrower than the original design (a cooldown-then-retry for transient
 * failures within the same session). The reason: `loadAstGrepNapi()`
 * (clients/deps/ast-grep-napi.ts) resolves the addon to a `file://` URL and
 * dynamically `import()`s it. Node's ESM loader permanently memoizes a
 * module record that threw during evaluation — re-importing the SAME
 * resolved URL replays the cached rejection, it does not re-run the load.
 * A cooldown-then-retry loop would therefore call `loadAstGrepNapi()` again
 * after the cooldown and get back the identical cached rejection every
 * time: a retry that LOOKS like it tries again but structurally cannot
 * succeed within the process. Rather than ship that, every failure holds
 * until the next `session_start`, which is the point this cache can
 * actually be expected to have moved on (a fresh session re-arms the latch;
 * whether the underlying Node module cache also gets a fresh start depends
 * on whether the host recycles the process between sessions, but re-arming
 * the latch is the most this in-process code can honestly promise).
 */
let sgSessionHold = false;
/**
 * Why `sgSessionHold` was set — feeds the degradation-ledger message and log
 * line only. It does not change retry behavior: both classes hold
 * identically for the session, per `sgSessionHold`'s doc above.
 */
let sgHoldReason: "transient" | "genuine" | undefined;

/** A positively-identified, narrow errno family for a native-addon load: the
 * kind of momentary FS contention (too many open files, a file mid-write,
 * a transient permission/resource block) that says nothing durable about
 * whether the addon itself can load. Everything NOT in this allowlist is
 * genuine by default (#1567 review round 2, F1) — the original classifier
 * inverted this: it matched a handful of message patterns as "genuine" and
 * treated every OTHER error, including the real native-binding failure
 * family (ABI mismatch, a missing platform package, a napi version
 * mismatch, an unsupported arch), as transient. None of those recover on
 * their own; an unrecognized error is far more likely to be one of them
 * than a genuine FS hiccup. */
const TRANSIENT_ERRNO_ALLOWLIST = new Set([
	"EMFILE",
	"EBUSY",
	"EAGAIN",
	"EPERM",
	"ETXTBSY",
]);

/**
 * `@ast-grep/napi`'s own terminal "this machine cannot run this addon"
 * messages (from its `index.js` platform-detection shim). Already covered
 * by the genuine-by-default policy above; listed explicitly so the
 * classification is legible at the call site instead of an emergent
 * property of "didn't match the allowlist".
 */
const KNOWN_GENUINE_NATIVE_LOAD_MESSAGES = [
	/cannot find native binding/i,
	/failed to load native binding/i,
];

/**
 * Walk an error's `.cause` chain — Node/napi wrap the real dlopen/ABI
 * failure there rather than on the top-level thrown Error — collecting
 * every `code` and `message` seen along the way, so classification isn't
 * blind to a nested cause (#1567 review round 2, F1).
 */
function collectErrorChain(err: unknown): {
	codes: string[];
	messages: string[];
} {
	const codes: string[] = [];
	const messages: string[] = [];
	let current: unknown = err;
	const seen = new Set<unknown>();
	while (current !== undefined && current !== null && !seen.has(current)) {
		seen.add(current);
		if (current instanceof Error) {
			messages.push(current.message);
			const code = (current as Error & { code?: unknown }).code;
			if (typeof code === "string") codes.push(code);
			current = (current as Error & { cause?: unknown }).cause;
		} else {
			messages.push(String(current));
			break;
		}
	}
	return { codes, messages };
}

/**
 * Classify a `loadAstGrepNapi()` rejection. Transient requires a positively
 * identified errno match somewhere in the cause chain AND no known-genuine
 * native-load message anywhere in that same chain (an errno wrapping a
 * "cannot find native binding" cause is genuine, not transient — the errno
 * describes how the OS reported it, not what actually failed). Everything
 * else — including an error with no `code` at all — is genuine.
 */
function classifyAstGrepLoadFailure(err: unknown): "transient" | "genuine" {
	const { codes, messages } = collectErrorChain(err);
	const hasKnownGenuineMessage = messages.some((message) =>
		KNOWN_GENUINE_NATIVE_LOAD_MESSAGES.some((pattern) => pattern.test(message)),
	);
	if (hasKnownGenuineMessage) return "genuine";
	const hasTransientErrno = codes.some((code) =>
		TRANSIENT_ERRNO_ALLOWLIST.has(code),
	);
	return hasTransientErrno ? "transient" : "genuine";
}

function recordAstGrepUnavailableOnce(reason: "transient" | "genuine"): void {
	recordDegradationOnce({
		kind: "ast-grep-napi-unavailable",
		subject: "ast-grep-napi",
		reason:
			reason === "genuine"
				? "native addon failed to load (durable for this session)"
				: "native addon load hit a transient error (durable for this session — see sgSessionHold doc)",
	});
}

export async function loadSg(): Promise<AstGrepNapi | undefined> {
	if (sg) return sg;
	if (sgLoadPromise) return sgLoadPromise;
	if (sgSessionHold) {
		// #1567 review F4: a held/degraded load must be distinguishable from a
		// clean scan that found nothing to report, not silently read as
		// "skipped/empty" by every caller (clients/project-diagnostics/scanner.ts,
		// this file's own runner) — otherwise the two are indistinguishable in
		// the degradation ledger.
		recordAstGrepUnavailableOnce(sgHoldReason ?? "genuine");
		return undefined;
	}

	const task = (async (): Promise<AstGrepNapi | undefined> => {
		try {
			const loaded = await loadAstGrepNapi();
			sg = loaded;
			return loaded;
		} catch (err) {
			const reason = classifyAstGrepLoadFailure(err);
			sgSessionHold = true;
			sgHoldReason = reason;
			recordAstGrepUnavailableOnce(reason);
			return undefined;
		}
	})();
	sgLoadPromise = task;
	task.finally(() => {
		if (sgLoadPromise === task) sgLoadPromise = undefined;
	});
	return task;
}

/**
 * Re-arm the napi load latch for a new session (#1567). `sg` itself is left
 * alone — a successful load stays valid and cached for the process — but a
 * session hold (transient or genuine) is session-scoped state and must not
 * outlive the session that set it. Called from `resetDispatchBaselines()`
 * (clients/dispatch/integration.ts) beside `resetAstGrepUnsupportedLanguageLog`,
 * this module's other session latch.
 */
export function resetAstGrepNapiLoadState(): void {
	sgSessionHold = false;
	sgHoldReason = undefined;
}

// Supported extensions for NAPI
const SUPPORTED_EXTS = [".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".htm"];

/** Maximum matches per rule to prevent excessive false positives */
const MAX_MATCHES_PER_RULE = 10;

/** Maximum total diagnostics per file to prevent output spam */
const MAX_TOTAL_DIAGNOSTICS = 50;

/**
 * #660: this runner used to skip a hardcoded set of rule ids
 * (`constructor-super`, `empty-catch`, `long-parameter-list`,
 * `nested-ternary`, `no-dupe-class-members`) on the assumption that the
 * tree-sitter query runner (priority 14) already covered them, to avoid
 * double-reporting. That assumption was false for every entry: three of
 * them (`nested-ternary`, `long-parameter-list`, `no-dupe-class-members`)
 * have no active tree-sitter query — their would-be queries either live
 * under `rules/tree-sitter-queries/typescript-disabled/` (excluded from
 * loading, see clients/tree-sitter-query-loader.ts) or were never written —
 * so those three rule ids had ZERO coverage in the NAPI fallback runner
 * (used when the ast-grep binary isn't installed) despite having a
 * perfectly good, shipped, active ast-grep rule sitting right there. The
 * other two (`constructor-super`, `empty-catch`) are disabled everywhere
 * (ast-grep AND tree-sitter, see rules-disabled/, #206), so skipping them
 * was already a no-op. The whole skip-set has been removed; if tree-sitter
 * coverage is ever added back for one of these rule ids, reintroduce a
 * scoped skip alongside the query that actually covers it — don't recreate
 * a blanket assumption-based list.
 *
 * Note: `no-dupe-class-members` didn't actually fire immediately
 * post-removal — its rule YAML uses a top-level `utils:` block that this
 * runner's native-config passthrough dropped entirely, a separate bug
 * (affecting 5 shipped rules, not just this one) fixed in #663.
 */

/**
 * Rules commonly covered by ESLint/Biome correctness checks.
 * We can suppress these from ast-grep in lint-enabled projects to reduce noise.
 */
const LINTER_OVERLAP = new Set([
	"getter-return",
	"no-array-constructor",
	"no-async-promise-executor",
	"no-await-in-loop",
	"no-case-declarations",
	"no-compare-neg-zero",
	"no-cond-assign",
	"no-constant-condition",
	"no-constructor-return",
	"no-dupe-args",
	"no-dupe-keys",
	"no-extra-boolean-cast",
	"no-new-symbol",
	"no-new-wrappers",
	"no-prototype-builtins",
]);

const NON_SUPPRESSIBLE = new Set([
	"empty-catch",
	"no-discarded-error",
	"unchecked-throwing-call",
]);

function defaultFixSuggestion(defectClass: string, ruleId: string): string {
	if (defectClass === "silent-error") {
		return "Handle the error path explicitly: log context and rethrow or return a typed error result.";
	}
	if (defectClass === "secrets") {
		return "Remove hardcoded secret material and load values from env/secret manager.";
	}
	if (defectClass === "injection") {
		return "Avoid dynamic execution/interpolation here; use parameterized APIs or strict allowlists.";
	}
	if (defectClass === "async-misuse") {
		return "Make async flow explicit: await consistently and handle rejection/error paths.";
	}
	if (ruleId.includes("unsafe") || ruleId.includes("security")) {
		return "Refactor to a safer API usage with explicit validation and bounded behavior.";
	}
	return "Refactor this pattern to the safer equivalent used in the codebase.";
}

function explicitRuleFixSuggestion(rule: YamlRule): string | undefined {
	const raw = (rule.fix ?? rule.note ?? "").trim();
	if (!raw) return undefined;
	const oneLine = raw.replace(/\s+/g, " ").trim();
	return oneLine.length > 240 ? `${oneLine.slice(0, 237)}...` : oneLine;
}

function normalizeRuleId(ruleId: string): string {
	return ruleId.replace(/-js$/, "");
}

/**
 * `filePath` relative to `root`, forward-slashed, for matching a rule's
 * `ignores` globs (#965). Falls back to the absolute (slash-normalized) path
 * when `filePath` isn't under `root` (e.g. an out-of-tree temp file), so a
 * glob like `scripts/**` simply never matches rather than throwing.
 */
function relativeForIgnoreGlob(filePath: string, root: string): string {
	const rel = path.relative(root, filePath);
	return (rel.startsWith("..") ? filePath : rel).split(path.sep).join("/");
}

function matchesRuleIgnores(
	filePath: string,
	root: string,
	patterns: string[] | undefined,
): boolean {
	if (!patterns || patterns.length === 0) return false;
	const rel = relativeForIgnoreGlob(filePath, root);
	return patterns.some((pattern) => minimatch(rel, pattern, { dot: true }));
}

export function canHandle(filePath: string): boolean {
	return SUPPORTED_EXTS.includes(path.extname(filePath).toLowerCase());
}

/**
 * The TypeScript grammar is a syntactic superset of JavaScript, so a
 * `JavaScript`-tagged rule using generic node kinds (`variable_declarator`,
 * `assignment_expression`, …) still matches against a parsed `.ts` root
 * — and vice versa isn't an issue since JS files never parse
 * TS-only syntax, but a `TypeScript`-tagged rule with a plain-JS-compatible
 * body would equally double-fire alongside a `JavaScript` twin on a `.ts`
 * file. Without this, `language:` reads as a real filter but isn't one for
 * ts↔js pairs, so twin rules sharing a base name (e.g. `hardcoded-url` /
 * `hardcoded-url-js`) both match the same construct in the SAME runner
 * invocation (#657). TSX is its own grammar here too — the primary
 * ast-grep CLI/LSP also treats `tsx` as distinct from `typescript` — but
 * the caller's language-match check adds ONE deliberate exception on top
 * of the exact-match rule: a `TypeScript`-tagged rule also runs against
 * a `.tsx` file's fileLang (#1608). This is grounded empirically, not by
 * analogy — tsx's grammar is a syntactic superset of typescript's for
 * every construct the shipped catalog's rules target (JSX productions
 * added, plus the removal of the `<T>expr` cast form, which cannot
 * appear in valid `.tsx` source), and every `language: TypeScript`
 * rule's fixture-test `invalid:` snippet is asserted to still match
 * parsed as tsx (ast-grep-tsx-coverage.test.ts) rather than assumed.
 * Without this exception the entire TS ruleset silently never runs on
 * `.tsx` files. `TSX`-tagged rules stay `.tsx`-exclusive; the exception
 * is TS→TSX only. Returns undefined for extensions this scoping doesn't
 * apply to (css/html), where no filtering is added.
 */
export function ruleLanguageForFile(
	filePath: string,
): "typescript" | "tsx" | "javascript" | undefined {
	const ext = path.extname(filePath).toLowerCase();
	switch (ext) {
		case ".ts":
			return "typescript";
		case ".tsx":
			return "tsx";
		case ".js":
		case ".jsx":
			return "javascript";
		default:
			return undefined;
	}
}

export function getLang(
	filePath: string,
	sgModule: AstGrepNapi,
) {
	const ext = path.extname(filePath).toLowerCase();
	switch (ext) {
		case ".ts":
			return sgModule.ts;
		case ".tsx":
			return sgModule.tsx;
		case ".js":
		case ".jsx":
			return sgModule.js;
		case ".css":
			return sgModule.css;
		case ".html":
		case ".htm":
			return sgModule.html;
		default:
			return undefined;
	}
}

/** Per-edit defaults — tuned to keep inline output bounded on a broken file. */
export interface AstGrepEvaluateOptions {
	/** Drop non-error rules and complexity-bounded blocking rules (per-edit blocking pass). */
	blockingOnly?: boolean;
	/** Cap matches kept per rule (default {@link MAX_MATCHES_PER_RULE}). */
	maxMatchesPerRule?: number;
	/** Cap total diagnostics per file (default {@link MAX_TOTAL_DIAGNOSTICS}). */
	maxTotalDiagnostics?: number;
	/** Workspace root that owns project-local rules; defaults to `cwd`. */
	projectRoot?: string;
	/**
	 * Optional sink for a rule that napi's native engine rejected outright
	 * (malformed shape, unresolved `matches: <name>` reference, invalid kind,
	 * …). Without this, a rule failure is swallowed as "zero diagnostics"
	 * indistinguishable from "the rule legitimately found nothing" (#663).
	 * Best-effort only — never let a logging failure affect matching.
	 */
	log?: (message: string) => void;
	/** Rule ids already reported as unsupported by the surrounding scan/run. */
	unsupportedLanguageLog?: Set<string>;
}

function duplicateRuleIds(rules: YamlRule[]): string[] {
	const counts = new Map<string, number>();
	for (const rule of rules) {
		counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
	}
	return Array.from(counts)
		.filter(([, count]) => count > 1)
		.map(([id]) => id)
		.sort((a, b) => a.localeCompare(b));
}

function appendDuplicateRuleDiagnostics(
	diagnostics: Diagnostic[],
	seenRuleIds: Set<string>,
	duplicateIds: string[],
	source: AstGrepRuleSource,
	filePath: string,
	maxTotalDiagnostics: number,
): boolean {
	const sourceLabel = `${source.origin} ${source.tier} rules`;
	for (const ruleId of duplicateIds) {
		diagnostics.push({
			id: `ast-grep-napi-config-duplicate-${source.origin}-${source.tier}-${ruleId}`,
			message: `Duplicate ast-grep rule id "${ruleId}" in ${sourceLabel}`,
			filePath,
			line: 1,
			column: 1,
			severity: "error",
			semantic: "blocking",
			tool: "ast-grep-napi",
			rule: ruleId,
			defectClass: "correctness",
			fixable: false,
			autoFixAvailable: false,
			fixSuggestion: `Give every rule in ${sourceLabel} a unique id`,
		});
		seenRuleIds.add(ruleId);
		if (diagnostics.length >= maxTotalDiagnostics) return true;
	}
	return false;
}

/**
 * The four tiers `Diagnostic.severity` accepts (clients/dispatch/types.ts).
 * `YamlRule.severity` is a free-form string straight off disk, so an unknown
 * or missing value must land somewhere deliberate rather than being cast.
 */
const DIAGNOSTIC_SEVERITY_TIERS = new Set<Diagnostic["severity"]>([
	"error",
	"warning",
	"info",
	"hint",
]);

/**
 * Map a rule's declared YAML severity onto a `Diagnostic.severity` tier (#1777).
 *
 * A rule that declares nothing, or declares a value pi-lens does not model
 * (ast-grep also accepts `off`), falls back to `warning` — the tier every such
 * rule already reported at before #1777, so reviving hint/info never silently
 * demotes an existing rule.
 */
export function normalizeRuleSeverity(
	raw: string | undefined,
): Diagnostic["severity"] {
	const tier = raw as Diagnostic["severity"] | undefined;
	return tier && DIAGNOSTIC_SEVERITY_TIERS.has(tier) ? tier : "warning";
}

/**
 * Run the shipped ast-grep YAML ruleset against a parsed file via napi's native
 * engine, applying the same suppression policy (linter/tree-sitter overlap,
 * overly-broad-pattern guard) as the per-edit runner. Extracted so the
 * project-wide scanner can reuse the identical engine + rules WITHOUT the
 * ast-grep binary — closing the no-binary gap (#308) — while the per-edit runner
 * keeps its tight budgets. Callers pass the already-parsed `rootNode` so they
 * control parsing/size gating.
 */
export function evaluateAstGrepRules(
	filePath: string,
	rootNode: { findAll(config: never): unknown[] },
	cwd: string,
	kind: string | undefined,
	options: AstGrepEvaluateOptions = {},
): Diagnostic[] {
	const maxMatchesPerRule = options.maxMatchesPerRule ?? MAX_MATCHES_PER_RULE;
	const maxTotalDiagnostics =
		options.maxTotalDiagnostics ?? MAX_TOTAL_DIAGNOSTICS;
	const blockingOnly = options.blockingOnly === true;
	const log = options.log;
	const unsupportedLanguageLog =
		options.unsupportedLanguageLog ?? defaultUnsupportedLanguageLog;

	const diagnostics: Diagnostic[] = [];
	const seenRuleIds = new Set<string>();
	const suppressLinterOverlap = kind === "jsts" && hasEslintConfig(cwd);
	const fileLang = ruleLanguageForFile(filePath);
	// Unsupported-language skips are expected in bulk (every non-jsts rule in the
	// catalog, e.g. ~30 Python rules) — aggregate them into ONE latency-log entry
	// per evaluation instead of per-rule terminal lines (#282 follow-up).
	const newlyUnsupported = new Map<string, string[]>();
	const flushUnsupportedRuleSkips = (): void => {
		if (newlyUnsupported.size === 0) return;
		const firstSeenLanguages = Array.from(newlyUnsupported.entries()).filter(
			([language]) => !unsupportedLanguageLog.has(language),
		);
		for (const [language] of firstSeenLanguages) {
			unsupportedLanguageLog.add(language);
		}
		if (firstSeenLanguages.length === 0) {
			newlyUnsupported.clear();
			return;
		}
		for (const [language] of firstSeenLanguages) unsupportedLanguageLog.add(language);
		logLatency({
			type: "phase",
			phase: "astgrep_napi_unsupported_rules_skipped",
			filePath,
			durationMs: 0,
			metadata: {
				skippedByLanguage: Object.fromEntries(
					firstSeenLanguages.map(([language, ruleIds]) => [
						language,
						{
							count: ruleIds.length,
							ruleIds: ruleIds.slice(0, UNSUPPORTED_RULE_ID_SAMPLE_SIZE),
						},
					]),
				),
			},
		});
		newlyUnsupported.clear();
	};

	// Shared with the raw sgconfig materializer so both surfaces walk the same
	// workspace-rooted sources in the same precedence order.
	const ignoreRoot = options.projectRoot ?? cwd;
	const ruleSources = getAstGrepRuleSources(ignoreRoot);

	for (const source of ruleSources) {
		let rules: YamlRule[];
		try {
			// Project rules are mutable during a session, so their cache fingerprints
			// relative paths and contents. Bundled catalogs are immutable per install.
			const loader =
				source.origin === "project" ? loadYamlRulesFresh : loadYamlRules;
			rules = loader(source.dir);
		} catch {
			continue;
		}

		const duplicates = duplicateRuleIds(rules);
		if (
			appendDuplicateRuleDiagnostics(
				diagnostics,
				seenRuleIds,
				duplicates,
				source,
				filePath,
				maxTotalDiagnostics,
			)
		) {
			flushUnsupportedRuleSkips();
			return diagnostics;
		}
		const duplicateSet = new Set(duplicates);

		for (const rule of rules) {
			if (duplicateSet.has(rule.id)) continue;
			// Cross-layer collisions keep the first (higher-precedence) source.
			if (seenRuleIds.has(rule.id)) continue;
			seenRuleIds.add(rule.id);
			if (blockingOnly && rule.severity !== "error") continue;
			// Per-rule path carve-out (#965): a rule that's noise on CLI scripts or
			// a project's own logging sink (e.g. no-console-except-error firing
			// inside scripts/** or lib/logger.ts) opts out via `ignores`.
			if (matchesRuleIgnores(filePath, ignoreRoot, rule.ignores)) continue;

			if (
				suppressLinterOverlap &&
				LINTER_OVERLAP.has(normalizeRuleId(rule.id)) &&
				!NON_SUPPRESSIBLE.has(normalizeRuleId(rule.id))
			) {
				continue;
			}

			// Skip rules whose top-level pattern is overly broad ($NAME, $X, etc.)
			// without additional structural constraints to narrow matches.
			if (
				rule.rule &&
				isOverlyBroadPattern(rule.rule.pattern) &&
				!isStructuredRule(rule)
			) {
				continue;
			}

			const lang = rule.language?.toLowerCase();
			if (
				lang &&
				lang !== "typescript" &&
				lang !== "tsx" &&
				lang !== "javascript"
			) {
				if (!unsupportedLanguageLog.has(lang)) {
					const ids = newlyUnsupported.get(lang) ?? [];
					ids.push(rule.id);
					newlyUnsupported.set(lang, ids);
				}
				continue;
			}
			// Scope TypeScript/JavaScript-tagged rules to the file's actual
			// grammar (#657) — otherwise a `-js` twin sharing generic node
			// kinds with its TS sibling double-fires on every .ts file. TSX
			// is the one deliberate exception (#1608): the tsx grammar is a
			// syntactic superset of typescript's for every non-JSX construct
			// (the `<T>expr` cast form is the only TS-only production, and
			// it can't appear in valid .tsx source anyway), so a
			// `language: TypeScript` rule still matches a tsx-parsed root
			// and must run there too, or the entire TS ruleset (120 of 263
			// rules) goes dark on every .tsx file. `language: TSX` rules
			// stay tsx-exclusive — they're already scoped to fileLang
			// "tsx" by the exact-match check.
			if (lang && fileLang && lang !== fileLang) {
				const runsAsTsOnTsx = fileLang === "tsx" && lang === "typescript";
				if (!runsAsTsOnTsx) {
					const key = `mismatch:${lang}->${fileLang}`;
					if (!unsupportedLanguageLog.has(key)) {
						const ids = newlyUnsupported.get(key) ?? [];
						ids.push(rule.id);
						newlyUnsupported.set(key, ids);
					}
					continue;
				}
			}

			if (blockingOnly && rule.rule) {
				const complexity = calculateRuleComplexity(rule.rule);
				if (complexity > MAX_BLOCKING_RULE_COMPLEXITY) {
					continue;
				}
			}

			if (!rule.rule) continue;

			try {
				let matches: unknown[] = [];

				// Delegate matching to napi's native engine, which handles the
				// full ast-grep rule grammar (pattern, kind, has/inside/follows/
				// precedes/stopBy/field/nthChild, any/all/not) plus metavariable
				// `constraints` (#206) AND top-level `utils` — reusable named
				// matchers referenced via `matches: <name>` inside `rule`
				// (#663; `NapiConfig.utils: Record<string, Rule>` per
				// @ast-grep/napi's types, same shape napi already expects for
				// `rule`/`constraints`). A faithful js-yaml parse feeds the rule
				// object straight through. If napi rejects the rule (a malformed
				// or invalid-kind rule, or an unresolved `matches:` reference),
				// skip it — never silently match nothing through a partial
				// interpreter.
				const nativeConfig: Record<string, unknown> = { rule: rule.rule };
				if (rule.constraints) nativeConfig.constraints = rule.constraints;
				if (rule.utils) nativeConfig.utils = rule.utils;
				try {
					matches = rootNode.findAll(nativeConfig as never);
				} catch (err) {
					matches = [];
					log?.(
						`ast-grep-napi: rule "${rule.id}" rejected by native engine (${
							err instanceof Error ? err.message : String(err)
						})`,
					);
				}

				const limitedMatches = matches.slice(0, maxMatchesPerRule);

				for (const match of limitedMatches) {
					if (diagnostics.length >= maxTotalDiagnostics) break;

					const node = match as {
						range(): { start: { line: number; column: number } };
					};
					const range = node.range();
					// #1777: carry the rule's own tier through. The old collapse
					// (`=== "error" ? "error" : "warning"`) erased hint and info,
					// so the quiet tier the #1727 anti-slop rules ship at did not
					// exist anywhere downstream. `Diagnostic.severity` has been
					// 4-valued all along (clients/dispatch/types.ts). The BLOCKING
					// gate is unchanged and deliberately narrower: only `error`
					// blocks, so hint and info stay advisory exactly like warning.
					const severity = normalizeRuleSeverity(rule.severity);
					const semantic = severity === "error" ? "blocking" : "warning";
					const defectClass = classifyDefect(
						rule.id,
						"ast-grep-napi",
						rule.message || rule.id,
					);
					const ruleFix = explicitRuleFixSuggestion(rule);

					diagnostics.push({
						id: `ast-grep-napi-${range.start.line}-${rule.id}`,
						message: `[${rule.metadata?.category || "slop"}] ${rule.message || rule.id}`,
						filePath,
						line: range.start.line + 1,
						column: range.start.column + 1,
						severity,
						semantic,
						tool: "ast-grep-napi",
						rule: rule.id,
						defectClass,
						fixable: !!ruleFix,
						autoFixAvailable: false,
						fixKind: ruleFix ? "suggestion" : undefined,
						fixSuggestion:
							semantic === "blocking"
								? (ruleFix ?? defaultFixSuggestion(defectClass, rule.id))
								: ruleFix,
					});
				}

				if (diagnostics.length >= maxTotalDiagnostics) break;
			} catch {
				// Rule failed, skip
			}
		}
	}

	flushUnsupportedRuleSkips();
	return diagnostics;
}

// --- Runner Definition ---

const astGrepNapiRunner: RunnerDefinition = {
	id: "ast-grep-napi",
	appliesTo: ["jsts"],
	priority: PRIORITY.SPECIALIZED_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		if (!canHandle(ctx.filePath)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// #239 Phase 2: the ast-grep LSP supersedes this in-process runner when its
		// binary is available — same Rust engine, plus codeAction fixes, and it runs
		// the shipped baseline ruleset via `--config`. Skip here so we don't double-
		// report against the LSP's `tool: ast-grep` diagnostics. Resume ONLY as the
		// fallback when the binary is absent / can't spawn (Gate B).
		const astGrepLspEnabled = enabledAuxiliaryLspServerIds((f) =>
			ctx.pi?.getFlag?.(f),
		).includes("ast-grep");
		// Gate B asks whether the LSP will handle this file, not whether a bare
		// `ast-grep` command happens to be on PATH. The launcher first tries the
		// platform-native package binary, then PATH; mirror that resolution here.
		// A live client covers the already-warm case, while a resolvable binary
		// covers the cold case before the LSP has spawned for this root.
		const astGrepLspAlive = astGrepLspEnabled
			? await isAuxiliaryLspAlive("ast-grep", ctx.filePath)
			: false;
		let astGrepBinaryResolvable = false;
		if (astGrepLspEnabled && !astGrepLspAlive) {
			astGrepBinaryResolvable =
				Boolean(resolveAstGrepNativeExe()) || (await ctx.hasTool("ast-grep"));
		}
		if (astGrepLspEnabled && (astGrepLspAlive || astGrepBinaryResolvable)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const sgModule = await loadSg();
		if (!sgModule) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		if (!fs.existsSync(ctx.filePath)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const lang = getLang(ctx.filePath, sgModule);
		if (!lang) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let stats: import("fs").Stats;
		try {
			stats = fs.statSync(ctx.filePath);
		} catch {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}
		if (stats.size > 1024 * 1024) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let content: string;
		const contentFromFacts = ctx.facts.getFileFact<string | null>(
			ctx.filePath,
			"file.content",
		);
		if (contentFromFacts !== undefined && contentFromFacts !== null) {
			content = contentFromFacts;
		} else {
			try {
				content = fs.readFileSync(ctx.filePath, "utf-8");
			} catch {
				return { status: "skipped", diagnostics: [], semantic: "none" };
			}
		}

		let root: SgRoot;
		try {
			root = lang.parse(content);
		} catch {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let rootNode: any;
		try {
			rootNode = root.root();
		} catch {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const diagnostics = evaluateAstGrepRules(
			ctx.filePath,
			rootNode,
			ctx.cwd,
			ctx.kind,
			{
				blockingOnly: ctx.blockingOnly,
				projectRoot: ctx.projectRoot,
				log: (message: string) => ctx.log(message),
			},
		);

		const hasBlocking = diagnostics.some((d) => d.semantic === "blocking");
		let semantic: "blocking" | "warning" | "none" = "none";
		if (hasBlocking) {
			semantic = "blocking";
		} else if (diagnostics.length > 0) {
			semantic = "warning";
		}
		return {
			status: hasBlocking ? "failed" : "succeeded",
			diagnostics,
			semantic,
		};
	},
};

export default astGrepNapiRunner;
