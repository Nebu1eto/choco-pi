/** Bounded, process-local telemetry for behavior degraded during one session. */

import { logExtension } from "./extension-log.js";

export type DegradationKind =
	| "trust-refusal"
	| "mode-suppression"
	| "ts-idle-eviction"
	| "spawn-failure"
	| "formatter-skip"
	| "grammar-blocked"
	| "lsp-breaker"
	/**
	 * A per-file touch skipped a language server because that server is in the
	 * breaker cooldown or is latched permanently broken (#1743). During an
	 * outage this fires once per file per touch, so the count here is the exact
	 * total and only the FIRST skip per (server, file) also writes an
	 * `lsp_client_skipped_broken` latency.log record.
	 */
	| "lsp-client-skipped-broken"
	/**
	 * A per-file touch skipped a language server because its direct spawn
	 * command is temporarily marked unavailable (#1743). Same shape and same
	 * bounding as `lsp-client-skipped-broken`, but keyed on the command, since
	 * that is what the availability latch is about.
	 */
	| "lsp-client-skipped-unavailable-command"
	| "formatter-failure"
	| "wasm-abort"
	| "lsp-diagnostics-timeout"
	| "bus-stale"
	| "query-predicates-invalid"
	| "install-retry-exhausted"
	| "ast-grep-napi-unavailable"
	/**
	 * `loadWebTreeSitter()` (clients/deps/web-tree-sitter.js) rejected during
	 * MODULE EVALUATION, not resolution (#1592). Node's ESM loader permanently
	 * memoizes a module record that threw while evaluating, so re-importing
	 * the same resolved URL replays the cached rejection rather than
	 * re-attempting the load — a same-process retry is dead. TreeSitterClient
	 * latches this permanently instead of retrying on every parse call.
	 */
	| "web-tree-sitter-load-failed"
	| "instance-registry-corrupt"
	| "cascade-budget-override-disarmed"
	| "lsp-pull-unconfirmed"
	/**
	 * A pi-lens `tool_call` handler threw. pi's `emitToolCall` has no
	 * per-handler catch, so an escaped throw blocks the user's tool call —
	 * this kind means the total guard absorbed one (#1655 item 1).
	 */
	| "tool-call-handler-throw"
	/**
	 * A tool-event path did not resolve to an existing file, and pi's own
	 * unicode/spacing variant ladder did not find it either (#1655 item 5).
	 * The issue names this `path_variant_unresolved`; the ledger's kind
	 * vocabulary is kebab-case, so it is spelled that way here.
	 */
	| "path-variant-unresolved"
	/**
	 * A deferred-format record's origin (the cwd/worktree it was queued
	 * under) does not match the flush attempting to claim it as an orphan,
	 * so it stays queued and re-surfaces on every subsequent `agent_end`
	 * until a flush from its actual origin claims it (#1642 F3, #1678
	 * item 1).
	 */
	| "path-attribution-orphan-unresolved"
	/**
	 * A `textDocument/diagnostic` or `workspace/diagnostic` pull's per-request
	 * `withTimeout` abandoned the request, and the request later settled anyway
	 * (#1713). The answer arrived too late to serve the caller that timed out,
	 * so it is discarded — this kind is the only trace that it ever landed.
	 */
	| "lsp-pull-late-answer"
	/**
	 * A managed npm tool's periodic version refresh did not complete, or the
	 * refresh state file could not be read (#1730). The tool keeps serving on
	 * the version already installed — this kind means pi-lens cannot prove that
	 * version is the newest the tool's declared range permits.
	 */
	| "managed-tool-refresh"
	/**
	 * `navRequest`'s (`clients/lsp/client.ts`) per-request `withTimeout`
	 * abandoned a hover/definition/references/etc. request (#1716). Every
	 * timeout is counted here; only the FIRST occurrence per (method, file)
	 * this session also writes a detailed `lsp_nav_request_timeout`
	 * latency.log record — navRequest is the highest-volume LSP call site, so
	 * a stuck server storming timeouts must not storm log writes too.
	 */
	| "lsp-nav-request-timeout"
	/**
	 * The abandoned request behind an `lsp-nav-request-timeout` settled anyway
	 * after the caller gave up (#1716) — the nav-request sibling of
	 * `lsp-pull-late-answer`. Nav answers are read-once (no persistent cache
	 * to poison), but the count still tells a dogfood session whether a
	 * "hung" server is truly hung or just answering late.
	 */
	| "lsp-nav-late-answer"
	/**
	 * The abandoned request behind an `lsp-pull-late-answer` timeout REJECTED
	 * instead of answering (#1774) — e.g. a permanent server error such as
	 * `RequestFailed` (-32803) surfacing after the caller gave up.
	 * `ContentModified` (-32801) does NOT reach here: `safeSendRequest`
	 * retries it once internally and resolves `undefined` rather than
	 * rejecting. Without this kind, "timeout then silence" and "timeout then
	 * rejection" both read as the same nothing in latency.log, which is
	 * exactly the discrimination #1549's requests-die-or-arrive-late verdict
	 * needs. The rejection handler still swallows the error; this only
	 * observes it.
	 */
	| "lsp-pull-late-rejection"
	/**
	 * A `textDocument/diagnostic` or `workspace/diagnostic` pull's per-request
	 * `withTimeout` abandoned a GENUINELY dispatched request (#1771). Every
	 * pull timeout emits a detailed `lsp_pull_diagnostic_timeout` latency.log
	 * record already, but until now that record counted nothing in the
	 * ledger — the bounded-telemetry rule (`clients/bounded-telemetry.ts`)
	 * says a failure path omits `ledgerKind` only when it is not a
	 * degradation, and an abandoned pull is one. Subject carries server and
	 * file so a storming server is visible in aggregate, not just per-event.
	 */
	| "lsp-pull-diagnostic-timeout"
	/**
	 * A `textDocument/diagnostic` or `workspace/diagnostic` pull was SKIPPED
	 * outright because the caller's budget was already exhausted (#1773,
	 * review round). Not dispatched, so it is not an LSP-side degradation the
	 * way `lsp-pull-diagnostic-timeout` is — the server never saw the
	 * request — but a caller that repeatedly hands out exhausted budgets to
	 * this call site is itself a shape worth seeing in aggregate (e.g. a
	 * sweep whose own upstream deadline math is too tight). Subject carries
	 * server and file for the same reason every other pull kind does.
	 */
	| "lsp-pull-skipped-budget-exhausted"
	/**
	 * A `GenerationHandle.guardedWrite` (`clients/generation-guard.ts`) dropped
	 * a post-await write because the generation it captured is no longer
	 * current (#1754) — a session reset, a cache refresh, or a newer request
	 * for the same key landed while the write's producer was in flight. The
	 * drop is correct: the write belongs to a world that no longer exists.
	 * It is recorded because a silently dropped write is indistinguishable
	 * from a guard that never fires, which is how two hand-rolled versions of
	 * this guard reached review vacuous. Subject carries the source name and
	 * the identity of the dropped write.
	 */
	| "generation-guard-stale-write"
	/**
	 * A shell-out linter/analyzer runner (knip, vulture, jscpd, trivy-config, …)
	 * produced no usable output — empty stdout, unparseable stdout (e.g. a
	 * rejected CLI flag that prints usage text instead of the expected report;
	 * #1757), or (for report-file runners) no report file — on a NONZERO exit
	 * (#1736). The empty-result branches these runners fall back to for "no
	 * findings" must never fire here: a broken shim, crash, rejected flag, or
	 * config-load error must read as errored/skipped, not clean. Reason names
	 * the binary and exit status so a stuck/corrupted runner is diagnosable
	 * from the ledger alone.
	 */
	| "runner-empty-result";

