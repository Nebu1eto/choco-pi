import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { cdpSnapshotForContext, cdpTabForWindow } from "../cdp.ts";
import type {
  ExpandUiParams,
  ImageMode,
  InspectUiParams,
  ObserveParams,
  ObserveTargetParams,
  SearchUiParams,
} from "../contract.ts";
import { isJsonObject, isNumber, isString } from "../json.ts";
import { noteFromLook, noteRegionKeyForRef, renderNote } from "../note.ts";
import {
  foldToBudget,
  graftScopedOutline,
  nodeByRef,
  outlineNodePath,
  searchOutlineRanked,
  serializeOutline,
  serializeOutlineNodeShallow,
  serializeOutlineSearchMatch,
  type LookResponse,
  type Outline,
  type OutlineNode,
  type OutlineSearchMatch,
} from "../outline.ts";
import { toFiniteNumber } from "../platform/coerce.ts";
import { currentPlatformBackend } from "../platform/index.ts";
import type { CurrentCapture, CurrentTarget } from "../state.ts";
import { changesBetween, renderChanges, stabilizeRefs } from "../view.ts";
import { browserObservationResult } from "./browser-session.ts";
import { rootDeltaLines } from "./helper-act.ts";
import {
  AUTO_IMAGE_MAX_DIMENSION,
  BROWSER_CONTEXT_PREFIX,
  EXPLICIT_IMAGE_MAX_DIMENSION,
  LOOK_TIMEOUT_MS,
  currentOutlineOrThrow,
  desktopResourceKey,
  detailsConfig,
  emptyActivation,
  executionTrace,
  formatOutlineNodeLabel,
  imageFallbackReason,
  isBrowserContextId,
  operationState,
  persistOperation,
  resourceScheduler,
  runtimeState,
  trimOrUndefined,
  wireRefForNode,
} from "./state-store.ts";
import {
  ensureTargetWindowId,
  matchesObserveSelection,
  nativeWindowRequest,
  normalizeWindowSelector,
  resolveCurrentTarget,
  resolveTargetByWindowSelector,
  resolveTargetForObserve,
  sameRootIdentity,
  setCurrentTarget,
} from "./targets.ts";
import type {
  BrowserObservationDetails,
  CaptureResult,
  ComputerUseDetails,
  ExecutionTrace,
  NoteWindowInput,
  OutlineToolDetails,
  ResolvedTarget,
} from "./types.ts";

export function captureForLook(look: LookResponse): CurrentCapture {
  return {
    stateId: randomUUID(),
    width: look.image?.width ?? 0,
    height: look.image?.height ?? 0,
    scaleFactor: look.window.scaleFactor,
    timestamp: Date.now(),
  };
}

export async function performLook(
  target: ResolvedTarget,
  options: {
    readText: "auto" | "always" | "never";
    baseLookId?: string;
    scopeRef?: string;
    maxDimension?: number;
    includeImage?: boolean;
  },
  signal?: AbortSignal,
): Promise<LookResponse> {
  if ((!Number.isFinite(target.windowId) || target.windowId <= 0) && !target.nativeWindowRef)
    throw new Error(
      `Current platform requires a stable root id to observe '${target.windowTitle}'. Call find_roots and select a root with a stable id.`,
    );
  return await currentPlatformBackend.observe(
    {
      target: nativeWindowRequest(target),
      baseLookId: options.baseLookId,
      readText: options.readText,
      scopeRef: options.scopeRef,
      maxDimension: options.maxDimension,
      includeImage: options.includeImage,
    },
    { signal, timeoutMs: LOOK_TIMEOUT_MS },
  );
}

export function noteWindowForTarget(
  target: ResolvedTarget | CurrentTarget,
  look?: LookResponse,
): NoteWindowInput {
  const rawPairing = look?.window.metadata?.pairing;
  const pairing = isJsonObject(rawPairing) ? rawPairing : undefined;
  const confidence = pairing?.confidence;
  return {
    windowRef: target.windowRef,
    title: target.windowTitle,
    pairing:
      confidence === "exact" || confidence === "high" || confidence === "low"
        ? confidence
        : undefined,
    pairingScore: isNumber(pairing?.score) ? pairing.score : undefined,
  };
}

