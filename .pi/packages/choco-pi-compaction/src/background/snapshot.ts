/**
 * Owned frozen-prefix snapshots for background compaction.
 *
 * A snapshot captures the committed branch up to a legal cut `C` so a backend
 * can summarize `A..C` while the session keeps appending `D/E`. Everything here
 * is pure and synchronous: no host object is awaited or retained, and every
 * captured entry is a detached, deeply frozen copy.
 *
 * Cut legality (all on the committed branch, never on stream buffers):
 * - a tool call and its result are never on opposite sides of the cut, which
 *   also keeps every parallel batch and every reasoning-plus-tool bundle whole
 *   (one assistant entry carries the reasoning and all calls of a batch);
 * - a batch still waiting for results at the cut is never summarized;
 * - a context edit appended after the cut never targets a summarized entry;
 * - at least one entry is retained, so the draft's `firstKeptEntryId` is a real
 *   branch entry and never null (the host requires a string retention ID).
 * A complete user-turn boundary is preferred. When keeping the whole current
 * turn would exceed `maxKeepTokens`, the cut lands inside the autonomous turn
 * after a complete tool group and carries the governing user request.
 */
import { createHash } from "node:crypto";

import {
  buildSessionProjection,
  type CompactionEntry,
  estimateTokens,
  findCutPoint,
  findTurnStartIndex,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { parseTextCheckpointDetails } from "../details.ts";
import { BACKGROUND_COMPACTION_SYSTEM_PROMPT, buildFrozenPrefixPrompt } from "../prompt.ts";
import { estimateTextTokens } from "../serialize.ts";
import type { CompactionFileOperations, CompactionMessage, EntryIdRange } from "../types.ts";
import type {
  FailureReason,
  FrozenSnapshot,
  LegalityVerdict,
  PrepareFailure,
  ProviderScope,
  ReasonCode,
} from "./contract.ts";
import { estimatePromptTokens, usageCalibration } from "./token-estimate.ts";

/** Longest governing request kept verbatim in a checkpoint. */
const GOVERNING_REQUEST_MAX_CHARS = 8000;

/** Inputs the owner snapshots before calling {@link freezeSnapshot}. */
export interface FreezeOptions {
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  readonly providerScope: ProviderScope;
  /** Recent context the cut keeps at least, as the host's `keepRecentTokens`. */
  readonly keepRecentTokens: number;
  /**
   * Largest retained suffix accepted to keep a whole user turn instead of
   * splitting it. Defaults to twice `keepRecentTokens`.
   */
  readonly maxKeepTokens?: number;
  /** Capture time supplied by the caller; the function reads no clock. */
  readonly capturedAt: number;
}

/**
 * Frozen snapshot produced here.
 *
 * The neutral contract identifies the last summarized entry (`cutEntryId`) but
 * not the first retained one, which the text draft needs. It is carried as an
 * additive member; {@link readFirstKeptEntryId} validates it on the way back.
 */
export interface PrefixSnapshot extends FrozenSnapshot {
  readonly firstKeptEntryId: string;
  readonly promptTokenEstimate: number;
  readonly estimateSource: "usage-calibrated" | "chars";
  readonly estimateRatio: number;
}

type SnapshotRefusalDetail =
  | "empty-branch"
  | "broken-chain"
  | "duplicate-entry-id"
  | "nothing-to-summarize"
  | "no-legal-cut"
  | "split-turn-without-governing-request";

/** Typed refusal; history is untouched and nothing was captured. */
export interface SnapshotRefusal extends PrepareFailure {
  readonly detail: SnapshotRefusalDetail;
}

export function isSnapshotRefusal(
  result: PrefixSnapshot | SnapshotRefusal,
): result is SnapshotRefusal {
  return "ok" in result;
}

function refuse(reason: FailureReason, detail: SnapshotRefusalDetail): SnapshotRefusal {
  // More committed entries can make a later attempt succeed; a malformed
  // branch or a turn without a governing request cannot heal by waiting.
  const retryable = detail === "nothing-to-summarize" || detail === "no-legal-cut";
  return { ok: false, reason, retryable, detail };
}

/** One model-visible message of the summarized range, tagged with its entry. */
export interface TaggedMessage {
  readonly entryId: string;
  readonly message: CompactionMessage;
}

/** Governing request carried by a split-turn snapshot. */
interface GoverningRequest {
  readonly entryId: string;
  readonly content: string;
}

// ---------------------------------------------------------------------------
// Entry-level helpers
// ---------------------------------------------------------------------------

const NonEmptyStringSchema = Type.String({ minLength: 1 });

function isTurnStartRole(message: CompactionMessage): boolean {
  switch (message.role) {
    case "user":
    case "bashExecution":
    case "custom":
    case "branchSummary":
    case "compactionSummary":
      return true;
    default:
      return false;
  }
}

function summarizable(messages: readonly CompactionMessage[]): CompactionMessage[] {
  return messages.filter((message) => message.role !== "system");
}

function messageText(message: CompactionMessage): string {
  if (message.role !== "user" && message.role !== "custom") {
    return "";
  }
  const content = message.content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block.type === "text" ? block.text : "[image]"))
      .join("\n")
      .trim();
  }
  return content.trim();
}