export interface DegradationRecord {
	kind: unknown;
	subject: unknown;
	reason: unknown;
}

export interface DegradationGroup {
	kind: string;
	/** Exact number recorded, including events no longer retained. */
	count: number;
	/** Number omitted from latestReasons by the per-kind bound. */
	droppedCount: number;
	latestReasons: Array<{ subject: string; reason: string }>;
}

const ENTRIES_PER_KIND = 20;
const MAX_DISTINCT_KINDS = 32;
const OVERFLOW_KIND = "other";
const groups = new Map<
	string,
	{ count: number; entries: Array<{ subject: string; reason: string }> }
>();
const onceKeys = new Set<string>();
const tallies = new Map<string, number>();
// Monotonic session-boundary counter (#1536 review F5): callers that keep
// their OWN once-per-session latch outside the ledger (a per-instance Set
// the ledger itself doesn't own) can compare this lazily at use time and
// clear their latch on a mismatch — the same clear-on-transition shape as
// project-trust.ts's trustGeneration, but keyed to the ledger's own reset
// (resetDegradationLedger, wired into handleSessionStart) rather than a
// trust change.
let ledgerGeneration = 0;

/** Current session generation. Bump on every `resetDegradationLedger()`. */
export function getDegradationLedgerGeneration(): number {
	return ledgerGeneration;
}

export function recordDegradation(record: DegradationRecord): void {
	try {
		const kind = boundedKind(record.kind);
		const subject = truncateForLedger(record.subject);
		const reason = truncateForLedger(record.reason);
		let group = groups.get(kind);
		if (!group) {
			group = { count: 0, entries: [] };
			groups.set(kind, group);
		}
		group.count += 1;
		// Bounded at RECORD time (#1366 review): reasons carry arbitrary error
		// text; a 10KB message must never become a 10KB health line or a 10KB
		// retained string.
		group.entries.push({ subject, reason });
		if (group.entries.length > ENTRIES_PER_KIND) group.entries.shift();
	} catch (error) {
		debugLedgerFailure("record", error);
		// Telemetry must never break the observed path.
	}
}

