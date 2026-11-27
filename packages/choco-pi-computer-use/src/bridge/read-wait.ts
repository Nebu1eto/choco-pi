import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { assertAppAllowed } from "../app-policy.ts";
import { cdpSnapshotForContext, type CdpPageSnapshot } from "../cdp.ts";
import type { ActParams, ReadTextParams, WaitForParams } from "../contract.ts";
import {
  foldToBudget,
  nodeByRef,
  outlineNodeLabel,
  restoreOutline,
  searchOutline,
  serializeOutline,
  serializeOutlineSearchMatch,
  type Outline,
  type OutlineNode,
} from "../outline.ts";
import { readStoredOutput, UI_TEXT_PAGE_CHARS } from "../output.ts";
import { toFiniteNumber } from "../platform/coerce.ts";
import { currentPlatformBackend } from "../platform/index.ts";
import { currentSessionScope } from "../runtime.ts";
import { changesBetween, renderChanges } from "../view.ts";
import { captureCurrentTarget } from "./observation.ts";
import {
  COMMAND_TIMEOUT_MS,
  isBrowserContextId,
  normalizeText,
  operationState,
  outlineNodeByRef,
  resourceScheduler,
  savedStates,
  sleep,
  trimOrUndefined,
  validateStateId,
  wireRefForNode,
} from "./state-store.ts";
import { ensureTargetWindowId, nativeWindowRequest, resolveCurrentTarget } from "./targets.ts";
import type { ReadTextDetails, ValidatedCondition, WaitForDetails } from "./types.ts";

export function sliceText(
  value: string,
  offsetValue: ReadTextParams["offset"],
  _limitValue?: number,
): Pick<ReadTextDetails, "offset" | "limit" | "totalChars" | "hasMore" | "text"> {
  const offset = Math.max(0, Math.trunc(toFiniteNumber(offsetValue, 0)));
  const limit = UI_TEXT_PAGE_CHARS;
  const characters = Array.from(value);
  const end = Math.min(characters.length, offset + limit);
  return {
    offset,
    limit,
    totalChars: characters.length,
    hasMore: end < characters.length,
    text: offset >= characters.length ? "" : characters.slice(offset, end).join(""),
  };
}

export async function performReadText(
  params: ReadTextParams,
  signal?: AbortSignal,
): Promise<AgentToolResult<ReadTextDetails>> {
  const ref = trimOrUndefined(params.ref);
  if (ref?.startsWith("@o")) {
    const page = readStoredOutput(ref, params.offset, currentSessionScope());
    if (!page)
      throw new Error(
        `Output ref '${ref}' is unavailable or was evicted. Rerun the focused query.`,
      );
    const details: ReadTextDetails = { tool: "read_text", ref, ...page };
    const suffix = page.hasMore
      ? `\n\ncontinue: read_text({ ref: "${ref}", offset: ${page.offset + page.limit} })`
      : page.complete
        ? ""
        : "\n\ncontinuation storage limit reached; rerun a more focused query for the remainder";
    return {
      content: [{ type: "text", text: `${page.text || "(empty output page)"}${suffix}` }],
      details,
    };
  }
  const contextId = operationState().contextId;
  if (isBrowserContextId(contextId)) {
    const snapshot = operationState().browserSnapshot;
    if (!snapshot || snapshot.contextId !== contextId)
      throw new Error(
        `Browser state '${params.stateId}' is unavailable. Observe the browser root again.`,
      );
    if (!ref)
      throw new Error(
        "read_text requires an @e ref for browser contexts; use the outline root ref for whole-page text.",
      );
    const outline = restoreOutline(snapshot.outline);
    const node = nodeByRef(outline, ref);
    if (!node) throw new Error(`Browser text ref '${ref}' is unavailable in this state.`);
    const collect = (current: OutlineNode): string[] =>
      [
        outlineNodeLabel(current),
        ...current.text.map((item) => item.string),
        ...current.children.flatMap(collect),
      ].filter(Boolean);
    const value = node === outline.root ? snapshot.text : [...new Set(collect(node))].join("\n");
    const sliced = sliceText(value, params.offset);
    const details: ReadTextDetails = { tool: "read_text", ref, ...sliced };
    return { content: [{ type: "text", text: sliced.text || "(empty text slice)" }], details };
  }

  validateStateId(params.stateId);
  if (!ref)
    throw new Error(
      "read_text requires ref for desktop contexts. Call observe_ui/inspect_ui and use a text-bearing outline ref.",
    );
  const node = outlineNodeByRef(ref);
  const state = operationState();
  if (state.currentTarget) assertAppAllowed(state.currentTarget);
  if (!state.resourceKey || state.epoch === undefined)
    throw new Error("The observation has no live resource identity. Observe again.");
  const raw = (
    await resourceScheduler.readAt(
      state.resourceKey,
      state.epoch,
      async () =>
        await currentPlatformBackend.readText(
          {
            lookId: state.currentOutline!.lookId,
            elementRef: wireRefForNode(node),
            offset: Math.max(0, Math.trunc(toFiniteNumber(params.offset, 0))),
            limit: UI_TEXT_PAGE_CHARS,
          },
          { signal, timeoutMs: COMMAND_TIMEOUT_MS },
        ),
    )
  ).value;
  const text = raw.text;
  const details: ReadTextDetails = {
    tool: "read_text",
    ref,
    offset: raw.offset,
    limit: raw.limit,
    totalChars: raw.totalChars,
    hasMore: raw.hasMore,
    text,
  };
  return { content: [{ type: "text", text: text || "(empty text slice)" }], details };
}

