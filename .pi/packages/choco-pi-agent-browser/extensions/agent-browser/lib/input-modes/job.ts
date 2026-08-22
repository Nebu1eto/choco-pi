import type { ArtifactVerificationSummary } from "../results/contracts.ts";
import { summarizeNetworkFailures } from "../results/network.ts";
import {
	type CompilationResult,
	type InputRecord,
	getBatchResultItems,
	getCommandNameFromBatchItem,
	getSelectValues,
	isBoolean,
	isInputRecord,
	isNonEmptyString,
	isNumber,
	isOneOf,
	isString,
	isStringArray,
	parseStringArray,
} from "./shared.ts";
import { compileAgentBrowserSemanticAction } from "./semantic-action.ts";
import {
	AGENT_BROWSER_JOB_STEP_ACTIONS,
	AGENT_BROWSER_JOB_TYPE_DELAYED_TEXT_MAX_CHARACTERS,
	AGENT_BROWSER_QA_LOAD_STATES,
	type AgentBrowserJobStepAction,
	type AgentBrowserQaPresetAnalysis,
	type CompiledAgentBrowserJob,
	type CompiledAgentBrowserJobStep,
	type CompiledAgentBrowserQaPreset,
	type CompiledAgentBrowserSemanticAction,
} from "./types.ts";

type RequiredJobStringResult =
	| { error: string }
	| { value: string };

type CompileJobStepResult =
	| { error: string }
	| { args: string[]; extraSteps?: CompiledAgentBrowserJobStep[]; generatedFrom?: string };

type CompileJobTypeResult =
	| { error: string }
	| { steps: CompiledAgentBrowserJobStep[] };

function getRequiredJobString(step: InputRecord, field: "path" | "selector" | "text" | "url", action: AgentBrowserJobStepAction): RequiredJobStringResult {
	const value = step[field];
	if (!isNonEmptyString(value)) {
		return { error: `job step ${action} requires a non-empty ${field} string.` };
	}
	return { value };
}

function compileJobClickOrFillStep(step: InputRecord, action: "click" | "fill"): CompileJobStepResult {
	const selector = isNonEmptyString(step.selector) ? step.selector : undefined;
	const hasSelector = selector !== undefined;
	const hasLocator = step.locator !== undefined || step.role !== undefined || step.name !== undefined || step.value !== undefined;
	if (hasSelector && hasLocator) {
		return { error: `job step ${action} must use either selector or semantic locator fields, not both.` };
	}
	if (hasSelector) {
		if (action === "click") return { args: ["click", selector] };
		const text = getRequiredJobString(step, "text", action);
		if ("error" in text) return { error: text.error };
		return { args: ["fill", selector, text.value] };
	}
	if (!hasLocator) {
		return { error: `job step ${action} requires either a non-empty selector string or semantic locator fields.` };
	}
	const compiled = compileAgentBrowserSemanticAction({
		action,
		locator: step.locator,
		name: step.name,
		role: step.role,
		text: step.text,
		value: step.value,
	});
	if (compiled.error) return { error: compiled.error.replaceAll("semanticAction", `job step ${action}`) };
	// SAFETY: compileAgentBrowserSemanticAction returns a compiled action whenever it does not return an error.
	const compiledAction = compiled.compiled as CompiledAgentBrowserSemanticAction;
	return { args: compiledAction.args };
}

function getUnsupportedJobStepField(step: InputRecord, allowedFields: ReadonlySet<string>): string | undefined {
	return Object.keys(step).find((field) => !allowedFields.has(field));
}

function getUnsupportedJobStepFieldError(step: InputRecord, action: AgentBrowserJobStepAction, allowedFields: ReadonlySet<string>): string | undefined {
	const unsupportedField = getUnsupportedJobStepField(step, allowedFields);
	if (!unsupportedField) return undefined;
	const supportedFields = [...allowedFields].filter((field) => field !== "action");
	const supportedText = supportedFields.length > 0 ? `supported fields are ${supportedFields.join(", ")}.` : "no additional fields are supported.";
	return `job step ${action} does not support ${unsupportedField}; ${supportedText}`;
}

