import { open } from "node:fs/promises";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	AGENT_BROWSER_SCRIPT_FINAL_OUTPUT_MAX_BYTES,
	AGENT_BROWSER_SCRIPT_IPC_MESSAGE_MAX_BYTES,
	AGENT_BROWSER_SCRIPT_SPILL_MAX_BYTES,
	createAgentBrowserScriptCloseArgs,
	isAgentBrowserScriptSessionName,
	type AgentBrowserScriptBrowserEnvelope,
	type AgentBrowserScriptRunResult,
	validateAgentBrowserScriptBrowserParams,
} from "../input-modes/script.ts";
import { hasRuntimeType, isRecord, type RuntimeRecord, type RuntimeValue } from "../parsing.ts";
import { parseCommandInfo, redactSensitiveText } from "../runtime.ts";
import type { AgentBrowserNextAction, ArtifactVerificationSummary } from "../results/contracts.ts";
import { isSessionArtifactManifest } from "../results/artifact-manifest.ts";
import { redactPresentationData } from "../results/presentation/diagnostics.ts";
import { truncateText } from "../results/text.ts";
import type { AgentBrowserToolResult } from "./browser-run/index.ts";

const SCRIPT_SESSION_ENTRY_TYPE = "agent-browser-script-session";
const SCRIPT_BROWSER_SUMMARY_MAX_CHARS = 1_024;
const SCRIPT_BROWSER_TEXT_MAX_CHARS = 8_192;
type ScriptSessionCleanupState = "active" | "closed" | "failed";
type ScriptPayload = AgentBrowserScriptBrowserEnvelope["data"];
type ScriptResultValue = AgentBrowserToolResult["details"];

function isFailureCategory(value: RuntimeValue): value is NonNullable<AgentBrowserScriptBrowserEnvelope["failureCategory"]> {
	return value === "aborted" || value === "artifact-missing" || value === "cleanup-failed" || value === "confirmation-required" || value === "download-not-verified" || value === "missing-binary" || value === "parse-failure" || value === "policy-blocked" || value === "qa-failure" || value === "script-error" || value === "selector-not-found" || value === "selector-unsupported" || value === "stale-ref" || value === "tab-drift" || value === "tab-gone" || value === "timeout" || value === "upstream-error" || value === "validation-error";
}

function isSuccessCategory(value: RuntimeValue): value is NonNullable<AgentBrowserScriptBrowserEnvelope["successCategory"]> {
	return value === "artifact-pending" || value === "artifact-saved" || value === "artifact-unverified" || value === "completed" || value === "inspection";
}

interface NormalizedScriptNextActionParams {
	args: string[];
	stdin?: string;
}

interface ScriptSessionDetails {
	cleanup: "closed" | "failed";
	closeCommandArgs: string[];
	error?: string;
	launchAttempted: true;
	sessionName: string;
}

export interface ScriptSessionLease {
	cleanup: ScriptSessionCleanupState;
	closeCommandArgs: string[];
	launchAttempted: true;
	sessionName: string;
}

export function getScriptSessionLeasesFromBranch(branch: unknown[]): Map<string, ScriptSessionLease> {
	const leases = new Map<string, ScriptSessionLease>();
	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== SCRIPT_SESSION_ENTRY_TYPE || !isRecord(entry.data)) continue;
		const { cleanup, closeCommandArgs, launchAttempted, sessionName } = entry.data;
		if (!isAgentBrowserScriptSessionName(sessionName)) continue;
		const expectedCloseCommandArgs = createAgentBrowserScriptCloseArgs(sessionName);
		if ((cleanup !== "active" && cleanup !== "closed" && cleanup !== "failed")
			|| launchAttempted !== true
			|| !Array.isArray(closeCommandArgs)
			|| closeCommandArgs.length !== expectedCloseCommandArgs.length
			|| !closeCommandArgs.every((token, index) => token === expectedCloseCommandArgs[index])) continue;
		leases.set(sessionName, { cleanup, closeCommandArgs: expectedCloseCommandArgs, launchAttempted: true, sessionName });
	}
	return leases;
}

export function appendScriptSessionLease(pi: ExtensionAPI, sessionName: string, cleanup: ScriptSessionCleanupState): void {
	pi.appendEntry(SCRIPT_SESSION_ENTRY_TYPE, {
		cleanup,
		closeCommandArgs: createAgentBrowserScriptCloseArgs(sessionName),
		launchAttempted: true,
		sessionName,
	});
}