function chainProblem(entries: readonly SessionEntry[]): SnapshotRefusalDetail | undefined {
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (seen.has(entry.id)) {
      return "duplicate-entry-id";
    }
    seen.add(entry.id);
    if (index > 0 && entry.parentId !== entries[index - 1]?.id) {
      return "broken-chain";
    }
  }
  return undefined;
}

function latestCompactionIndex(entries: readonly SessionEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]?.type === "compaction") {
      return index;
    }
  }
  return -1;
}

function compactionCount(entries: readonly SessionEntry[]): number {
  return entries.filter((entry) => entry.type === "compaction").length;
}

/** First raw index still model-visible after the latest compaction. */
function keptStartIndex(entries: readonly SessionEntry[], compactionIndex: number): number {
  const compaction = entries[compactionIndex];
  if (compaction?.type !== "compaction") {
    return 0;
  }
  const kept = entries.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
  return kept >= 0 && kept < compactionIndex ? kept : compactionIndex + 1;
}

/** Model-visible messages per entry ID, after context edits, for the given leaf. */
function visibleMessages(
  entries: readonly SessionEntry[],
  leafId: string,
): Map<string, CompactionMessage[]> {
  const projection = buildSessionProjection([...entries], leafId);
  const visible = new Map<string, CompactionMessage[]>();
  for (const projected of projection.entries) {
    if (projected.sourceEntry.type === "compaction") {
      continue;
    }
    visible.set(projected.sourceEntry.id, summarizable(projected.messages));
  }
  return visible;
}

/** Stable SHA-256 over every prefix entry's ID and persisted JSON. */
export function fingerprintEntries(entries: readonly SessionEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.id);
    hash.update("\u0000");
    hash.update(JSON.stringify(entry));
    hash.update("\u0001");
  }
  return `sha256:${hash.digest("hex")}`;
}