const JOB_STEP_ALLOWED_FIELDS = {
	assertText: new Set(["action", "text"]),
	assertUrl: new Set(["action", "url"]),
	click: new Set(["action", "locator", "name", "role", "selector", "value"]),
	fill: new Set(["action", "locator", "name", "role", "selector", "text", "value"]),
	open: new Set(["action", "loadState", "url"]),
	screenshot: new Set(["action", "path"]),
	select: new Set(["action", "selector", "value", "values"]),
	snapshot: new Set(["action"]),
	type: new Set(["action", "delayMs", "press", "selector", "text"]),
	wait: new Set(["action", "milliseconds"]),
	waitForDownload: new Set(["action", "path"]),
} satisfies Record<AgentBrowserJobStepAction, ReadonlySet<string>>;

type JobStepCompiler = (step: InputRecord, index: number) => CompileJobStepResult;

function compileJobTypeSteps(step: InputRecord): CompileJobTypeResult {
	const text = getRequiredJobString(step, "text", "type");
	if ("error" in text) return { error: text.error };
	const selector = step.selector;
	if (selector !== undefined && !isNonEmptyString(selector)) {
		return { error: "job step type selector must be a non-empty string when provided." };
	}
	const delayMs = step.delayMs;
	if (delayMs !== undefined && (!isNumber(delayMs) || !Number.isInteger(delayMs) || delayMs <= 0)) {
		return { error: "job step type delayMs must be a positive integer when provided." };
	}
	const press = step.press;
	if (press !== undefined && !isNonEmptyString(press)) {
		return { error: "job step type press must be a non-empty key string when provided." };
	}
	const typedText = text.value;
	const typedChars = Array.from(typedText);
	if (typedChars.length === 0) return { error: "job step type requires non-empty text." };
	if (delayMs !== undefined && typedChars.length > AGENT_BROWSER_JOB_TYPE_DELAYED_TEXT_MAX_CHARACTERS) {
		return { error: `job step type delayMs supports at most ${AGENT_BROWSER_JOB_TYPE_DELAYED_TEXT_MAX_CHARACTERS} characters; split longer text into shorter calls or omit delayMs.` };
	}
	const compiledSteps: CompiledAgentBrowserJobStep[] = [];
	if (delayMs === undefined) {
		compiledSteps.push({ action: "type", args: isString(selector) ? ["type", selector, typedText] : ["keyboard", "type", typedText] });
	} else {
		if (isString(selector)) compiledSteps.push({ action: "type", args: ["focus", selector], generatedFrom: "type.selector" });
		for (const [index, char] of typedChars.entries()) {
			compiledSteps.push({ action: "type", args: ["keyboard", "type", char], generatedFrom: "type.delayMs" });
			if (index < typedChars.length - 1) compiledSteps.push({ action: "wait", args: ["wait", String(delayMs)], generatedFrom: "type.delayMs" });
		}
	}
	if (isString(press)) compiledSteps.push({ action: "type", args: ["press", press], generatedFrom: "type.press" });
	return { steps: compiledSteps };
}

function compileOpenJobStep(step: InputRecord, index: number): CompileJobStepResult {
	const result = getRequiredJobString(step, "url", "open");
	if ("error" in result) return { error: result.error };
	const extraSteps: CompiledAgentBrowserJobStep[] = [];
	if (step.loadState !== undefined) {
		if (!isOneOf(step.loadState, AGENT_BROWSER_QA_LOAD_STATES)) {
			return { error: `job.steps[${index}].loadState must be one of: ${AGENT_BROWSER_QA_LOAD_STATES.join(", ")}.` };
		}
		extraSteps.push({ action: "wait", args: ["wait", "--load", step.loadState], generatedFrom: "open.loadState" });
	}
	return { args: ["open", result.value], extraSteps };
}

function compileClickJobStep(step: InputRecord): CompileJobStepResult {
	return compileJobClickOrFillStep(step, "click");
}

function compileFillJobStep(step: InputRecord): CompileJobStepResult {
	return compileJobClickOrFillStep(step, "fill");
}

function compileTypeJobStep(step: InputRecord): CompileJobStepResult {
	const result = compileJobTypeSteps(step);
	if ("error" in result) return { error: result.error };
	const [firstStep, ...extraSteps] = result.steps;
	if (!firstStep) return { error: "job step type produced no executable steps." };
	return { args: firstStep.args, extraSteps, generatedFrom: firstStep.generatedFrom };
}

function compileSelectJobStep(step: InputRecord, index: number): CompileJobStepResult {
	const selector = getRequiredJobString(step, "selector", "select");
	if ("error" in selector) return { error: selector.error };
	const values = getSelectValues(step, `job.steps[${index}]`);
	if ("error" in values) return { error: values.error };
	return { args: ["select", selector.value, ...values.values] };
}