async function readVerifiedScriptSpill(result: AgentBrowserToolResult): Promise<ScriptPayload | undefined> {
	const details = isRecord(result.details) ? result.details : undefined;
	const path = hasRuntimeType(details?.fullOutputPath, "string") ? details.fullOutputPath : undefined;
	const manifest = isSessionArtifactManifest(details?.artifactManifest) ? details.artifactManifest : undefined;
	if (!path || !manifest?.entries.some((entry) =>
		entry.kind === "spill"
		&& (entry.path === path || entry.absolutePath === path)
		&& (entry.storageScope === "persistent-session" || entry.storageScope === "process-temp")
		&& (entry.retentionState === "live" || entry.retentionState === "ephemeral")
	)) return undefined;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, "r");
		const stats = await handle.stat();
		if (!stats.isFile() || stats.size < 0 || stats.size > AGENT_BROWSER_SCRIPT_SPILL_MAX_BYTES) return undefined;
		const buffer = Buffer.alloc(stats.size);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		const text = buffer.subarray(0, offset).toString("utf8");
		try {
			const payload: ScriptPayload = JSON.parse(text);
			return payload;
		} catch {
			return undefined;
		}
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function getToolResultText(result: AgentBrowserToolResult): string {
	return result.content
		.filter((item): item is { text: string; type: "text" } => item.type === "text")
		.map((item) => item.text)
		.join("\n\n");
}

function stripOwnedScriptSessionArgs(args: string[], sessionName: string | undefined): string[] {
	if (!isAgentBrowserScriptSessionName(sessionName)) return args;
	if (args[0] === "--namespace" && args[1] === "" && args[2] === "--session" && args[3] === sessionName) return args.slice(4);
	return args[0] === "--session" && args[1] === sessionName ? args.slice(2) : args;
}

function getScriptCompatibleNextActions(value: ScriptResultValue, sessionName: string | undefined): AgentBrowserNextAction[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const actions = value.flatMap((action): AgentBrowserNextAction[] => {
		if (!isRecord(action)) return [];
		if (!isRecord(action.params)) {
			if (!hasRuntimeType(action.artifactPath, "string")) return [];
			// SAFETY: nextActions originates from wrapper result builders; artifact-only actions require no params transformation.
			return [action as AgentBrowserNextAction];
		}
		if (Object.keys(action.params).some((key) => key !== "args" && key !== "stdin")) return [];
		if (!Array.isArray(action.params.args) || action.params.args.some((token: RuntimeValue) => !hasRuntimeType(token, "string"))) return [];
		if (action.params.stdin !== undefined && !hasRuntimeType(action.params.stdin, "string")) return [];
		const normalizedParams: NormalizedScriptNextActionParams = {
			args: stripOwnedScriptSessionArgs(action.params.args, sessionName),
		};
		if (hasRuntimeType(action.params.stdin, "string")) normalizedParams.stdin = action.params.stdin;
		if (!validateAgentBrowserScriptBrowserParams(normalizedParams).params) return [];
		// SAFETY: wrapper-built next actions supply the metadata fields, and params was normalized through the script browser schema above.
		return [{ ...action, params: normalizedParams } as AgentBrowserNextAction];
	});
	return actions.length > 0 ? actions : undefined;
}

function scriptBrowserEnvelopeFitsIpc(envelope: AgentBrowserScriptBrowserEnvelope): boolean {
	try {
		return Buffer.byteLength(JSON.stringify({ envelope, id: Number.MAX_SAFE_INTEGER, type: "response" }), "utf8") + 1 <= AGENT_BROWSER_SCRIPT_IPC_MESSAGE_MAX_BYTES;
	} catch {
		return false;
	}
}

function buildOversizedScriptBrowserEnvelope(): AgentBrowserScriptBrowserEnvelope {
	const text = "Browser result exceeds the script IPC response limit; narrow the inner browser call output.";
	return {
		data: null,
		details: { failureCategory: "upstream-error", resultCategory: "failure" },
		error: text,
		failureCategory: "upstream-error",
		ok: false,
		resultCategory: "failure",
		summary: text,
		text,
	};
}

