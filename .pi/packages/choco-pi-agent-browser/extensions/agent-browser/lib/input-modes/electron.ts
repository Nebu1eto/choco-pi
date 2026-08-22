import {
	type CompilationResult,
	type InputRecord,
	type ValueValidationResult,
	isInputRecord,
	isNonEmptyString,
	isNumber,
	isOneOf,
	isStringArray,
} from "./shared.ts";
import {
	AGENT_BROWSER_ELECTRON_ACTIONS,
	AGENT_BROWSER_ELECTRON_HANDOFFS,
	AGENT_BROWSER_ELECTRON_LIST_FIELDS,
	AGENT_BROWSER_ELECTRON_PROBE_FIELDS,
	AGENT_BROWSER_ELECTRON_RESERVED_APP_ARGS,
	AGENT_BROWSER_ELECTRON_TARGET_TYPES,
	type CompiledAgentBrowserElectron,
} from "./types.ts";

function validateOptionalNonEmptyString(input: InputRecord, fieldName: string): ValueValidationResult<string> {
	const value = input[fieldName];
	if (value === undefined) return {};
	if (!isNonEmptyString(value)) {
		return { error: `electron.${fieldName} must be a non-empty string when provided.` };
	}
	return { value: value.trim() };
}

function validateOptionalElectronStringArray(input: InputRecord, fieldName: "allow" | "appArgs" | "deny"): ValueValidationResult<string[]> {
	const value = input[fieldName];
	if (value === undefined) return {};
	if (!isStringArray(value) || value.some((item) => item.trim().length === 0)) {
		return { error: `electron.${fieldName} must be an array of non-empty strings when provided.` };
	}
	return { value: value.map((item) => item.trim()) };
}

function validateOptionalElectronEnum<const Values extends readonly string[]>(
	input: InputRecord,
	fieldName: string,
	values: Values,
): ValueValidationResult<Values[number]> {
	const value = input[fieldName];
	if (value === undefined) return {};
	if (!isOneOf(value, values)) {
		return { error: `electron.${fieldName} must be one of: ${values.join(", ")}.` };
	}
	return { value };
}

function getReservedElectronAppArg(appArgs: string[] | undefined): string | undefined {
	return appArgs?.find((arg) => {
		const trimmed = arg.trim();
		return trimmed === "--" || AGENT_BROWSER_ELECTRON_RESERVED_APP_ARGS.some((reserved) => trimmed === reserved || trimmed.startsWith(`${reserved}=`));
	});
}

function validateElectronLaunchAppArgs(appArgs: string[] | undefined): string | undefined {
	const reservedArg = getReservedElectronAppArg(appArgs);
	return reservedArg
		? `electron.appArgs must not include wrapper-owned launch flag ${reservedArg}.`
		: undefined;
}

function validateOptionalElectronPositiveInteger(input: InputRecord, fieldName: "maxResults" | "timeoutMs"): ValueValidationResult<number> {
	const value = input[fieldName];
	if (value === undefined) return {};
	if (!isNumber(value) || !Number.isInteger(value) || value <= 0) {
		return { error: `electron.${fieldName} must be a positive integer when provided.` };
	}
	return { value };
}

function onlyAllowedElectronFields(input: InputRecord, action: string, allowedFields: ReadonlySet<string>): string | undefined {
	const unsupportedField = Object.keys(input).find((fieldName) => !allowedFields.has(fieldName));
	return unsupportedField ? `electron.${action} does not support electron.${unsupportedField}.` : undefined;
}