/** Record at most once per kind/subject during the current session. */
export function recordDegradationOnce(record: DegradationRecord): void {
	try {
		const kind = boundedKind(record.kind);
		const subject = truncateForLedger(record.subject);
		const key = `${kind}\0${subject}`;
		if (onceKeys.has(key)) return;
		onceKeys.add(key);
		recordDegradation({ kind, subject, reason: record.reason });
	} catch (error) {
		debugLedgerFailure("record-once", error);
		// Telemetry must never break the observed path.
	}
}

/**
 * Count a repeated degradation while retaining one latest-reason entry per
 * kind/subject. The group count remains the exact event total.
 *
 * Returns `true` when this call is the FIRST occurrence recorded for this
 * kind/subject pair (the ledger is the single source of truth for that
 * tally already — via `tallies` — so callers that need a once-per-subject
 * "rising edge" signal, e.g. to gate a verbose one-time log line before
 * falling back to the bounded count, read it off this return value instead
 * of hand-rolling their own parallel `Set`/latch). #1716 reuses this same
 * signal to gate `navRequest`'s detailed timeout/late-answer log writes.
 */
export function incrementDegradationCount(record: DegradationRecord): boolean {
	try {
		const kind = boundedKind(record.kind);
		const subject = truncateForLedger(record.subject);
		const reason = truncateForLedger(record.reason);
		const key = `${kind}\0${subject}`;
		const count = (tallies.get(key) ?? 0) + 1;
		tallies.set(key, count);
		let group = groups.get(kind);
		if (!group) {
			group = { count: 0, entries: [] };
			groups.set(kind, group);
		}
		group.count += 1;
		const entry = {
			subject,
			reason: truncateForLedger(`${reason} (count: ${count})`),
		};
		const existing = group.entries.findIndex(
			(candidate) => candidate.subject === subject,
		);
		if (existing >= 0) group.entries.splice(existing, 1);
		group.entries.push(entry);
		if (group.entries.length > ENTRIES_PER_KIND) group.entries.shift();
		return count === 1;
	} catch (error) {
		debugLedgerFailure("increment", error);
		// Telemetry must never break the observed path.
		return false;
	}
}

/** Detached snapshot, grouped in first-seen kind order. */
const LEDGER_FIELD_MAX = 200;

function normalizeForLedger(value: unknown): string {
	return String(value ?? "unknown");
}

function boundedKind(value: unknown): string {
	const kind = truncateForLedger(value);
	if (groups.has(kind) || kind === OVERFLOW_KIND) return kind;
	// Keep one slot available for all kinds beyond the cardinality bound.
	return groups.size < MAX_DISTINCT_KINDS - 1 ? kind : OVERFLOW_KIND;
}

function truncateForLedger(value: unknown): string {
	const text = normalizeForLedger(value);
	return text.length > LEDGER_FIELD_MAX
		? `${text.slice(0, LEDGER_FIELD_MAX)}…`
		: text;
}

export function getDegradationSummary(): DegradationGroup[] {
	return [...groups.entries()].map(([kind, group]) => ({
		kind,
		count: group.count,
		droppedCount: group.count - group.entries.length,
		latestReasons: group.entries.map((entry) => ({ ...entry })),
	}));
}

function isRenderableSummary(value: unknown): value is DegradationGroup[] {
	if (!Array.isArray(value)) return false;
	return value.every((group) => {
		if (group === null || typeof group !== "object") return false;
		const candidate = group as Partial<DegradationGroup>;
		return (
			typeof candidate.kind === "string" &&
			typeof candidate.count === "number" &&
			Array.isArray(candidate.latestReasons) &&
			candidate.latestReasons.every(
				(entry) =>
					entry !== null &&
					typeof entry === "object" &&
					typeof (entry as { subject?: unknown }).subject === "string" &&
					typeof (entry as { reason?: unknown }).reason === "string",
			)
		);
	});
}

export function renderDegradationLines(
	summary: unknown = getDegradationSummary(),
): string[] {
	if (!isRenderableSummary(summary)) return [];
	if (summary.length === 0) return [];
	return [
		"Degradations:",
		...summary.map((group) => {
			const latest = group.latestReasons.at(-1);
			return `  ⚠ ${group.kind}: ${group.count}${latest ? ` — ${latest.subject}: ${latest.reason}` : ""}`;
		}),
	];
}

function debugLedgerFailure(operation: string, error: unknown): void {
	try {
		logExtension({
			subsystem: "degradation-ledger",
			level: "debug",
			message: `${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
		});
	} catch {
		// Debug logging must not compromise the non-fatal telemetry contract.
	}
}

/** Session-boundary/test reset. */
export function resetDegradationLedger(): void {
	groups.clear();
	onceKeys.clear();
	tallies.clear();
	ledgerGeneration++;
}

export const DEGRADATION_ENTRIES_PER_KIND = ENTRIES_PER_KIND;
export const DEGRADATION_MAX_DISTINCT_KINDS = MAX_DISTINCT_KINDS;