function deepFreeze<T>(value: T): T {
  if (value instanceof Object && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function addFileOp(
  name: string,
  args: { readonly path?: unknown } | undefined,
  fileOps: CompactionFileOperations,
): void {
  const path = args?.path;
  if (!Value.Check(NonEmptyStringSchema, path)) {
    return;
  }
  if (name === "read") fileOps.read.add(path);
  else if (name === "write") fileOps.written.add(path);
  else if (name === "edit") fileOps.edited.add(path);
}

interface FileOpCall {
  readonly name: string;
  readonly arguments?: { readonly path?: unknown };
}

/** Tool calls that may touch files: nested calls of a result, direct calls of an assistant. */
function fileOpCalls(message: CompactionMessage): readonly FileOpCall[] {
  if (message.role === "toolResult") return message.nestedCalls?.calls ?? [];
  if (message.role !== "assistant") return [];
  return message.content.flatMap((block) => (block.type === "toolCall" ? [block] : []));
}

/** Same extraction rule as the host's private `extractFileOpsFromMessage`. */
function collectFileOps(messages: readonly CompactionMessage[]): CompactionFileOperations {
  const fileOps: CompactionFileOperations = {
    read: new Set<string>(),
    written: new Set<string>(),
    edited: new Set<string>(),
  };
  for (const message of messages) {
    for (const call of fileOpCalls(message)) addFileOp(call.name, call.arguments, fileOps);
  }
  return fileOps;
}

/** Tool-call IDs requested by one assistant message; empty for every other role. */
function toolCallIds(message: CompactionMessage): string[] {
  if (message.role !== "assistant") return [];
  return message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : []));
}

/** What a later entry must not reference once a prefix is summarized. */
interface PrefixReferences {
  readonly entryIds: ReadonlySet<string>;
  readonly toolCallIds: ReadonlySet<string>;
}

export function prefixReferences(prefix: readonly SessionEntry[]): PrefixReferences {
  return {
    entryIds: new Set(prefix.map((entry) => entry.id)),
    toolCallIds: new Set(
      prefix.flatMap((entry) => (entry.type === "message" ? toolCallIds(entry.message) : [])),
    ),
  };
}

/**
 * Whether a later entry edits a summarized entry or carries a late result for a
 * summarized tool call; either would split a group on replay.
 */
export function touchesPrefix(entry: SessionEntry, prefix: PrefixReferences): boolean {
  if (entry.type === "context_edit") return prefix.entryIds.has(entry.targetId);
  return (
    entry.type === "message" &&
    entry.message.role === "toolResult" &&
    prefix.toolCallIds.has(entry.message.toolCallId)
  );
}

function messageTokens(messages: readonly CompactionMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

// ---------------------------------------------------------------------------
// Branch analysis
// ---------------------------------------------------------------------------

interface BranchAnalysis {
  readonly compactionIndex: number;
  readonly keptStart: number;
  readonly visible: Map<string, CompactionMessage[]>;
  /** `blocked[c]` > 0 when a cut after raw index c splits a group or edit. */
  readonly blocked: readonly number[];
}

/** Difference array of blocked cut intervals; `runningTotals` yields `blocked[c]`. */
class BlockedIntervals {
  private readonly diff: number[];

  constructor(positions: number) {
    this.diff = Array.from<number>({ length: positions + 1 }).fill(0);
  }

  block(from: number, to: number): void {
    if (to <= from) return;
    this.diff[from] = (this.diff[from] ?? 0) + 1;
    this.diff[to] = (this.diff[to] ?? 0) - 1;
  }

  runningTotals(positions: number): number[] {
    const totals: number[] = [];
    let running = 0;
    for (let index = 0; index < positions; index++) {
      running += this.diff[index] ?? 0;
      totals.push(running);
    }
    return totals;
  }
}

/** Where each tool call, its last result, and every assistant message sit on the branch. */
interface ToolGroupScan {
  readonly callAt: Map<string, number>;
  readonly lastResultAt: Map<string, number>;
  readonly assistantAt: number[];
}

function recordToolGroupMessage(
  scan: ToolGroupScan,
  index: number,
  message: CompactionMessage,
): void {
  if (message.role === "assistant") {
    if (scan.assistantAt.at(-1) !== index) scan.assistantAt.push(index);
    for (const id of toolCallIds(message)) if (!scan.callAt.has(id)) scan.callAt.set(id, index);
  } else if (message.role === "toolResult" && scan.callAt.has(message.toolCallId)) {
    scan.lastResultAt.set(message.toolCallId, index);
  }
}

/** Scan visible entries, blocking every context edit against its target as it goes. */
function scanToolGroups(
  entries: readonly SessionEntry[],
  keptStart: number,
  visible: Map<string, CompactionMessage[]>,
  intervals: BlockedIntervals,
): ToolGroupScan {
  const scan: ToolGroupScan = { callAt: new Map(), lastResultAt: new Map(), assistantAt: [] };
  const indexById = new Map<string, number>();
  for (let index = keptStart; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) continue;
    indexById.set(entry.id, index);
    if (entry.type === "context_edit") {
      const target = indexById.get(entry.targetId);
      if (target !== undefined) intervals.block(target, index);
      continue;
    }
    for (const message of visible.get(entry.id) ?? []) recordToolGroupMessage(scan, index, message);
  }
  return scan;
}