export async function buildScriptBrowserEnvelope(result: AgentBrowserToolResult, args: string[], scriptSessionName?: string): Promise<AgentBrowserScriptBrowserEnvelope> {
	const details = isRecord(result.details) ? result.details : undefined;
	const fullData = await readVerifiedScriptSpill(result);
	const commandInfo = parseCommandInfo(args);
	const data = redactPresentationData(commandInfo, fullData ?? details?.data ?? null);
	const resultCategory = details?.resultCategory === "failure" || result.isError === true ? "failure" : "success";
	const text = truncateText(redactSensitiveText(getToolResultText(result)), SCRIPT_BROWSER_TEXT_MAX_CHARS);
	const summary = truncateText(redactSensitiveText(hasRuntimeType(details?.summary, "string") ? details.summary : text.split("\n", 1)[0] || "Browser call completed."), SCRIPT_BROWSER_SUMMARY_MAX_CHARS);
	const compatibleNextActions = getScriptCompatibleNextActions(details?.nextActions, scriptSessionName);
	const redactedNextActions = getScriptCompatibleNextActions(redactPresentationData(commandInfo, compatibleNextActions), undefined);
	const failureCategory = resultCategory === "failure" && isFailureCategory(details?.failureCategory)
		? details.failureCategory
		: undefined;
	const successCategory = resultCategory === "success" && isSuccessCategory(details?.successCategory)
		? details.successCategory
		: undefined;
	const envelopeDetails = redactPresentationData(commandInfo, {
		artifactVerification: details?.artifactVerification,
		artifacts: details?.artifacts,
		failureCategory,
		pageChangeSummary: details?.pageChangeSummary,
		resultCategory,
		successCategory,
	});
	let boundedEnvelopeDetails: NonNullable<AgentBrowserScriptBrowserEnvelope["details"]> = { resultCategory };
	if (isRecord(envelopeDetails)) {
		// SAFETY: redactPresentationData emits only JSON-compatible InputValue leaves for this bounded details object.
		boundedEnvelopeDetails = envelopeDetails as NonNullable<AgentBrowserScriptBrowserEnvelope["details"]>;
	}
	const envelope: AgentBrowserScriptBrowserEnvelope = {
		data,
		details: boundedEnvelopeDetails,
		error: resultCategory === "failure" ? summary : undefined,
		failureCategory,
		nextActions: redactedNextActions,
		ok: resultCategory === "success",
		resultCategory,
		successCategory,
		summary,
		text,
	};
	return scriptBrowserEnvelopeFitsIpc(envelope) ? envelope : buildOversizedScriptBrowserEnvelope();
}

function collectUniqueArtifacts(results: AgentBrowserToolResult[]): RuntimeRecord<RuntimeValue>[] | undefined {
	const records = results.flatMap((result) => {
		const details = isRecord(result.details) ? result.details : undefined;
		return Array.isArray(details?.artifacts) ? details.artifacts.filter(isRecord) : [];
	});
	const unique = new Map(records.map((record) => [String(record.absolutePath ?? record.path ?? JSON.stringify(record)), record]));
	return unique.size > 0 ? [...unique.values()] : undefined;
}

function collectScriptArtifactVerification(results: AgentBrowserToolResult[]): ArtifactVerificationSummary | undefined {
	const entries = results.flatMap((result) => {
		const details = isRecord(result.details) ? result.details : undefined;
		const verification = isRecord(details?.artifactVerification) ? details.artifactVerification : undefined;
		return Array.isArray(verification?.artifacts) ? verification.artifacts.filter(isRecord) : [];
	});
	const unique = [...new Map(entries.map((entry) => [String(entry.absolutePath ?? entry.path ?? JSON.stringify(entry)), entry])).values()];
	if (unique.length === 0) return undefined;
	const count = (state: string) => unique.filter((entry) => entry.state === state).length;
	return {
		// SAFETY: artifactVerification is emitted by the wrapper's ArtifactVerificationSummary owner; deduplication preserves each entry unchanged.
		artifacts: unique as ArtifactVerificationSummary["artifacts"],
		missingCount: count("missing"),
		pendingCount: count("pending"),
		unverifiedCount: count("unverified"),
		verified: unique.every((entry) => entry.state === "verified"),
		verifiedCount: count("verified"),
	};
}

function getLatestScriptResultDetail(results: AgentBrowserToolResult[], key: string): AgentBrowserToolResult["details"] {
	for (let index = results.length - 1; index >= 0; index -= 1) {
		const rawDetails = results[index]?.details;
		const details = isRecord(rawDetails) ? rawDetails : undefined;
		if (details?.[key] !== undefined) return details[key];
	}
	return undefined;
}

function buildScriptCloseNextAction(sessionName: string): AgentBrowserNextAction {
	return {
		id: "close-script-session-after-cleanup-failure",
		params: { args: createAgentBrowserScriptCloseArgs(sessionName) },
		reason: "Retry closing the isolated wrapper-owned script session after automatic cleanup failed.",
		safety: "Use these exact args; do not add profile, state, restore, namespace, or connection flags.",
		tool: "agent_browser",
	};
}