export function normalizeWaitTimeoutMs(value: WaitForParams["timeoutMs"]): number {
  return Math.max(100, Math.min(60_000, Math.trunc(toFiniteNumber(value, 10_000))));
}

export function conditionScopeRef(
  params: WaitForParams | NonNullable<ActParams["expect"]>,
): string | undefined {
  const ref = trimOrUndefined(params.ref);
  const scopeRef = trimOrUndefined(params.scopeRef);
  if (ref && scopeRef) throw new Error("A UI condition accepts ref or scope_ref, not both.");
  return ref ?? scopeRef;
}

export function validateCondition(
  params: WaitForParams | NonNullable<ActParams["expect"]>,
): ValidatedCondition {
  const text = trimOrUndefined(params.text);
  const role = trimOrUndefined(params.role);
  const value = trimOrUndefined(params.value);
  const scopeRef = conditionScopeRef(params);
  if (!text && !role && !value) throw new Error("A UI condition requires text, role, or value.");
  if (role && !text && !value && !scopeRef)
    throw new Error("A role-only UI condition requires ref or scope_ref.");
  if (value && !params.ref) throw new Error("A value UI condition requires an exact ref.");
  return {
    text,
    role,
    value,
    scopeRef,
    scopeExact: Boolean(params.ref),
    gone: params.until === "absent",
    timeoutMs: normalizeWaitTimeoutMs(params.timeoutMs),
  };
}

export function nodeWithinScope(
  node: OutlineNode,
  scopeRef: string | undefined,
  scopeExact: boolean,
): boolean {
  if (!scopeRef) return true;
  if (scopeExact) return node.ref === scopeRef;
  let current: OutlineNode | undefined = node;
  while (current) {
    if (current.ref === scopeRef) return true;
    current = current.parent;
  }
  return false;
}

export function normalizedRole(value: string): string {
  return value
    .toLowerCase()
    .replace(/^ax/, "")
    .replace(/[ _-]+/g, "");
}

export function platformRole(outline: Outline, role: string | undefined): string | undefined {
  if (!role) return undefined;
  return (
    outline.nodes.find((node) => normalizedRole(node.role) === normalizedRole(role))?.role ?? role
  );
}

export function outlineConditionPresent(
  outline: Outline,
  condition: ReturnType<typeof validateCondition>,
): boolean {
  return searchOutline(outline, condition.text, undefined, undefined, outline.nodes.length).some(
    (match) =>
      (!condition.role || normalizedRole(match.node.role) === normalizedRole(condition.role)) &&
      nodeWithinScope(match.node, condition.scopeRef, condition.scopeExact) &&
      (!condition.value || normalizeText(match.node.value) === normalizeText(condition.value)),
  );
}

export function conditionScopeNode(
  outline: Outline,
  condition: ReturnType<typeof validateCondition>,
): OutlineNode | undefined {
  const scopeNode = condition.scopeRef ? nodeByRef(outline, condition.scopeRef) : undefined;
  if (condition.scopeRef && !scopeNode)
    throw new Error(`Condition scope ref '${condition.scopeRef}' is unavailable in this state.`);
  return scopeNode;
}

