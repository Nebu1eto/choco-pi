import { getComputerUseConfig } from "../../config.ts";
import { isJsonObject, isNumber, type JsonField, type JsonValue } from "../../json.ts";
import { parseLookResponse, type LookResponse } from "../../outline.ts";
import { toBoolean, toFiniteNumber, toOptionalString } from "../coerce.ts";
import type { ComputerUsePlatformBackend, FramePoints, HelperActResult, PlatformActRequest, PlatformApp, PlatformFocusWindowResult, PlatformFrontmostResult, PlatformObserveRequest, PlatformReadTextRequest, PlatformReadTextResponse, PlatformRoot, PlatformRootKind, PlatformRootQuery, PlatformTarget, PlatformWaitForRequest, PlatformWaitForResponse } from "../types.ts";
import { macosHelper } from "./helper.ts";

interface ListRootsArgs {
	pid?: number;
	title?: string;
}

interface FrontmostResponse {
	pid?: number;
	appName?: string;
	bundleId?: string;
	windowTitle?: string;
	windowId?: number;
}

function isPlatformRootKind(value: JsonField): value is PlatformRootKind {
	return value === "window" || value === "menu" || value === "sheet" || value === "popover" || value === "dialog";
}

function parseApps(result: JsonValue): PlatformApp[] {
	const array = Array.isArray(result) ? result : isJsonObject(result) ? result.apps : undefined;
	if (!Array.isArray(array)) return [];

	return array
		.map((value): PlatformApp | undefined => {
			const raw = isJsonObject(value) ? value : {};
			const pid = Math.trunc(toFiniteNumber(raw.pid, NaN));
			if (!Number.isFinite(pid) || pid <= 0) return undefined;
			return {
				appName: toOptionalString(raw.appName) ?? "Unknown App",
				bundleId: toOptionalString(raw.bundleId),
				pid,
				isFrontmost: toBoolean(raw.isFrontmost),
			};
		})
		.filter((item): item is PlatformApp => Boolean(item));
}

function parseFramePoints(raw: JsonField): FramePoints {
	const record = isJsonObject(raw) ? raw : {};
	const frame = isJsonObject(record.framePoints) ? record.framePoints : {};
	return {
		x: toFiniteNumber(frame.x, 0),
		y: toFiniteNumber(frame.y, 0),
		w: Math.max(1, toFiniteNumber(frame.w, 1)),
		h: Math.max(1, toFiniteNumber(frame.h, 1)),
	};
}

function parseRoots(result: JsonValue): PlatformRoot[] {
	const array = Array.isArray(result) ? result : isJsonObject(result) ? result.roots : undefined;
	if (!Array.isArray(array)) return [];

	return array.map((value): PlatformRoot => {
		const raw = isJsonObject(value) ? value : {};
		return {
			kind: isPlatformRootKind(raw.kind) ? raw.kind : "window",
			rootRef: toOptionalString(raw.rootRef ?? raw.windowRef),
			windowRef: toOptionalString(raw.windowRef ?? raw.rootRef),
			windowId: isNumber(raw.windowId) && Number.isFinite(raw.windowId) ? Math.trunc(raw.windowId) : undefined,
			pid: isNumber(raw.pid) && Number.isFinite(raw.pid) ? Math.trunc(raw.pid) : undefined,
			appName: toOptionalString(raw.appName),
			bundleId: toOptionalString(raw.bundleId),
			title: toOptionalString(raw.title) ?? "",
			role: toOptionalString(raw.role),
			subrole: toOptionalString(raw.subrole),
			framePoints: parseFramePoints(raw),
			scaleFactor: Math.max(1, toFiniteNumber(raw.scaleFactor, 1)),
			zOrder: Math.trunc(toFiniteNumber(raw.zOrder, 0)),
			isMinimized: toBoolean(raw.isMinimized),
			isOnscreen: toBoolean(raw.isOnscreen),
			isMain: toBoolean(raw.isMain),
			isFocused: toBoolean(raw.isFocused),
			isModal: toBoolean(raw.isModal),
			metadata: isJsonObject(raw.metadata) ? raw.metadata : {},
		};
	});
}

function helperAction(request: PlatformActRequest) {
	if (!("focus" in request.target)) return { ...request };
	return { ...request, target: request.target.focus, params: { ...request.params, preserveFocus: true } };
}

export const macosBackend: Pick<ComputerUsePlatformBackend, "listApps" | "listRoots" | "getFrontmost" | "focusWindow" | "observe" | "act" | "actBatch" | "readText" | "waitFor"> = {
	async listApps(signal?: AbortSignal): Promise<PlatformApp[]> {
		return parseApps(await macosHelper.command("listApps", {}, { signal }));
	},

	async listRoots(query: PlatformRootQuery, signal?: AbortSignal): Promise<PlatformRoot[]> {
		const args: ListRootsArgs = {};
		if (Number.isFinite(query.pid)) args.pid = Math.trunc(query.pid!);
		if (query.title?.trim()) args.title = query.title.trim();
		return parseRoots(await macosHelper.command("listRoots", args, { signal }));
	},

	async getFrontmost(signal?: AbortSignal): Promise<PlatformFrontmostResult> {
		const result = await macosHelper.command<FrontmostResponse>("getFrontmost", {}, { signal });
		const pid = Math.trunc(toFiniteNumber(result.pid, NaN));
		if (!Number.isFinite(pid) || pid <= 0) {
			throw new Error("No frontmost app was available for screenshot targeting.");
		}
		return {
			appName: toOptionalString(result.appName) ?? "Unknown App",
			bundleId: toOptionalString(result.bundleId),
			pid,
			windowTitle: toOptionalString(result.windowTitle),
			windowId: Number.isFinite(result.windowId) ? Math.trunc(result.windowId!) : undefined,
		};
	},

	async focusWindow(target: PlatformTarget, signal?: AbortSignal): Promise<PlatformFocusWindowResult> {
		return await macosHelper.command<PlatformFocusWindowResult>("focusWindow", { ...target }, { signal });
	},

	async observe(request: PlatformObserveRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<LookResponse> {
		return parseLookResponse(await macosHelper.command("look", {
			baseLookId: request.baseLookId,
			windowId: request.target.windowId,
			windowRef: request.target.rootRef,
			maxDimension: request.maxDimension,
			readText: request.readText,
			scopeRef: request.scopeRef,
			includeImage: request.includeImage,
		}, options));
	},

	async act(request: PlatformActRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<HelperActResult> {
		return await macosHelper.command<HelperActResult>("act", { ...helperAction(request), cursorOverlay: getComputerUseConfig().cursor_overlay }, options);
	},

	async actBatch(requests: PlatformActRequest[], options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<HelperActResult> {
		const cursorOverlay = getComputerUseConfig().cursor_overlay;
		return await macosHelper.command<HelperActResult>("actBatch", { actions: requests.map((request) => ({ ...helperAction(request), cursorOverlay })) }, options);
	},

	async readText(args: PlatformReadTextRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<PlatformReadTextResponse> {
		return await macosHelper.command<PlatformReadTextResponse>("axReadText", { ...args }, options);
	},

	async waitFor(args: PlatformWaitForRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<PlatformWaitForResponse> {
		return await macosHelper.command<PlatformWaitForResponse>("axWaitFor", { ...args }, options);
	},
};