export function buildScriptToolResult(options: {
	cleanupError?: string;
	innerResults: AgentBrowserToolResult[];
	run: AgentBrowserScriptRunResult;
	sessionName?: string;
}): AgentBrowserToolResult {
	let data: AgentBrowserScriptRunResult["data"];
	let serializedData: string | undefined;
	let outputError: string | undefined;
	try {
		data = redactPresentationData({ command: "script" }, options.run.data);
		serializedData = data === undefined ? undefined : JSON.stringify(data);
		if (data !== undefined && serializedData === undefined) throw new TypeError("Script output is not JSON-serializable.");
		if (serializedData !== undefined && Buffer.byteLength(serializedData, "utf8") > AGENT_BROWSER_SCRIPT_FINAL_OUTPUT_MAX_BYTES) {
			throw new RangeError(`Redacted script output exceeds ${AGENT_BROWSER_SCRIPT_FINAL_OUTPUT_MAX_BYTES} bytes.`);
		}
	} catch {
		data = undefined;
		serializedData = undefined;
		outputError = "Final script output could not be safely rendered as bounded JSON.";
	}
	const steps = options.run.steps.map((step) => ({ ...step, summary: redactSensitiveText(step.summary) }));
	const rejectedFailureCategory = steps.find((step) => step.failureCategory === "policy-blocked")?.failureCategory
		?? (options.run.rejectedCallCount > 0 ? "validation-error" : undefined);
	const failureCategory = options.cleanupError
		? "cleanup-failed"
		: outputError ? "validation-error" : options.run.failureCategory ?? rejectedFailureCategory;
	const failed = failureCategory !== undefined || !options.run.ok;
	const failedStepCount = steps.filter((step) => !step.ok).length;
	const failedCallCount = Math.max(0, failedStepCount - options.run.rejectedCallCount);
	const successfulCallCount = steps.filter((step) => step.ok).length;
	const cleanupSuffix = options.sessionName && !options.cleanupError ? " Isolated script session closed." : "";
	const summary = `${options.cleanupError
		? `Script completed, but isolated session cleanup failed: ${redactSensitiveText(options.cleanupError)}`
		: outputError
			? `Script failed: ${outputError}`
			: options.run.ok
				? rejectedFailureCategory
					? `Script failed: ${options.run.rejectedCallCount} browser call${options.run.rejectedCallCount === 1 ? " was" : "s were"} rejected before dispatch.`
					: failedCallCount > 0
						? `Script completed (${options.run.callCount} browser call${options.run.callCount === 1 ? "" : "s"}; ${failedCallCount} returned failure for script handling).`
						: `Script completed (${options.run.callCount} browser call${options.run.callCount === 1 ? "" : "s"}).`
				: `Script failed: ${redactSensitiveText(options.run.error ?? "sandbox execution failed")}`}${cleanupSuffix}`;
	const dataText = serializedData === undefined ? "" : `\n\n${serializedData}`;
	const cleanupActionText = options.cleanupError && options.sessionName
		? `\n\nNext action: ${JSON.stringify({ args: createAgentBrowserScriptCloseArgs(options.sessionName) })}`
		: "";
	const artifactManifest = getLatestScriptResultDetail(options.innerResults, "artifactManifest");
	const artifactRetentionSummary = getLatestScriptResultDetail(options.innerResults, "artifactRetentionSummary");
	const artifacts = collectUniqueArtifacts(options.innerResults);
	const artifactVerification = collectScriptArtifactVerification(options.innerResults);
	const nextActions = options.cleanupError && options.sessionName ? [buildScriptCloseNextAction(options.sessionName)] : undefined;
	let scriptSession: ScriptSessionDetails | undefined;
	if (options.sessionName) {
		scriptSession = {
			cleanup: options.cleanupError ? "failed" : "closed",
			closeCommandArgs: createAgentBrowserScriptCloseArgs(options.sessionName),
			launchAttempted: true,
			sessionName: options.sessionName,
		};
		if (options.cleanupError) scriptSession.error = redactSensitiveText(options.cleanupError);
	}
	return {
		content: [{ type: "text", text: `${summary}${dataText}${cleanupActionText}` }],
		details: {
			artifactManifest,
			artifactRetentionSummary,
			artifacts,
			artifactVerification,
			data,
			failureCategory,
			nextActions,
			resultCategory: failed ? "failure" : "success",
			scriptRun: {
				aborted: options.run.aborted,
				callCount: options.run.callCount,
				emitCount: options.run.emitCount,
				failedCallCount,
				preDispatchRejectedCallCount: options.run.rejectedCallCount,
				successfulCallCount,
				timedOut: options.run.timedOut,
			},
			scriptSession,
			scriptSteps: steps,
			successCategory: failed ? undefined : "completed",
			summary,
		},
		isError: failed,
	};
}