export async function performWaitFor(
  params: WaitForParams,
  signal?: AbortSignal,
): Promise<AgentToolResult<WaitForDetails>> {
  const contextId = operationState().contextId;
  const condition = validateCondition(params);
  const { text, role, value, scopeRef, scopeExact, gone, timeoutMs } = condition;

  if (isBrowserContextId(contextId)) {
    const state = operationState();
    if (!state.resourceKey)
      throw new Error("The browser observation has no live resource identity. Observe again.");
    const baseSnapshot = state.browserSnapshot;
    if (!baseSnapshot) throw new Error("Browser wait requires a complete base observation.");
    conditionScopeNode(restoreOutline(baseSnapshot.outline), condition);
    const deadline = Date.now() + timeoutMs;
    let lastSnapshot: CdpPageSnapshot | undefined;
    let lastEpoch = state.epoch ?? resourceScheduler.epoch(state.resourceKey);
    const finish = (found: boolean, timedOut?: boolean): AgentToolResult<WaitForDetails> => {
      if (!lastSnapshot) throw new Error("Browser wait completed without an observation.");
      savedStates.set({
        stateId: lastSnapshot.snapshotId,
        resourceKey: state.resourceKey!,
        epoch: lastEpoch,
        value: { kind: "browser", snapshot: lastSnapshot, outline: lastSnapshot.outline },
      });
      const successorOutline = restoreOutline(lastSnapshot.outline);
      const transition = changesBetween(restoreOutline(baseSnapshot.outline), successorOutline);
      const useDiff = !transition.useFullView;
      const renderedOutline = foldToBudget(successorOutline).text;
      const details: WaitForDetails = {
        tool: "wait_for",
        stateId: lastSnapshot.snapshotId,
        baseStateId: baseSnapshot.snapshotId,
        view: useDiff ? "diff" : "full",
        changes: useDiff ? transition.changes : undefined,
        found,
        gone: (found && gone) || undefined,
        timedOut,
        nodeCount: lastSnapshot.targets.length,
        text,
        role,
        value,
        scopeRef,
        outline: lastSnapshot.outline,
        renderedOutline,
      };
      const message = found
        ? gone
          ? "Condition disappeared."
          : "Condition appeared."
        : `Timed out after ${timeoutMs}ms waiting for condition.`;
      const viewText = useDiff
        ? `${renderChanges(transition.changes) || "(no element changes)"}\nUse state_id ${lastSnapshot.snapshotId} for subsequent actions and queries.`
        : renderedOutline;
      return { content: [{ type: "text", text: `${message}\n${viewText}` }], details };
    };
    do {
      const scheduled = await resourceScheduler.read(
        state.resourceKey,
        async () => await cdpSnapshotForContext(contextId),
      );
      lastSnapshot = scheduled.value;
      lastEpoch = scheduled.epoch;
      if (!lastSnapshot)
        throw new Error(
          `Browser root '${contextId}' is no longer available. Call find_roots and observe_ui again.`,
        );
      const present = outlineConditionPresent(restoreOutline(lastSnapshot.outline), condition);
      if (present !== gone) return finish(true);
      await sleep(200, signal);
    } while (Date.now() < deadline);
    return finish(false, true);
  }

  const state = operationState();
  const baseView = { stateId: state.currentCapture!.stateId, outline: state.currentOutline! };
  let target = await resolveCurrentTarget(signal);
  target = await ensureTargetWindowId(target, signal);
  const scopeNode = conditionScopeNode(state.currentOutline!, condition);
  const raw = await currentPlatformBackend.waitFor(
    {
      ...nativeWindowRequest(target),
      lookId: state.currentOutline!.lookId,
      text,
      role: platformRole(state.currentOutline!, role),
      value,
      scopeRef: scopeNode ? wireRefForNode(scopeNode) : undefined,
      scopeExact,
      gone,
      timeoutMs,
    },
    { signal, timeoutMs: timeoutMs + 2_000 },
  );
  if (!state.resourceKey || state.epoch === undefined)
    throw new Error("The observation has no live resource identity. Observe again.");
  const refreshed = (
    await resourceScheduler.readAt(
      state.resourceKey,
      state.epoch,
      async () => await captureCurrentTarget(signal, "auto"),
    )
  ).value;
  const transition = changesBetween(baseView.outline, refreshed.outline);
  const useDiff = !transition.useFullView;
  const matches = searchOutline(refreshed.outline, text, role, undefined, 1);
  const foundTarget = matches[0];
  const details: WaitForDetails = {
    tool: "wait_for",
    stateId: refreshed.capture.stateId,
    baseStateId: baseView.stateId,
    view: useDiff ? "diff" : "full",
    changes: useDiff ? transition.changes : undefined,
    found: raw.found,
    gone: raw.gone || undefined,
    timedOut: raw.timedOut || undefined,
    target: foundTarget ? serializeOutlineSearchMatch(foundTarget) : undefined,
    nodeCount: Number.isFinite(raw.nodeCount)
      ? Number(raw.nodeCount)
      : refreshed.outline.nodes.length,
    text,
    role,
    value,
    scopeRef,
    outline: serializeOutline(refreshed.outline),
    renderedOutline: foldToBudget(refreshed.outline).text,
  };
  const message = details.found
    ? details.gone
      ? "Condition disappeared."
      : "Condition appeared."
    : `Timed out after ${timeoutMs}ms waiting for condition.`;
  const viewText = useDiff
    ? `${renderChanges(transition.changes) || "(no element changes)"}\nUse state_id ${refreshed.capture.stateId} for subsequent actions and queries.`
    : details.renderedOutline;
  return { content: [{ type: "text", text: `${message}\n${viewText}` }], details };
}