/** Block each call up to its last result, or up to the next assistant message when it has none. */
function blockToolGroups(scan: ToolGroupScan, intervals: BlockedIntervals, end: number): void {
  for (const [id, callIndex] of scan.callAt) {
    const resultIndex = scan.lastResultAt.get(id);
    const closedBy = scan.assistantAt.find((start) => start > callIndex);
    intervals.block(callIndex, resultIndex ?? closedBy ?? end);
  }
}

/**
 * Intervals [from, to) of raw cut positions that would separate a tool call
 * from its result, or a context edit from its target.
 *
 * A call is blocked up to its last result, wherever that result lands, even
 * past an interleaved user or custom message. A call with no result on the
 * branch is abandoned only once a later assistant message exists (the agent
 * loop moved on and the provider transform synthesizes its result); without
 * one it stays open to the end, so a still-running batch at the leaf is never
 * split, even when a steering or custom message arrived mid-batch.
 */
function analyzeBranch(entries: readonly SessionEntry[]): BranchAnalysis {
  const compactionIndex = latestCompactionIndex(entries);
  const keptStart = keptStartIndex(entries, compactionIndex);
  const leaf = entries.at(-1);
  const visible = leaf ? visibleMessages(entries, leaf.id) : new Map<string, CompactionMessage[]>();
  const intervals = new BlockedIntervals(entries.length);
  const scan = scanToolGroups(entries, keptStart, visible, intervals);
  blockToolGroups(scan, intervals, entries.length);
  return { compactionIndex, keptStart, visible, blocked: intervals.runningTotals(entries.length) };
}

interface CutCandidate {
  /** Raw index of the last summarized entry. */
  readonly cut: number;
  readonly turnBoundary: boolean;
}

function firstVisibleAfter(
  entries: readonly SessionEntry[],
  analysis: BranchAnalysis,
  cut: number,
): CompactionMessage | undefined {
  for (let index = cut + 1; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry || entry.type === "compaction") continue;
    const first = analysis.visible.get(entry.id)?.[0];
    if (first) return first;
  }
  return undefined;
}

function lastVisibleAtOrBefore(
  entries: readonly SessionEntry[],
  analysis: BranchAnalysis,
  cut: number,
): CompactionMessage | undefined {
  for (let index = cut; index >= analysis.keptStart; index--) {
    const entry = entries[index];
    if (!entry || entry.type === "compaction") continue;
    const messages = analysis.visible.get(entry.id) ?? [];
    const last = messages.at(-1);
    if (last) return last;
  }
  return undefined;
}

function isTurnBoundary(
  entries: readonly SessionEntry[],
  analysis: BranchAnalysis,
  cut: number,
): boolean {
  const next = firstVisibleAfter(entries, analysis, cut);
  if (next) {
    return isTurnStartRole(next);
  }
  // Nothing visible is retained yet: the turn is still running unless the
  // prefix ends with an assistant reply that requested no tools.
  const last = lastVisibleAtOrBefore(entries, analysis, cut);
  return last?.role === "assistant" && last.stopReason !== "toolUse";
}

