import { hasRuntimeType, isRecord, type RuntimeRecord, type RuntimeValue } from "../../../parsing.ts";
import { buildAgentBrowserResultCategoryDetails } from "../../../results/categories.ts";
import { redactSensitiveText, type CompatibilityWorkaround } from "../../../runtime.ts";
import { buildSessionDetailFields, runSessionCommandData } from "../session-state.ts";

import type { AgentBrowserToolResult } from "../types.ts";

type SessionCommandData = Awaited<ReturnType<typeof runSessionCommandData>>;

interface FilteredNetworkRequestsData {
	data: RuntimeRecord<RuntimeValue>;
	matchedRows: number;
	rows: RuntimeValue[];
	totalRows: number;
}

interface NetworkRequestsPageFilterRequest {
	cleanArgs: string[];
	mode: "origin" | "url";
}

function parseNetworkRequestsPageFilterRequest(commandTokens: string[]): NetworkRequestsPageFilterRequest | undefined {
	if (commandTokens[0] !== "network" || commandTokens[1] !== "requests") return undefined;
	const cleanArgs: string[] = [];
	let mode: NetworkRequestsPageFilterRequest["mode"] | undefined;
	for (const token of commandTokens) {
		if (token === "--current-page" || token === "--current-origin") {
			mode = "origin";
			continue;
		}
		if (token === "--current-url") {
			mode = "url";
			continue;
		}
		cleanArgs.push(token);
	}
	if (!mode) return undefined;
	return { cleanArgs, mode };
}

function extractCurrentUrl(data: SessionCommandData): string | undefined {
	if (hasRuntimeType(data, "string")) return data;
	if (!isRecord(data)) return undefined;
	const candidates = [data.url, data.currentUrl, data.href, data.result];
	for (const candidate of candidates) if (hasRuntimeType(candidate, "string") && candidate.length > 0) return candidate;
	return undefined;
}

function getRequestUrl(row: RuntimeValue): string | undefined {
	if (!isRecord(row)) return undefined;
	const candidate = row.url ?? row.requestUrl ?? row.href;
	return hasRuntimeType(candidate, "string") ? candidate : undefined;
}

function requestMatchesCurrentPage(row: RuntimeValue, currentUrl: string, mode: NetworkRequestsPageFilterRequest["mode"]): boolean {
	const requestUrl = getRequestUrl(row);
	if (!requestUrl) return false;
	try {
		const current = new URL(currentUrl);
		const request = new URL(requestUrl, current);
		if (mode === "origin") return current.origin === request.origin;
		const currentComparable = `${current.origin}${current.pathname}`;
		const requestComparable = `${request.origin}${request.pathname}`;
		return requestComparable === currentComparable;
	} catch {
		return mode === "url" ? requestUrl === currentUrl : requestUrl.startsWith(currentUrl);
	}
}

function filterNetworkRequestsData(data: SessionCommandData, currentUrl: string, request: NetworkRequestsPageFilterRequest): FilteredNetworkRequestsData | undefined {
	if (!isRecord(data)) return undefined;
	const requestRows = Array.isArray(data.requests) ? data.requests : Array.isArray(data.items) ? data.items : Array.isArray(data.entries) ? data.entries : undefined;
	if (!requestRows) return undefined;
	const rows = requestRows.filter((row) => requestMatchesCurrentPage(row, currentUrl, request.mode));
	const key = Array.isArray(data.requests) ? "requests" : Array.isArray(data.items) ? "items" : "entries";
	return { data: { ...data, [key]: rows }, matchedRows: rows.length, rows, totalRows: requestRows.length };
}

function formatNetworkRequestRow(row: RuntimeValue): string {
	if (!isRecord(row)) return redactSensitiveText(String(row));
	const status = row.status ?? row.statusCode ?? row.responseStatus ?? "?";
	const method = hasRuntimeType(row.method, "string") ? row.method : hasRuntimeType(row.requestMethod, "string") ? row.requestMethod : "?";
	const id = hasRuntimeType(row.id, "string") ? ` id=${row.id}` : hasRuntimeType(row.requestId, "string") ? ` id=${row.requestId}` : "";
	const url = getRequestUrl(row) ?? "(no url)";
	return redactSensitiveText(`- ${String(status)} ${method}${id} ${url}`);
}

export async function tryNetworkRequestsPageFilter(options: {
	commandTokens: string[];
	compatibilityWorkaround?: CompatibilityWorkaround;
	cwd: string;
	effectiveArgs: string[];
	managedSessionRestoreDisabled: () => boolean;
	redactedArgs: string[];
	sessionMode: "auto" | "fresh";
	namespace?: string;
	sessionName?: string;
	signal?: AbortSignal;
	usedImplicitSession: boolean;
}): Promise<AgentBrowserToolResult | undefined> {
	const request = parseNetworkRequestsPageFilterRequest(options.commandTokens);
	if (!request || !options.sessionName) return undefined;
	const currentUrl = extractCurrentUrl(await runSessionCommandData({ args: ["get", "url"], cwd: options.cwd, namespace: options.namespace, sessionName: options.sessionName, signal: options.signal }));
	if (!currentUrl) return undefined;
	const networkData = await runSessionCommandData({ args: request.cleanArgs, cwd: options.cwd, namespace: options.namespace, sessionName: options.sessionName, signal: options.signal });
	const filtered = filterNetworkRequestsData(networkData, currentUrl, request);
	if (!filtered) return undefined;
	const summary = `Network requests filtered to current ${request.mode === "origin" ? "origin" : "URL"}: ${filtered.matchedRows}/${filtered.totalRows} rows matched.`;
	const preview = filtered.rows.slice(0, 12).map(formatNetworkRequestRow);
	const omitted = filtered.rows.length > preview.length ? [`- …${filtered.rows.length - preview.length} more matching rows omitted`] : [];
	return {
		content: [{ type: "text", text: [redactSensitiveText(summary), `Current page: ${redactSensitiveText(currentUrl)}`, ...preview, ...omitted].join("\n") }],
		details: {
			args: options.redactedArgs,
			command: "network",
			compatibilityWorkaround: options.compatibilityWorkaround,
			data: filtered.data,
			effectiveArgs: options.effectiveArgs,
			networkRequestsPageFilter: { cleanArgs: request.cleanArgs, currentUrl: redactSensitiveText(currentUrl), matchedRows: filtered.matchedRows, mode: request.mode, totalRows: filtered.totalRows },
			sessionMode: options.sessionMode,
			...buildAgentBrowserResultCategoryDetails({ args: options.effectiveArgs, command: "network", succeeded: true }),
			...buildSessionDetailFields(options.sessionName, options.usedImplicitSession, options.namespace, options.managedSessionRestoreDisabled()),
			summary,
		},
		isError: false,
	};
}