function compileWaitJobStep(step: InputRecord): CompileJobStepResult {
	const milliseconds = step.milliseconds;
	if (!isNumber(milliseconds) || !Number.isInteger(milliseconds) || milliseconds <= 0) {
		return { error: "job step wait requires a positive integer milliseconds value." };
	}
	return { args: ["wait", String(milliseconds)] };
}

function compileAssertTextJobStep(step: InputRecord): CompileJobStepResult {
	const result = getRequiredJobString(step, "text", "assertText");
	if ("error" in result) return { error: result.error };
	return { args: ["wait", "--text", result.value] };
}

function compileAssertUrlJobStep(step: InputRecord): CompileJobStepResult {
	const result = getRequiredJobString(step, "url", "assertUrl");
	if ("error" in result) return { error: result.error };
	return { args: ["wait", "--url", result.value] };
}

function compilePathArtifactJobStep(step: InputRecord, action: "screenshot" | "waitForDownload"): CompileJobStepResult {
	const result = getRequiredJobString(step, "path", action);
	if ("error" in result) return { error: result.error };
	return { args: action === "waitForDownload" ? ["wait", "--download", result.value] : ["screenshot", result.value] };
}

// ponytail: allowedFields for each action live in JOB_STEP_ALLOWED_FIELDS (same key
// alignment enforced by Record<AgentBrowserJobStepAction, …>), so the compiler map no
// longer mirrors that set per entry; the call site looks it up by action.
const JOB_STEP_COMPILERS = {
	assertText: compileAssertTextJobStep,
	assertUrl: compileAssertUrlJobStep,
	click: compileClickJobStep,
	fill: compileFillJobStep,
	open: compileOpenJobStep,
	screenshot: (step) => compilePathArtifactJobStep(step, "screenshot"),
	select: compileSelectJobStep,
	snapshot: () => ({ args: ["snapshot", "-i"] }),
	type: compileTypeJobStep,
	wait: compileWaitJobStep,
	waitForDownload: (step) => compilePathArtifactJobStep(step, "waitForDownload"),
} satisfies Record<AgentBrowserJobStepAction, JobStepCompiler>;

export function compileAgentBrowserJob<Input>(input: Input): CompilationResult<CompiledAgentBrowserJob> {
	if (!isInputRecord(input)) {
		return { error: "job must be an object." };
	}
	const rawFailFast = input.failFast;
	if (rawFailFast !== undefined && !isBoolean(rawFailFast)) {
		return { error: "job.failFast must be a boolean when provided." };
	}
	const failFast = rawFailFast !== false;
	const rawSteps = input.steps;
	if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
		return { error: "job.steps must be a non-empty array." };
	}
	const steps: CompiledAgentBrowserJobStep[] = [];
	for (const [index, rawStep] of rawSteps.entries()) {
		if (!isInputRecord(rawStep)) {
			return { error: `job.steps[${index}] must be an object.` };
		}
		const action = rawStep.action;
		if (!isOneOf(action, AGENT_BROWSER_JOB_STEP_ACTIONS)) {
			return { error: `job.steps[${index}].action must be one of: ${AGENT_BROWSER_JOB_STEP_ACTIONS.join(", ")}.` };
		}
		const jobAction: AgentBrowserJobStepAction = action;
		const compile: JobStepCompiler = JOB_STEP_COMPILERS[jobAction];
		const unsupportedFieldError = getUnsupportedJobStepFieldError(rawStep, jobAction, JOB_STEP_ALLOWED_FIELDS[jobAction]);
		if (unsupportedFieldError) return { error: `job.steps[${index}]: ${unsupportedFieldError}` };
		const compiledStep: CompileJobStepResult = compile(rawStep, index);
		if ("error" in compiledStep) return { error: compiledStep.error.startsWith(`job.steps[${index}]`) ? compiledStep.error : `job.steps[${index}]: ${compiledStep.error}` };
		steps.push({ action: jobAction, args: compiledStep.args, generatedFrom: compiledStep.generatedFrom }, ...(compiledStep.extraSteps ?? []));
	}
	return { compiled: { args: failFast ? ["batch", "--bail"] : ["batch"], failFast, stdin: JSON.stringify(steps.map((step) => step.args)), steps } };
}