function hasSummarizableContent(
  entries: readonly SessionEntry[],
  analysis: BranchAnalysis,
  cut: number,
): boolean {
  for (let index = analysis.keptStart; index <= cut; index++) {
    const entry = entries[index];
    if (entry && entry.type !== "compaction" && (analysis.visible.get(entry.id)?.length ?? 0) > 0) {
      return true;
    }
  }
  return false;
}

function legalCuts(entries: readonly SessionEntry[], analysis: BranchAnalysis): CutCandidate[] {
  const candidates: CutCandidate[] = [];
  const lowest = Math.max(analysis.compactionIndex, 0);
  for (let cut = lowest; cut <= entries.length - 2; cut++) {
    if ((analysis.blocked[cut] ?? 0) > 0) continue;
    if (!hasSummarizableContent(entries, analysis, cut)) continue;
    candidates.push({ cut, turnBoundary: isTurnBoundary(entries, analysis, cut) });
  }
  return candidates;
}

function retainedTokens(
  entries: readonly SessionEntry[],
  analysis: BranchAnalysis,
  from: number,
): number {
  let total = 0;
  for (let index = from; index < entries.length; index++) {
    const entry = entries[index];
    if (entry) total += messageTokens(analysis.visible.get(entry.id) ?? []);
  }
  return total;
}

/** One legal cut of a branch: summarize through `cutEntryId`, keep from `firstKeptEntryId`. */
interface LegalCut {
  readonly cutEntryId: string;
  readonly firstKeptEntryId: string;
  /** True when the retained range starts a new user turn. */
  readonly turnBoundary: boolean;
}

/**
 * Every legal cut of a branch, oldest first, before any keep-window or
 * turn-preference selection. A malformed branch has none.
 */
export function listLegalCuts(entries: readonly SessionEntry[]): readonly LegalCut[] {
  if (entries.length === 0 || chainProblem(entries)) {
    return [];
  }
  const analysis = analyzeBranch(entries);
  const cuts: LegalCut[] = [];
  for (const candidate of legalCuts(entries, analysis)) {
    const cutEntry = entries[candidate.cut];
    const firstKept = entries[candidate.cut + 1];
    if (cutEntry && firstKept) {
      cuts.push({
        cutEntryId: cutEntry.id,
        firstKeptEntryId: firstKept.id,
        turnBoundary: candidate.turnBoundary,
      });
    }
  }
  return cuts;
}

function governingFromDetails(entry: SessionEntry | undefined): GoverningRequest | null {
  if (entry?.type !== "compaction") return null;
  const parsed = parseTextCheckpointDetails(entry);
  const carried = parsed?.background.governingRequest;
  return carried ? { entryId: carried.entryId, content: carried.content } : null;
}

/**
 * The user request governing the turn that contains `cut`.
 *
 * Inside one turn no user message follows the turn start, so the latest
 * user-role message at or before the cut is that turn's request. When it was
 * already summarized by a checkpoint this package wrote, the checkpoint's
 * carried request is used instead.
 */