export function compileAgentBrowserElectron<Input>(input: Input): CompilationResult<CompiledAgentBrowserElectron> {
	if (!isInputRecord(input)) return { error: "electron must be an object." };
	const action = input.action;
	if (!isOneOf(action, AGENT_BROWSER_ELECTRON_ACTIONS)) {
		return { error: `electron.action must be one of: ${AGENT_BROWSER_ELECTRON_ACTIONS.join(", ")}.` };
	}
	for (const fieldName of ["query", "appPath", "appName", "bundleId", "executablePath", "launchId"] as const) {
		const validation = validateOptionalNonEmptyString(input, fieldName);
		if (validation.error) return { error: validation.error };
	}
	for (const fieldName of ["appArgs", "allow", "deny"] as const) {
		const validation = validateOptionalElectronStringArray(input, fieldName);
		if (validation.error) return { error: validation.error };
	}
	const handoff = validateOptionalElectronEnum(input, "handoff", AGENT_BROWSER_ELECTRON_HANDOFFS);
	if (handoff.error) return { error: handoff.error };
	const targetType = validateOptionalElectronEnum(input, "targetType", AGENT_BROWSER_ELECTRON_TARGET_TYPES);
	if (targetType.error) return { error: targetType.error };
	for (const fieldName of ["maxResults", "timeoutMs"] as const) {
		const validation = validateOptionalElectronPositiveInteger(input, fieldName);
		if (validation.error) return { error: validation.error };
	}
	if (input.all !== undefined && input.all !== true) {
		return { error: "electron.all must be true when provided." };
	}
	if (action === "list") {
		const unsupportedListField = Object.keys(input).find((fieldName) => !AGENT_BROWSER_ELECTRON_LIST_FIELDS.has(fieldName));
		if (unsupportedListField) {
			return { error: `electron.list only supports query and maxResults; remove electron.${unsupportedListField}.` };
		}
		return {
			compiled: {
				action: "list",
				maxResults: validateOptionalElectronPositiveInteger(input, "maxResults").value,
				query: validateOptionalNonEmptyString(input, "query").value,
			},
		};
	}
	if (action === "probe") {
		const unsupportedProbeField = Object.keys(input).find((fieldName) => !AGENT_BROWSER_ELECTRON_PROBE_FIELDS.has(fieldName));
		if (unsupportedProbeField) {
			return { error: `electron.probe only supports action, launchId, and timeoutMs; remove electron.${unsupportedProbeField}.` };
		}
		const launchId = validateOptionalNonEmptyString(input, "launchId").value;
		const timeoutMs = validateOptionalElectronPositiveInteger(input, "timeoutMs").value;
		const compiled: CompiledAgentBrowserElectron = { action: "probe" };
		if (launchId) compiled.launchId = launchId;
		if (timeoutMs) compiled.timeoutMs = timeoutMs;
		return { compiled };
	}
	if (action === "launch") {
		const allowedFields = new Set(["action", "allow", "appArgs", "appName", "appPath", "bundleId", "deny", "executablePath", "handoff", "targetType", "timeoutMs"]);
		const unsupportedFieldError = onlyAllowedElectronFields(input, action, allowedFields);
		if (unsupportedFieldError) return { error: unsupportedFieldError };
		const appArgs = validateOptionalElectronStringArray(input, "appArgs").value;
		const appArgsError = validateElectronLaunchAppArgs(appArgs);
		if (appArgsError) return { error: appArgsError };
		const targetFields = ["appPath", "appName", "bundleId", "executablePath"] as const;
		const providedTargets = targetFields.filter((fieldName) => input[fieldName] !== undefined);
		if (providedTargets.length !== 1) {
			return { error: "electron.launch requires exactly one of appPath, appName, bundleId, or executablePath." };
		}
		return {
			compiled: {
				action: "launch",
				allow: validateOptionalElectronStringArray(input, "allow").value,
				appArgs,
				deny: validateOptionalElectronStringArray(input, "deny").value,
				appName: validateOptionalNonEmptyString(input, "appName").value,
				appPath: validateOptionalNonEmptyString(input, "appPath").value,
				bundleId: validateOptionalNonEmptyString(input, "bundleId").value,
				executablePath: validateOptionalNonEmptyString(input, "executablePath").value,
				handoff: handoff.value ?? "snapshot",
				targetType: targetType.value ?? "page",
				timeoutMs: validateOptionalElectronPositiveInteger(input, "timeoutMs").value,
			},
		};
	}
	const allowedFields = new Set(["action", "all", "launchId", "timeoutMs"]);
	const unsupportedFieldError = onlyAllowedElectronFields(input, action, allowedFields);
	if (unsupportedFieldError) return { error: unsupportedFieldError };
	if (input.all === true && input.launchId !== undefined) {
		return { error: `electron.${action} accepts launchId or all, not both.` };
	}
	return {
		compiled: {
			action,
			all: input.all === true || undefined,
			launchId: validateOptionalNonEmptyString(input, "launchId").value,
			timeoutMs: validateOptionalElectronPositiveInteger(input, "timeoutMs").value,
		},
	};
}