export async function captureCurrentTarget(
  signal?: AbortSignal,
  readText: "auto" | "always" | "never" = "auto",
  maxDimension = AUTO_IMAGE_MAX_DIMENSION,
  targetOverride?: ResolvedTarget,
  includeImage = true,
): Promise<CaptureResult> {
  const state = operationState();
  const baseOutline = state.currentOutline;
  const baseTarget = state.currentTarget;
  let target = targetOverride ?? (await resolveCurrentTarget(signal));
  target = await ensureTargetWindowId(target, signal);
  const look = await performLook(target, { maxDimension, readText, includeImage }, signal);
  const outline = stabilizeRefs(
    baseTarget && sameRootIdentity(baseTarget, target) ? baseOutline : undefined,
    look.parsedOutline!,
  );
  look.parsedOutline = outline;
  look.outline = outline.root;
  const capture = captureForLook(look);

  setCurrentTarget(target);
  state.currentCapture = capture;
  state.currentStateTarget = {
    pid: target.pid,
    windowId: target.windowId,
    windowRef: target.windowRef,
  };
  state.currentLook = look;
  state.currentOutline = outline;
  state.currentNote = noteFromLook(state.currentNote, outline, noteWindowForTarget(target, look));
  state.resourceKey = desktopResourceKey(target);
  state.epoch ??= resourceScheduler.epoch(state.resourceKey);

  return {
    target,
    capture,
    look,
    outline,
    activation: emptyActivation(),
  };
}

export async function buildToolResult(
  tool: string,
  summary: string,
  result: CaptureResult,
  execution: ExecutionTrace,
  _signal?: AbortSignal,
  imageMode: ImageMode = operationState().currentImageMode ?? "auto",
  base?: { stateId: string; outline: Outline },
): Promise<AgentToolResult<ComputerUseDetails>> {
  const state = operationState();
  const fallbackReason = imageFallbackReason(tool, result, imageMode);
  const transition = base ? changesBetween(base.outline, result.outline) : undefined;
  const useDiff = Boolean(transition && !transition.useFullView);
  const folded = foldToBudget(result.outline);
  const renderedNote = renderNote(state.currentNote);

  const details: ComputerUseDetails = {
    tool,
    target: {
      app: result.target.appName,
      bundleId: result.target.bundleId,
      pid: result.target.pid,
      windowTitle: result.target.windowTitle,
      windowId: result.target.windowId,
      windowRef: result.target.windowRef ?? state.currentTarget?.windowRef,
      nativeWindowRef: result.target.nativeWindowRef ?? state.currentTarget?.nativeWindowRef,
    },
    capture: {
      stateId: result.capture.stateId,
      width: result.capture.width,
      height: result.capture.height,
      scaleFactor: result.capture.scaleFactor,
      timestamp: result.capture.timestamp,
      coordinateSpace: "window-relative-screenshot-pixels",
    },
    lookId: result.look.lookId,
    view: useDiff ? "diff" : "full",
    baseStateId: transition ? base?.stateId : undefined,
    changes: useDiff ? transition?.changes : undefined,
    viewReason: transition?.useFullView ? transition.reason : undefined,
    renderedOutline: folded.text,
    outline: serializeOutline(result.outline),
    note: state.currentNote,
    activation: result.activation,
    execution,
    status: "ok",
    config: detailsConfig(),
    helper: runtimeState.helperDiagnostics,
    imageReason: fallbackReason?.reason,
  };

  // Console piggyback: when a CDP connection is active for this browser
  // window, surface console output collected since the last tool result.
  let consoleText = "";
  if (currentPlatformBackend.isChromeFamilyApp(result.target.appName, result.target.bundleId)) {
    const tab = await cdpTabForWindow(result.target.windowTitle, result.target.framePoints);
    const entries = tab?.drainConsole() ?? [];
    if (entries.length > 0) {
      details.console = entries;
      consoleText = `\n\nBrowser console since the last action:\n${entries.map((entry) => `[${entry.level}] ${entry.text}`).join("\n")}`;
    }
  }

  const noteText = renderedNote ? `\n\n${renderedNote}` : "";
  // The model must echo capture.stateId into follow-up tools. Exposing only the
  // helper-internal lookId here makes a plausible but invalid stateId easy to use.
  const renderedChanges = useDiff ? renderChanges(transition!.changes) : "";
  const outlineText = useDiff
    ? `\n\nChanges (${transition!.changedNodeCount}, ${base!.stateId} → ${result.capture.stateId}):\n${renderedChanges || "(no element changes)"}\nUse state_id ${result.capture.stateId} for subsequent actions and queries.`
    : `\n\nOutline (${folded.nodeCount} nodes, state_id ${result.capture.stateId}${transition?.reason ? `, full view: ${transition.reason}` : ""}${folded.truncated ? ", folded output truncated" : ""}):\n${folded.text}`;
  const fallbackText = fallbackReason ? `\n\n${fallbackReason.message}` : "";
  const deltaText = rootDeltaLines(execution).join("\n");
  const content: AgentToolResult<ComputerUseDetails>["content"] = [
    {
      type: "text",
      text: `${summary}${deltaText ? `\n${deltaText}` : ""}${consoleText}${noteText}${outlineText}${fallbackText}`,
    },
  ];
  if (fallbackReason && result.look.image?.jpegBase64) {
    content.push({
      type: "image",
      data: result.look.image.jpegBase64,
      mimeType: result.look.image.mimeType ?? "image/jpeg",
    });
  }

  return { content, details };
}

