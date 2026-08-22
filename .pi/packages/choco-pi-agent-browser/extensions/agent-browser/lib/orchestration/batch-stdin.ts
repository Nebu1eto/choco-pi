import { hasRuntimeType } from "../parsing.ts";

export type BatchCommandStep = [string, ...string[]];

type BatchStdinValue = string | number | boolean | null | BatchStdinValue[] | { [key: string]: BatchStdinValue };

interface ParsedBatchCommandArgument {
	error?: string;
	step?: BatchCommandStep;
}

interface ParsedBatchStdin {
	error?: string;
	steps?: BatchStdinValue[];
}

interface ParsedUserBatchStdin {
	error?: string;
	steps?: BatchCommandStep[];
}

function isStringToken(value: BatchStdinValue): value is string {
	return hasRuntimeType(value, "string");
}

const BATCH_STDIN_EXAMPLE = ' Example: { "args": ["batch"], "stdin": "[[\\"get\\",\\"title\\"],[\\"get\\",\\"url\\"]]" }';

// Mirror upstream commands::shell_words_split so policy inspection sees the same argv.
export function parseBatchCommandArgument(command: string): ParsedBatchCommandArgument {
	const tokens: string[] = [];
	let token = "";
	let inDoubleQuote = false;
	let inSingleQuote = false;
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];
		if (character === "\\" && !inSingleQuote) {
			const next = command[index + 1];
			if (next !== undefined) {
				token += next;
				index += 1;
			}
		} else if (character === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
		} else if (character === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
		} else if (character === " " && !inDoubleQuote && !inSingleQuote) {
			if (token !== "") {
				tokens.push(token);
				token = "";
			}
		} else {
			token += character;
		}
	}
	if (token !== "") tokens.push(token);
	if (tokens.length === 0) return { error: "batch command is empty" };
	const [commandToken, ...args] = tokens;
	return { step: [commandToken, ...args] };
}

function validateUserBatchStep(step: BatchStdinValue, index: number): { error: string; ok: false } | { ok: true; step: BatchCommandStep } {
	if (!Array.isArray(step)) {
		return {
			error: `agent_browser batch stdin step ${index} must be a non-empty array of string command tokens.${BATCH_STDIN_EXAMPLE}`,
			ok: false,
		};
	}
	if (step.length === 0) {
		return {
			error: `agent_browser batch stdin step ${index} must not be empty.${BATCH_STDIN_EXAMPLE}`,
			ok: false,
		};
	}
	const invalidTokenIndex = step.findIndex((token) => !isStringToken(token));
	if (invalidTokenIndex !== -1) {
		return {
			error: `agent_browser batch stdin step ${index} token ${invalidTokenIndex} must be a string.${BATCH_STDIN_EXAMPLE}`,
			ok: false,
		};
	}
	const [command, ...args] = step;
	if (!isStringToken(command) || !args.every(isStringToken)) {
		return {
			error: `agent_browser batch stdin step ${index} contains an invalid command token.${BATCH_STDIN_EXAMPLE}`,
			ok: false,
		};
	}
	return { ok: true, step: [command, ...args] };
}

export function parseBatchStdinJsonArray(stdin: string | undefined): ParsedBatchStdin {
	if (stdin === undefined) {
		return { steps: [] };
	}
	try {
		const parsed: BatchStdinValue = JSON.parse(stdin);
		if (!Array.isArray(parsed)) {
			return { error: `agent_browser batch stdin must be a JSON array of command steps.${BATCH_STDIN_EXAMPLE}` };
		}
		return { steps: parsed };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { error: `agent_browser batch stdin could not be parsed as JSON: ${message}.${BATCH_STDIN_EXAMPLE}` };
	}
}

export function parseUserBatchStdin(stdin: string | undefined): ParsedUserBatchStdin {
	const parsed = parseBatchStdinJsonArray(stdin);
	if (parsed.error || parsed.steps === undefined) {
		return parsed.error ? { error: parsed.error } : { steps: [] };
	}
	const steps: BatchCommandStep[] = [];
	for (const [index, rawStep] of parsed.steps.entries()) {
		const validated = validateUserBatchStep(rawStep, index);
		if (!validated.ok) {
			return { error: validated.error };
		}
		steps.push(validated.step);
	}
	return { steps };
}

/**
 * The batch steps upstream will actually execute: run_batch uses raw batch
 * arguments exclusively when any exist and reads stdin only otherwise.
 * Upstream filters only the exact `--bail` token, so an equals form such as
 * `--bail=true` stays a raw command (an unknown-command row) and keeps stdin
 * ignored.
 */
export function getUpstreamEffectiveBatchSteps(commandTokens: readonly string[], stdin: string | undefined): BatchCommandStep[] {
	if (commandTokens[0] !== "batch") return [];
	const argumentSteps = commandTokens.slice(1).flatMap((command) => {
		if (command === "--bail") return [];
		const step = parseBatchCommandArgument(command).step;
		return step ? [step] : [];
	});
	if (argumentSteps.length > 0) return argumentSteps;
	return parseUserBatchStdin(stdin).steps ?? [];
}

export function parseValidBatchStepEntries(stdin: string | undefined): Array<{ index: number; step: BatchCommandStep }> {
	const parsed = parseBatchStdinJsonArray(stdin);
	if (parsed.error || parsed.steps === undefined) return [];
	return parsed.steps.flatMap((step, index) => {
		const validated = validateUserBatchStep(step, index);
		return validated.ok ? [{ index, step: validated.step }] : [];
	});
}