function resolveGoverningRequest(
  entries: readonly SessionEntry[],
  analysis: BranchAnalysis,
  cut: number,
): GoverningRequest | null {
  for (let index = cut; index >= analysis.keptStart; index--) {
    const entry = entries[index];
    if (!entry || entry.type === "compaction") continue;
    const messages = analysis.visible.get(entry.id) ?? [];
    for (let position = messages.length - 1; position >= 0; position--) {
      const message = messages[position];
      if (message?.role === "user") {
        return { entryId: entry.id, content: messageText(message) };
      }
    }
  }
  return governingFromDetails(entries[analysis.compactionIndex]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Freeze the committed branch at a legal cut, or refuse with a typed reason.
 *
 * `entries` is the current branch, root first (`sessionManager.getBranch()`).
 */
export function freezeSnapshot(
  entries: readonly SessionEntry[],
  options: FreezeOptions,
): PrefixSnapshot | SnapshotRefusal {
  if (entries.length === 0) {
    return refuse("no-legal-cut", "empty-branch");
  }
  const chain = chainProblem(entries);
  if (chain) {
    return refuse("malformed", chain);
  }
  const analysis = analyzeBranch(entries);
  const searchStart = analysis.compactionIndex + 1;
  const target = findCutPoint(
    [...entries],
    searchStart,
    entries.length,
    options.keepRecentTokens,
  ).firstKeptEntryIndex;
  const legal = legalCuts(entries, analysis);
  if (legal.length === 0) {
    return refuse("no-legal-cut", "no-legal-cut");
  }
  const candidates = legal.filter((candidate) => candidate.cut + 1 <= target);
  const latest = candidates.at(-1);
  if (!latest) {
    return refuse("no-legal-cut", "nothing-to-summarize");
  }

  const maxKeep = options.maxKeepTokens ?? options.keepRecentTokens * 2;
  const boundary = candidates.filter((candidate) => candidate.turnBoundary).at(-1);
  let chosen = latest;
  if (!latest.turnBoundary && boundary) {
    const keepFromBoundary = retainedTokens(entries, analysis, boundary.cut + 1);
    if (keepFromBoundary <= maxKeep) {
      chosen = boundary;
    }
  }

  let governing: GoverningRequest | null = null;
  if (!chosen.turnBoundary) {
    governing = resolveGoverningRequest(entries, analysis, chosen.cut);
    if (!governing && analysis.compactionIndex < 0) {
      if (!boundary) {
        return refuse("no-legal-cut", "split-turn-without-governing-request");
      }
      chosen = boundary;
    }
  }

  const cutEntry = entries[chosen.cut];
  const firstKept = entries[chosen.cut + 1];
  if (!cutEntry || !firstKept) {
    return refuse("no-legal-cut", "no-legal-cut");
  }
  const prefix = deepFreeze(structuredClone(entries.slice(0, chosen.cut + 1)));
  const range = collectRange(prefix, analysis.keptStart, analysis.visible);
  const previous = prefix[analysis.compactionIndex];
  const previousTokens = previous?.type === "compaction" ? estimateTextTokens(previous.summary) : 0;

  const base = {
    cutEntryId: cutEntry.id,
    firstKeptEntryId: firstKept.id,
    prefixFingerprint: fingerprintEntries(prefix),
    priorCheckpointId: previous?.type === "compaction" ? previous.id : null,
    priorCheckpointVersion: previous?.type === "compaction" ? compactionCount(prefix) : null,
    ownerKey: options.ownerKey,
    ownerGeneration: options.ownerGeneration,
    providerScope: deepFreeze(structuredClone(options.providerScope)),
    entries: prefix,
    splitTurn: !chosen.turnBoundary,
    governingUserRequest: chosen.turnBoundary || !governing ? null : deepFreeze({ ...governing }),
    fileOps: collectFileOps(range.map((tagged) => tagged.message)),
    tokenEstimate: messageTokens(range.map((tagged) => tagged.message)) + previousTokens,
    capturedAt: options.capturedAt,
  };
  const prompt = renderFrozenPrefixPrompt(base);
  const estimate = estimatePromptTokens(
    prompt.system.length + prompt.promptText.length,
    usageCalibration({
      entries: prefix,
      range,
      baseChars: previous?.type === "compaction" ? previous.summary.length : 0,
    }),
  );
  const snapshot: PrefixSnapshot = {
    ...base,
    promptTokenEstimate: estimate.tokens,
    estimateSource: estimate.source,
    estimateRatio: estimate.ratio,
  };
  return Object.freeze(snapshot);
}

/** System prompt and single-pass prompt text the text backend sends for a snapshot. */
export interface RenderedPrefixPrompt {
  readonly system: string;
  readonly promptText: string;
}

/**
 * Render the complete single-pass prompt over a frozen prefix, without user
 * focus instructions. This is what admission sizes and a token counter counts.
 */
export function renderFrozenPrefixPrompt(snapshot: FrozenSnapshot): RenderedPrefixPrompt {
  const evidence = collectPrefixEvidence(snapshot);
  const governing = snapshot.splitTurn ? snapshot.governingUserRequest : null;
  return {
    system: BACKGROUND_COMPACTION_SYSTEM_PROMPT,
    promptText: buildFrozenPrefixPrompt({
      previousSummary: evidence.previousSummary,
      history: evidence.history.map((item) => item.message),
      turnPrefix: evidence.turnPrefix.map((item) => item.message),
      governingRequest: governing?.content,
      scope: "complete",
    }),
  };
}

function collectRange(
  prefix: readonly SessionEntry[],
  keptStart: number,
  visible: Map<string, CompactionMessage[]>,
): TaggedMessage[] {
  const tagged: TaggedMessage[] = [];
  for (let index = keptStart; index < prefix.length; index++) {
    const entry = prefix[index];
    if (!entry || entry.type === "compaction") continue;
    for (const message of visible.get(entry.id) ?? []) {
      tagged.push({ entryId: entry.id, message });
    }
  }
  return tagged;
}

/** The validated first retained entry ID of a snapshot, if it carries one. */
export function readFirstKeptEntryId(snapshot: FrozenSnapshot): string | undefined {
  if (!("firstKeptEntryId" in snapshot)) {
    return undefined;
  }
  const value = snapshot.firstKeptEntryId;
  return Value.Check(NonEmptyStringSchema, value) ? value : undefined;
}

/** Summarizer inputs derived from the frozen prefix only. */
export interface PrefixEvidence {
  readonly previousSummary: string | undefined;
  /** Summarized messages before the governing turn (all of them for a complete-turn cut). */
  readonly history: readonly TaggedMessage[];
  /** Split-turn only: messages from the turn start up to the cut. */
  readonly turnPrefix: readonly TaggedMessage[];
  /** Entry IDs of the frozen prefix; nothing else may reach a prompt. */
  readonly prefixEntryIds: ReadonlySet<string>;
  readonly previousCheckpoint: CompactionEntry | undefined;
  readonly summarizedEntryIds: EntryIdRange | null;
}

/**
 * Split the frozen prefix into the summarizer's inputs.
 *
 * The projection is rebuilt from `snapshot.entries` with the cut as leaf, so
 * no retained or later entry can contribute a message.
 */
export function collectPrefixEvidence(snapshot: FrozenSnapshot): PrefixEvidence {
  const entries = snapshot.entries;
  const compactionIndex = latestCompactionIndex(entries);
  const keptStart = keptStartIndex(entries, compactionIndex);
  const visible = visibleMessages(entries, snapshot.cutEntryId);
  const tagged = collectRange(entries, keptStart, visible);
  const previous = entries[compactionIndex];
  const previousCheckpoint = previous?.type === "compaction" ? previous : undefined;

  let turnStart = -1;
  if (snapshot.splitTurn) {
    turnStart = findTurnStartIndex([...entries], entries.length - 1, keptStart);
  }
  const turnStartId = turnStart >= 0 ? entries[turnStart]?.id : undefined;
  let splitAt = snapshot.splitTurn ? 0 : tagged.length;
  if (turnStartId !== undefined) {
    const position = tagged.findIndex((item) => item.entryId === turnStartId);
    splitAt = Math.max(position, 0);
  }
  const first = tagged[0];
  const last = tagged.at(-1);
  return {
    previousSummary: previousCheckpoint?.summary,
    history: tagged.slice(0, splitAt),
    turnPrefix: tagged.slice(splitAt),
    prefixEntryIds: new Set(entries.map((entry) => entry.id)),
    previousCheckpoint,
    summarizedEntryIds: first && last ? [first.entryId, last.entryId] : null,
  };
}

/** Open tool calls at the end of a prefix (closed by a result or a later assistant message). */
function openCallsAtEnd(snapshot: FrozenSnapshot): number {
  const entries = snapshot.entries;
  const compactionIndex = latestCompactionIndex(entries);
  const keptStart = keptStartIndex(entries, compactionIndex);
  const visible = visibleMessages(entries, snapshot.cutEntryId);
  let open = new Set<string>();
  for (const { message } of collectRange(entries, keptStart, visible)) {
    // A later assistant message closes every call it did not repeat.
    if (message.role === "assistant") open = new Set(toolCallIds(message));
    else if (message.role === "toolResult") open.delete(message.toolCallId);
  }
  return open.size;
}

/**
 * Re-check a snapshot against the rules it was frozen under.
 *
 * Never edits captured entries to manufacture legality; a snapshot that fails
 * here is refused, not repaired.
 */
export function checkSnapshotLegality(snapshot: FrozenSnapshot): LegalityVerdict {
  const entries = snapshot.entries;
  if (entries.length === 0 || entries.at(-1)?.id !== snapshot.cutEntryId) {
    return { legal: false, reason: "malformed" };
  }
  if (chainProblem(entries)) {
    return { legal: false, reason: "malformed" };
  }
  if (fingerprintEntries(entries) !== snapshot.prefixFingerprint) {
    return { legal: false, reason: "malformed" };
  }
  const firstKept = readFirstKeptEntryId(snapshot);
  if (firstKept === undefined || entries.some((entry) => entry.id === firstKept)) {
    return { legal: false, reason: "incompatible" };
  }
  const compactionIndex = latestCompactionIndex(entries);
  const previousId = compactionIndex >= 0 ? (entries[compactionIndex]?.id ?? null) : null;
  if (previousId !== snapshot.priorCheckpointId) {
    return { legal: false, reason: "malformed" };
  }
  if (openCallsAtEnd(snapshot) > 0) {
    return { legal: false, reason: "no-legal-cut" };
  }
  if (snapshot.splitTurn && !snapshot.governingUserRequest && previousId === null) {
    return { legal: false, reason: "no-legal-cut" };
  }
  const evidence = collectPrefixEvidence(snapshot);
  if (evidence.history.length + evidence.turnPrefix.length === 0) {
    return { legal: false, reason: "no-legal-cut" };
  }
  return { legal: true };
}

/**
 * Whether the current branch still matches the frozen prefix.
 *
 * Returns null when adoption may proceed, otherwise the invalidation reason:
 * the prefix changed or moved, the retained entry is gone, a later context
 * edit rewrites a summarized entry, or a newer checkpoint landed after the cut.
 */
export function findPrefixInvalidation(
  snapshot: FrozenSnapshot,
  branch: readonly SessionEntry[],
): ReasonCode | null {
  const cutIndex = branch.findIndex((entry) => entry.id === snapshot.cutEntryId);
  if (cutIndex !== snapshot.entries.length - 1) {
    return "stale-prefix";
  }
  if (fingerprintEntries(branch.slice(0, cutIndex + 1)) !== snapshot.prefixFingerprint) {
    return "stale-prefix";
  }
  if (branch[cutIndex + 1]?.id !== readFirstKeptEntryId(snapshot)) {
    return "stale-prefix";
  }
  const prefix = prefixReferences(snapshot.entries);
  for (const entry of branch.slice(cutIndex + 1)) {
    if (entry.type === "compaction") return "checkpoint-changed";
    if (touchesPrefix(entry, prefix)) return "stale-prefix";
  }
  return null;
}

/** Governing request text as persisted in checkpoint details. */
export interface CappedGoverningContent {
  readonly content: string;
  readonly truncated: boolean;
}

/** Text of a user request, capped for persistence in checkpoint details. */
export function capGoverningContent(content: string): CappedGoverningContent {
  if (content.length <= GOVERNING_REQUEST_MAX_CHARS) {
    return { content, truncated: false };
  }
  return { content: content.slice(0, GOVERNING_REQUEST_MAX_CHARS), truncated: true };
}