export function normalizeImageMode(value: ImageMode): ImageMode {
  return value === "always" || value === "never" ? value : "auto";
}

/** Side effects: captures/updates current target, capture state, look, and parsed outline. */
export async function performObserve(
  params: ObserveParams,
  signal?: AbortSignal,
): Promise<AgentToolResult<ComputerUseDetails | BrowserObservationDetails>> {
  const requestedRoot = isString(params.root) ? params.root : undefined;
  if (requestedRoot && !/^@r\d+$/.test(requestedRoot))
    throw new Error("observe_ui.root must be an exact @r ref issued by find_roots.");
  const browserContextId = requestedRoot
    ? runtimeState.browserContextByRoot.get(requestedRoot)
    : undefined;
  if (isBrowserContextId(browserContextId)) {
    const targetId = browserContextId.slice(BROWSER_CONTEXT_PREFIX.length);
    const resourceKey = `cdp:${targetId}`;
    const scheduled = await resourceScheduler.read(
      resourceKey,
      async () => await cdpSnapshotForContext(browserContextId),
    );
    const browser = scheduled.value;
    if (!browser)
      throw new Error(
        `Browser context '${browserContextId}' is no longer available. Call find_roots again.`,
      );
    return browserObservationResult(browser, resourceKey, scheduled.epoch, "observe_ui");
  }
  const state = operationState();
  const mode = params.mode ?? "fused";
  const image = mode === "semantic" ? "never" : mode === "visual" ? "always" : "auto";
  const defaultReadText = mode === "semantic" ? "never" : mode === "visual" ? "always" : "auto";
  const readText = params.readText ?? defaultReadText;
  state.currentImageMode = normalizeImageMode(image);
  const selection: ObserveTargetParams = { root: normalizeWindowSelector(params.root) };
  const requestedTarget = selection.root
    ? await resolveTargetByWindowSelector(params.root!, signal)
    : await resolveTargetForObserve(signal);
  const imageMode = normalizeImageMode(image);
  const resourceKey = desktopResourceKey(requestedTarget);
  const scheduled = await resourceScheduler.read(resourceKey, async (epoch) => {
    state.resourceKey = resourceKey;
    state.epoch = epoch;
    return await captureCurrentTarget(
      signal,
      readText,
      imageMode === "always" ? EXPLICIT_IMAGE_MAX_DIMENSION : AUTO_IMAGE_MAX_DIMENSION,
      requestedTarget,
      imageMode !== "never",
    );
  });
  const captureResult = scheduled.value;
  // Model @r refs are re-minted on re-resolution, so ref string equality
  // alone false-positives as drift for the same root; compare stable
  // identity against the resolved request too.
  if (
    !matchesObserveSelection(captureResult.target, selection) &&
    !sameRootIdentity(captureResult.target, requestedTarget)
  ) {
    throw new Error(
      `Observation target drifted from the requested selection. Requested ${requestedTarget.appName} — ${requestedTarget.windowTitle}, captured ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Call observe_ui again or specify a more exact window title.`,
    );
  }
  const summary = `Observed ${mode} ${captureResult.target.windowRef ? `${captureResult.target.windowRef} ` : ""}${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest outline state.`;
  return await buildToolResult(
    "observe_ui",
    summary,
    captureResult,
    executionTrace("look", "stealth"),
    signal,
    imageMode,
  );
}

