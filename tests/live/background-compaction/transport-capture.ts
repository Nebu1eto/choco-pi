import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isString } from "./schema-check.ts";
import {
  digest,
  isArtifactInput,
  isArtifactRecord,
  redact,
  type ArtifactInput,
  type Recorder,
  parseArtifactInput,
} from "./artifacts.ts";

/** A unique text that identifies one branch entry inside a serialized payload. */
export interface EntryMarker {
  entryId: string;
  text: string;
}

interface MarkerPosition {
  entryId: string;
  stringIndex: number;
  offset: number;
}

/** Every string in the payload, depth-first in serialization order. */
function payloadStrings(payload: ArtifactInput): string[] {
  if (isString(payload)) return [payload];
  if (Array.isArray(payload)) return payload.flatMap(payloadStrings);
  if (!isArtifactRecord(payload)) return [];
  return Object.values(payload).flatMap((item) => payloadStrings(redact(item)));
}

function firstPosition(
  strings: readonly string[],
  marker: EntryMarker,
): MarkerPosition | undefined {
  for (const [stringIndex, text] of strings.entries()) {
    const offset = text.indexOf(marker.text);
    if (offset >= 0) return { entryId: marker.entryId, stringIndex, offset };
  }
  return undefined;
}

function isEarlier(left: MarkerPosition, right: MarkerPosition): boolean {
  return (
    left.stringIndex < right.stringIndex ||
    (left.stringIndex === right.stringIndex && left.offset < right.offset)
  );
}

function assertUnambiguous(ordered: readonly MarkerPosition[]): void {
  for (const [index, next] of ordered.entries()) {
    const previous = ordered[index - 1];
    if (previous && previous.stringIndex === next.stringIndex && previous.offset === next.offset)
      throw new Error(`Ambiguous entry marker mapping: ${previous.entryId} / ${next.entryId}`);
  }
}

/** Entry IDs present in the payload, in wire order. Never infer an ID from order alone. */
export function mapPayload(payload: ArtifactInput, markers: readonly EntryMarker[]): string[] {
  const strings = payloadStrings(payload);
  const positions = new Map<string, MarkerPosition>();
  for (const marker of markers) {
    if (!marker.text.length) throw new Error("Empty entry marker");
    const found = firstPosition(strings, marker);
    const previous = positions.get(marker.entryId);
    if (found && (!previous || isEarlier(found, previous))) positions.set(marker.entryId, found);
  }
  const ordered = [...positions.values()].toSorted(
    (left, right) => left.stringIndex - right.stringIndex || left.offset - right.offset,
  );
  assertUnambiguous(ordered);
  return ordered.map(({ entryId }) => entryId);
}

/** True when any string anywhere inside the (unredacted) value contains `text`. */
export function containsText(value: ArtifactInput, text: string): boolean {
  if (!isArtifactInput(value)) throw new Error("Invalid marker search input");
  if (isString(value)) return value.includes(text);
  if (Array.isArray(value)) return value.some((item) => containsText(item, text));
  return isArtifactRecord(value) && Object.values(value).some((item) => containsText(item, text));
}

export function capturePayload(
  recorder: Recorder,
  source: "transport" | "before-provider",
  payload: ArtifactInput,
  markers: readonly EntryMarker[],
  ownerKey?: string,
): void {
  if (!isArtifactInput(payload)) throw new Error("Invalid provider payload");
  const safe = redact(payload);
  recorder.record(source, {
    ownerKey,
    payload: safe,
    entryIds: mapPayload(safe, markers),
    ...digest(JSON.stringify(payload)),
  });
}

function branchRecord(entry: SessionEntry) {
  const base = { id: entry.id, parentId: entry.parentId, type: entry.type };
  if (entry.type === "compaction")
    return {
      ...base,
      summary: entry.summary,
      firstKeptEntryId: entry.firstKeptEntryId,
      details: redact(parseArtifactInput(entry.details)),
    };
  if (entry.type === "custom")
    return {
      ...base,
      customType: entry.customType,
      data: redact(parseArtifactInput(entry.data)),
    };
  if (entry.type === "message")
    return { ...base, message: redact(parseArtifactInput(entry.message)) };
  return base;
}

export function recordBranch(recorder: Recorder, entries: readonly SessionEntry[]): number {
  return recorder.record("branch", entries.map(branchRecord));
}

/** Wraps the installed adapter's fetch: the actual serialized request is the evidence. */
export function capturingFetch(
  recorder: Recorder,
  markers: () => readonly EntryMarker[],
  delegate: typeof globalThis.fetch,
  ownerKey?: string,
): typeof globalThis.fetch {
  return async (input, init) => {
    const body = init?.body ?? (input instanceof Request ? await input.clone().text() : "");
    if (!isString(body)) throw new Error("Uncapturable request body");
    const payload: unknown = body.length ? JSON.parse(body) : null;
    if (!isArtifactInput(payload)) throw new Error("Invalid serialized transport");
    capturePayload(recorder, "transport", payload, markers(), ownerKey);
    return delegate(input, init);
  };
}