export function isHttpOrHttpsUrl(url: string): boolean {
	try {
		const protocol = new URL(url).protocol;
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

function describeQaChecksRun(checks: CompiledAgentBrowserQaPreset["checks"]): string {
	const parts = [`load:${checks.loadState}`];
	if (checks.expectedText.length > 0) parts.push(`text×${checks.expectedText.length}`);
	if (checks.expectedSelector) parts.push("selector");
	if (checks.checkNetwork) parts.push("network");
	if (checks.checkConsole) parts.push("console");
	if (checks.checkErrors) parts.push("errors");
	if (checks.diagnosticsResetAtStart) parts.push("diagnostics-reset");
	else if (checks.checkNetwork || checks.checkConsole || checks.checkErrors) parts.push("attached-diagnostics-preserved");
	if (checks.screenshotPath) parts.push("screenshot");
	return parts.join(", ");
}

export interface QaPageContext {
	title?: string;
	url?: string;
}

export function extractQaPageContext(options: {
	attachedTarget?: QaPageContext;
	batchData?: unknown;
	compiled?: CompiledAgentBrowserQaPreset;
}): QaPageContext {
	if (options.attachedTarget?.title || options.attachedTarget?.url) {
		return { title: options.attachedTarget.title, url: options.attachedTarget.url };
	}
	for (const item of getBatchResultItems(options.batchData)) {
		if (getCommandNameFromBatchItem(item) !== "open" || !isInputRecord(item.result)) continue;
		const url = isString(item.result.url) ? item.result.url : undefined;
		const title = isString(item.result.title) ? item.result.title : undefined;
		if (url || title) return { title, url };
	}
	if (options.compiled?.checks.url) {
		return { url: options.compiled.checks.url };
	}
	return {};
}

export function buildQaCompactPassText(options: {
	artifactVerification?: ArtifactVerificationSummary;
	batchStepCount: number;
	checks: CompiledAgentBrowserQaPreset["checks"];
	page?: { title?: string; url?: string };
	qaPreset: AgentBrowserQaPresetAnalysis;
}): string {
	const lines = [options.qaPreset.summary];
	const pageParts = [options.page?.title, options.page?.url].filter((part): part is string => isString(part) && part.length > 0);
	if (pageParts.length > 0) lines.push(`Page: ${pageParts.join(" — ")}`);
	lines.push(`Checks run: ${describeQaChecksRun(options.checks)} (${options.batchStepCount} batch step${options.batchStepCount === 1 ? "" : "s"})`);
	if (options.checks.diagnosticsResetAtStart && (options.checks.checkNetwork || options.checks.checkConsole || options.checks.checkErrors)) {
		lines.push("Diagnostic isolation: URL QA clears enabled network/console buffers, then snapshots any page-error residue before opening the target. Only unchanged residue is ignored because upstream page-error clear is not reliable.");
	}
	if (options.checks.attached && !options.checks.diagnosticsResetAtStart && (options.checks.checkNetwork || options.checks.checkConsole || options.checks.checkErrors)) {
		lines.push("Attached diagnostics: existing upstream session console/network/error buffers were preserved; rows may include events from before qa.attached started.");
	}
	if (options.checks.screenshotPath) {
		const verification = options.artifactVerification;
		lines.push(verification
			? `Screenshot: ${options.checks.screenshotPath} (${verification.verifiedCount}/${verification.artifacts.length} verified on disk)`
			: `Screenshot: ${options.checks.screenshotPath}`);
	}
	lines.push("Full diagnostic matrix: see details.qaPreset and details.batchSteps.");
	return lines.join("\n");
}

export function buildQaCompactFailureText(options: {
	batchStepCount: number;
	checks: CompiledAgentBrowserQaPreset["checks"];
	page?: { title?: string; url?: string };
	qaPreset: AgentBrowserQaPresetAnalysis;
}): string {
	const lines = [options.qaPreset.summary];
	const pageParts = [options.page?.title, options.page?.url].filter((part): part is string => isString(part) && part.length > 0);
	if (pageParts.length > 0) lines.push(`Page: ${pageParts.join(" — ")}`);
	if (options.qaPreset.failedChecks.length > 0) lines.push("Failed checks:", ...options.qaPreset.failedChecks.map((failure) => `- ${failure}`));
	if (options.qaPreset.warnings.length > 0) lines.push("Warnings:", ...options.qaPreset.warnings.map((warning) => `- ${warning}`));
	lines.push(`Checks run: ${describeQaChecksRun(options.checks)} (${options.batchStepCount} batch step${options.batchStepCount === 1 ? "" : "s"})`);
	lines.push("Full diagnostic matrix: see details.qaPreset and details.batchSteps.");
	return lines.join("\n");
}

const QA_VISIBLE_TEXT_TIMEOUT_MS = 5_000;

function formatQaExpectedTextPreview(text: string): string {
	return JSON.stringify(text.length > 80 ? `${text.slice(0, 77)}...` : text);
}

function buildQaVisibleTextPredicate(text: string): string {
	return `(() => {
  const expected = ${JSON.stringify(text)}.replace(/\\s+/g, " ").trim();
  if (!expected) return false;
  const root = document.body || document.documentElement;
  if (!root) return false;
  const skipTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG"]);
  const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
  const isVisibleElement = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    if (skipTags.has(element.tagName)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    return element.getClientRects().length > 0;
  };
  const hasVisibleAncestors = (node) => {
    for (let element = node.parentElement; element; element = element.parentElement) {
      if (!isVisibleElement(element)) return false;
      if (element === root) break;
    }
    return true;
  };
  const textWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let visitedText = 0;
  for (let node = textWalker.nextNode(); node && visitedText < 6000; node = textWalker.nextNode(), visitedText += 1) {
    if (!hasVisibleAncestors(node)) continue;
    if (normalize(node.nodeValue).includes(expected)) return true;
  }
  const elementWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let visitedElements = 0;
  for (let node = elementWalker.nextNode(); node && visitedElements < 3000; node = elementWalker.nextNode(), visitedElements += 1) {
    const element = node;
    if (!isVisibleElement(element) || !("value" in element)) continue;
    if (normalize(element.value).includes(expected)) return true;
  }
  return false;
})()`;
}

function qaVisibleTextWaitPassed(item: ReturnType<typeof getBatchResultItems>[number] | undefined, step: CompiledAgentBrowserJobStep): boolean | undefined {
	if (step.args[0] !== "wait" || step.args[1] !== "--fn") return undefined;
	if (!item || item.success === false) return false;
	if (isBoolean(item.result)) return item.result;
	if (isInputRecord(item.result) && isBoolean(item.result.result)) return item.result.result;
	return true;
}

function extractQaTextAssertionResultText(item: ReturnType<typeof getBatchResultItems>[number] | undefined): string | undefined {
	if (!item || item.success === false) return undefined;
	const result = item.result;
	if (isString(result)) return result;
	if (!isInputRecord(result)) return undefined;
	for (const key of ["result", "text", "value"] as const) {
		const value = result[key];
		if (isString(value)) return value;
	}
	return undefined;
}

function qaErrorSignature<ErrorValue>(error: ErrorValue): string {
	if (isString(error)) return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

interface QaBaselineComparison<ErrorValue> {
	ignoredCount: number;
	novelErrors: ErrorValue[];
}

function subtractQaBaselineErrors<ErrorValue>(errors: ErrorValue[], baselineErrors: ErrorValue[]): QaBaselineComparison<ErrorValue> {
	const baselineCounts = new Map<string, number>();
	for (const error of baselineErrors) {
		const signature = qaErrorSignature(error);
		baselineCounts.set(signature, (baselineCounts.get(signature) ?? 0) + 1);
	}
	let ignoredCount = 0;
	const novelErrors = errors.filter((error) => {
		const signature = qaErrorSignature(error);
		const count = baselineCounts.get(signature) ?? 0;
		if (count === 0) return true;
		baselineCounts.set(signature, count - 1);
		ignoredCount += 1;
		return false;
	});
	return { ignoredCount, novelErrors };
}

function isDiagnosticResetCommand(item: InputRecord): boolean {
	const command = item.command;
	if (!isStringArray(command)) return false;
	const [name, subcommand] = command;
	return command.includes("--clear") && (name === "console" || name === "errors" || (name === "network" && subcommand === "requests"));
}

export function analyzeQaPresetTimeout(compiled: CompiledAgentBrowserQaPreset): AgentBrowserQaPresetAnalysis | undefined {
	if (compiled.checks.expectedText.length === 0) return undefined;
	const failedChecks = compiled.checks.expectedText.map((text) => `expected text was not verified before timeout: ${formatQaExpectedTextPreview(text)}`);
	return {
		failedChecks,
		passed: false,
		summary: `QA preset failed: ${failedChecks.join("; ")}.`,
		warnings: ["The wrapper timed out before expected-text evidence could be verified; inspect timeoutPartialProgress and retry with a narrower readiness condition if the page was still loading."],
	};
}

export function analyzeQaPresetResults<Data>(data: Data, compiled?: CompiledAgentBrowserQaPreset): AgentBrowserQaPresetAnalysis | undefined {
	const items = getBatchResultItems(data);
	if (items.length === 0) return undefined;
	const failedChecks: string[] = [];
	const warnings: string[] = [];
	const baselineErrorIndex = compiled?.checks.diagnosticsResetAtStart && compiled.checks.checkErrors
		? compiled.steps.findIndex((step) => step.generatedFrom === "qa.errorBaselineAfterClear")
		: -1;
	const baselineErrorItem = baselineErrorIndex >= 0 ? items[baselineErrorIndex] : undefined;
	const baselineErrorResult = isInputRecord(baselineErrorItem?.result) ? baselineErrorItem.result : undefined;
	const baselineErrors = Array.isArray(baselineErrorResult?.errors) ? baselineErrorResult.errors : [];
	for (const [index, item] of items.entries()) {
		if (item.success === false) {
			failedChecks.push(`${getCommandNameFromBatchItem(item) ?? "step"} failed`);
		}
		if (index === baselineErrorIndex) continue;
		const result = isInputRecord(item.result) ? item.result : undefined;
		const commandName = getCommandNameFromBatchItem(item);
		if (compiled?.checks.diagnosticsResetAtStart && isDiagnosticResetCommand(item)) {
			continue;
		}
		if (commandName === "errors" && Array.isArray(result?.errors) && result.errors.length > 0) {
			const { ignoredCount, novelErrors } = subtractQaBaselineErrors(result.errors, baselineErrors);
			if (novelErrors.length > 0) failedChecks.push(`${novelErrors.length} page error(s)`);
			if (ignoredCount > 0) warnings.push(`${ignoredCount} post-clear page error residue row(s) ignored as unchanged`);
		}
		if (commandName === "console" && Array.isArray(result?.messages)) {
			const errorCount = result.messages.filter((message) => isInputRecord(message) && /error/i.test(String(message.type ?? message.level ?? ""))).length;
			if (errorCount > 0) failedChecks.push(`${errorCount} console error message(s)`);
		}
		if (commandName === "network" && Array.isArray(result?.requests)) {
			const networkFailures = summarizeNetworkFailures(result.requests);
			if (networkFailures.actionableCount > 0) failedChecks.push(`${networkFailures.actionableCount} actionable failed network request(s)`);
			if (networkFailures.benignCount > 0) warnings.push(`${networkFailures.benignCount} benign network request failure(s) ignored`);
		}
	}
	if (compiled?.checks.expectedText.length) {
		let expectedTextIndex = 0;
		compiled.steps.forEach((step, index) => {
			if (step.action !== "assertText") return;
			const expected = compiled.checks.expectedText[expectedTextIndex++];
			if (!expected) return;
			const visibleTextPassed = qaVisibleTextWaitPassed(items[index], step);
			if (visibleTextPassed === true) return;
			const actual = extractQaTextAssertionResultText(items[index]);
			if (!actual || !actual.includes(expected)) failedChecks.push(`expected text not found: ${formatQaExpectedTextPreview(expected)}`);
		});
	}
	const uniqueFailures = [...new Set(failedChecks)];
	const uniqueWarnings = [...new Set(warnings)];
	return {
		failedChecks: uniqueFailures,
		passed: uniqueFailures.length === 0,
		summary: uniqueFailures.length === 0
			? uniqueWarnings.length === 0 ? "QA preset passed." : `QA preset passed with warnings: ${uniqueWarnings.join("; ")}.`
			: `QA preset failed: ${uniqueFailures.join("; ")}.`,
		warnings: uniqueWarnings,
	};
}

export function compileAgentBrowserQaPreset<Input>(input: Input): CompilationResult<CompiledAgentBrowserQaPreset> {
	if (!isInputRecord(input)) {
		return { error: "qa must be an object." };
	}
	const attached = input.attached === true;
	if (input.attached !== undefined && !isBoolean(input.attached)) {
		return { error: "qa.attached must be a boolean when provided." };
	}
	const url = input.url;
	if (attached && url !== undefined) {
		return { error: "qa.url must be omitted when qa.attached is true." };
	}
	if (!attached && !isNonEmptyString(url)) {
		return { error: "qa.url must be a non-empty string." };
	}
	const normalizedUrl = isString(url) ? url.trim() : undefined;
	const expectedTextInput = input.expectedText === undefined
		? []
		: isString(input.expectedText)
			? [input.expectedText]
			: input.expectedText;
	const expectedText = parseStringArray(expectedTextInput);
	if (!expectedText) {
		return { error: "qa.expectedText must be a non-empty string or array of non-empty strings when provided." };
	}
	if (expectedText.some((text) => text.trim().length === 0)) {
		return { error: "qa.expectedText must be a non-empty string or array of non-empty strings when provided." };
	}
	const expectedSelector = input.expectedSelector;
	if (expectedSelector !== undefined && !isNonEmptyString(expectedSelector)) {
		return { error: "qa.expectedSelector must be a non-empty string when provided." };
	}
	const screenshotPath = input.screenshotPath;
	if (screenshotPath !== undefined && !isNonEmptyString(screenshotPath)) {
		return { error: "qa.screenshotPath must be a non-empty string when provided." };
	}
	for (const field of ["checkConsole", "checkErrors", "checkNetwork"] as const) {
		if (input[field] !== undefined && !isBoolean(input[field])) {
			return { error: `qa.${field} must be a boolean when provided.` };
		}
	}
	const rawLoadState = input.loadState;
	if (rawLoadState !== undefined && !isOneOf(rawLoadState, AGENT_BROWSER_QA_LOAD_STATES)) {
		return { error: `qa.loadState must be one of: ${AGENT_BROWSER_QA_LOAD_STATES.join(", ")}.` };
	}
	const checkConsole = isBoolean(input.checkConsole) ? input.checkConsole : !attached;
	const checkErrors = isBoolean(input.checkErrors) ? input.checkErrors : !attached;
	const checkNetwork = isBoolean(input.checkNetwork) ? input.checkNetwork : !attached;
	const loadState = isOneOf(rawLoadState, AGENT_BROWSER_QA_LOAD_STATES) ? rawLoadState : "domcontentloaded";
	const diagnosticsResetAtStart = !attached;
	const steps: CompiledAgentBrowserJobStep[] = [];
	if (diagnosticsResetAtStart && checkNetwork) steps.push({ action: "wait", args: ["network", "requests", "--clear"] });
	if (diagnosticsResetAtStart && checkConsole) steps.push({ action: "wait", args: ["console", "--clear"] });
	if (diagnosticsResetAtStart && checkErrors) {
		steps.push({ action: "wait", args: ["errors", "--clear"] });
		steps.push({ action: "wait", args: ["errors"], generatedFrom: "qa.errorBaselineAfterClear" });
	}
	if (!attached && normalizedUrl) steps.push({ action: "open", args: ["open", normalizedUrl] });
	steps.push({ action: "wait", args: ["wait", "--load", loadState] });
	if (checkConsole || checkErrors) steps.push({ action: "wait", args: ["wait", "150"], generatedFrom: "qa.diagnosticSettle" });
	for (const text of expectedText) {
		steps.push({ action: "assertText", args: ["wait", "--fn", buildQaVisibleTextPredicate(text), "--timeout", String(QA_VISIBLE_TEXT_TIMEOUT_MS)] });
	}
	if (isString(expectedSelector)) {
		steps.push({ action: "wait", args: ["wait", expectedSelector] });
	}
	if (checkNetwork) steps.push({ action: "wait", args: ["network", "requests"] });
	if (checkConsole) steps.push({ action: "wait", args: ["console"] });
	if (checkErrors) steps.push({ action: "wait", args: ["errors"] });
	if (isString(screenshotPath)) steps.push({ action: "screenshot", args: ["screenshot", screenshotPath] });
	return {
		compiled: {
			args: ["batch", "--bail"],
			checks: { attached, checkConsole, checkErrors, checkNetwork, diagnosticsResetAtStart, expectedSelector, expectedText, loadState, screenshotPath, url: normalizedUrl },
			failFast: true,
			stdin: JSON.stringify(steps.map((step) => step.args)),
			steps,
		},
	};
}