export function matchIsNonActionableStatic(match: OutlineSearchMatch): boolean {
  const node = match.node;
  return (
    !node.canPress &&
    !node.canFocus &&
    !node.canSetValue &&
    node.actions.length === 0 &&
    !node.pictureOnly
  );
}

export function shouldEscalateSearchOCR(matches: OutlineSearchMatch[], _text?: string): boolean {
  return matches.every(matchIsNonActionableStatic);
}

/** Pure outline query unless a window selector is supplied, in which case current target selection may change. */
export async function performSearchUi(
  params: SearchUiParams,
  signal?: AbortSignal,
): Promise<AgentToolResult<OutlineToolDetails>> {
  const state = operationState();
  let outline = currentOutlineOrThrow(params.stateId);
  const text = trimOrUndefined(params.text);
  const role = trimOrUndefined(params.role);
  const capability = trimOrUndefined(params.capability);
  if (!text && !role && !capability)
    throw new Error(
      "search_ui requires text, role, or capability. Use observe_ui for a bounded overview.",
    );
  const limit = 12;
  let ranked = searchOutlineRanked(outline, text, role, capability, limit);
  let matches = ranked.matches;
  let escalatedOCR = false;
  const look = state.currentLook;
  if (
    shouldEscalateSearchOCR(matches, text) &&
    look &&
    look.readText?.requested !== "never" &&
    !look.readText?.executed &&
    state.lastSearchOcrEscalatedLookId !== look.lookId
  ) {
    state.lastSearchOcrEscalatedLookId = look.lookId;
    const currentTarget = await ensureTargetWindowId(await resolveCurrentTarget(signal), signal);
    // captureCurrentTarget adopts the new look/outline/capture into
    // runtimeState, so refs in these matches stay actable. Keep the image
    // payload: OCR-only matches are clicked by coordinate, and coordinate
    // acts require the current look to be image-bearing.
    if (!state.resourceKey || state.epoch === undefined)
      throw new Error("The observation has no live resource identity. Observe again.");
    const captureResult = (
      await resourceScheduler.readAt(
        state.resourceKey,
        state.epoch,
        async () =>
          await captureCurrentTarget(signal, "always", AUTO_IMAGE_MAX_DIMENSION, currentTarget),
      )
    ).value;
    outline = captureResult.outline;
    ranked = searchOutlineRanked(outline, text, role, capability, limit);
    matches = ranked.matches;
    escalatedOCR = true;
  }
  const detailMatches = matches.map(serializeOutlineSearchMatch);
  const details: OutlineToolDetails = {
    tool: "search_ui",
    stateId: state.currentCapture?.stateId,
    lookId: outline.lookId,
    matches: detailMatches,
    totalMatches: ranked.totalMatches,
    returned: matches.length,
    hasMore: ranked.totalMatches > matches.length,
    note: state.currentNote,
  };
  const lines = matches.map(
    (match) =>
      `${match.ref} ${match.role || "Unknown"} ${JSON.stringify(match.label || "(unlabeled)")} [${match.matchReason}${match.matchReason === "fuzzy" ? ` ${match.score?.toFixed(2)}` : ""}]\n  path: ${match.path}`,
  );
  const noteHeader = renderNote(state.currentNote);
  const noteText = noteHeader ? `${noteHeader}\n\n` : "";
  const escalationText = escalatedOCR
    ? " OCR text was escalated for this search after the cached outline had no matches."
    : "";
  const moreText =
    ranked.totalMatches > matches.length
      ? ` Refine the query to inspect ${ranked.totalMatches - matches.length} additional matches.`
      : "";
  return {
    content: [
      {
        type: "text",
        text: `${noteText}Found ${ranked.totalMatches} outline match${ranked.totalMatches === 1 ? "" : "es"}; returned ${matches.length}.${moreText}${escalationText}\n${lines.join("\n")}`,
      },
    ],
    details,
  };
}

/** Reads cached outline; truncated refs trigger a scoped look. */
export async function performExpandUi(
  params: ExpandUiParams,
  signal?: AbortSignal,
): Promise<AgentToolResult<OutlineToolDetails>> {
  const state = operationState();
  const outline = currentOutlineOrThrow(params.stateId);
  const ref = trimOrUndefined(params.ref);
  if (!ref) throw new Error("expand_ui.ref is required.");
  const initialTarget = nodeByRef(outline, ref);
  if (!initialTarget)
    throw new Error(`Outline ref '${ref}' is not available in the current outline.`);
  let target: OutlineNode = initialTarget;
  const depth = Math.max(1, Math.min(8, Math.trunc(toFiniteNumber(params.depth, 3))));
  const regionKey = noteRegionKeyForRef(outline, ref);
  const regionChanged = Boolean(
    regionKey &&
    state.currentNote?.regions.some(
      (region) => region.key === regionKey && region.status === "changed",
    ),
  );
  if (target.truncated || regionChanged) {
    const currentTarget = await ensureTargetWindowId(await resolveCurrentTarget(signal), signal);
    const targetWireRef = wireRefForNode(target);
    if (!state.resourceKey || state.epoch === undefined)
      throw new Error("The observation has no live resource identity. Observe again.");
    const scoped = (
      await resourceScheduler.readAt(
        state.resourceKey,
        state.epoch,
        async () =>
          await performLook(
            currentTarget,
            {
              readText: "auto",
              baseLookId: outline.lookId,
              scopeRef: targetWireRef,
              maxDimension: 1,
              includeImage: false,
            },
            signal,
          ),
      )
    ).value;
    target = graftScopedOutline(outline, target.ref, scoped.parsedOutline!);
    outline.lookId = scoped.lookId;
    state.currentOutline = outline;
    state.currentLook = {
      ...scoped,
      image: state.currentLook?.image,
      outline: outline.root,
      parsedOutline: outline,
    };
    persistOperation(state);
  }
  const folded = foldToBudget(outline, { maxDepth: depth, maxNodes: 150 }, [target.ref]);
  const details: OutlineToolDetails = {
    tool: "expand_ui",
    stateId: state.currentCapture?.stateId,
    lookId: outline.lookId,
    target: serializeOutlineNodeShallow(target),
    renderedOutline: folded.text,
    note: state.currentNote,
  };
  return {
    content: [
      {
        type: "text",
        text: `${formatOutlineNodeLabel(target)}\npath: ${outlineNodePath(target)}\n\n${folded.text}`,
      },
    ],
    details,
  };
}

/** Pure cached-outline inspection. */
export async function performInspectUi(
  params: InspectUiParams,
): Promise<AgentToolResult<OutlineToolDetails>> {
  const state = operationState();
  const outline = currentOutlineOrThrow(params.stateId);
  const ref = trimOrUndefined(params.ref);
  if (!ref) throw new Error("inspect_ui.ref is required.");
  const target = nodeByRef(outline, ref);
  if (!target) throw new Error(`Outline ref '${ref}' is not available in the current outline.`);
  const details: OutlineToolDetails = {
    tool: "inspect_ui",
    stateId: state.currentCapture?.stateId,
    lookId: outline.lookId,
    target: serializeOutlineNodeShallow(target),
    note: state.currentNote,
  };
  const fields = [
    formatOutlineNodeLabel(target),
    `path: ${outlineNodePath(target)}`,
    `rect: ${JSON.stringify(target.rect)}`,
    `actions: ${target.actions.join(",") || "none"}`,
    `capabilities: ${
      [
        target.canPress ? "press" : undefined,
        target.canFocus ? "focus" : undefined,
        target.canSetValue ? "set_value" : undefined,
        target.canScroll ? "scroll" : undefined,
        target.canIncrement ? "increment" : undefined,
        target.canDecrement ? "decrement" : undefined,
        target.isTextInput ? "text_input" : undefined,
      ]
        .filter(Boolean)
        .join(",") || "none"
    }`,
    `annotations: ${
      [
        target.offscreen ? "offscreen" : undefined,
        target.pictureOnly ? "picture_only" : undefined,
        target.truncated ? "truncated" : undefined,
        target.scrollExtent
          ? `scrollable ${target.scrollExtent.seen}/${target.scrollExtent.total}`
          : undefined,
      ]
        .filter(Boolean)
        .join(",") || "none"
    }`,
  ];
  return { content: [{ type: "text", text: fields.join("\n") }], details };
}
