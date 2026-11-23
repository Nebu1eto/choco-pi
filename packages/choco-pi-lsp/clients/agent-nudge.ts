import { arr, compile, lit, obj, oneOf, str } from "@earendil-works/pi-schema";
import type { FilesTouchedPayload } from "./bus-publish.ts";
import { logLatency } from "./latency-logger.ts";
import { normalizeMapKey } from "./path-utils.ts";
import type { ReadGuard } from "./read-guard.ts";

const BUS_FILES_TOUCHED_EVENT = "pilens:files:touched";
const FilesTouchedPayloadSchema = obj(
  {
    v: lit(1),
    source: lit("choco-pi-lsp"),
    reason: oneOf(["autofix", "format"]),
    paths: arr(str()),
  },
  { open: true },
);
const isFilesTouchedPayload = compile(FilesTouchedPayloadSchema).check;
const MAX_NAMES_SHOWN = 5;

export type AccumulatedFileOrigin = "local" | "cross-process";

interface AccumulatedFile {
  displayPath: string;
  reasons: Set<FilesTouchedPayload["reason"]>;
  origin: AccumulatedFileOrigin;
  contentDelivered: boolean;
}

const _touched = new Map<string, AccumulatedFile>();

let _relevanceFilteredCount = 0;

export function _resetAgentNudgeForTests(): void {
  _touched.clear();
  _relevanceFilteredCount = 0;
  _enabledCache = undefined;
}

let _enabledCache: boolean | undefined;

export function isAgentNudgeEnabled(): boolean {
  if (_enabledCache === undefined) {
    _enabledCache = process.env.CHOCO_PI_LSP_AGENT_NUDGE !== "0";
  }
  return _enabledCache;
}

function isValidPayload<T>(data: T): data is T & FilesTouchedPayload {
  return isFilesTouchedPayload(data);
}

function recordTouchedEvent(
  payload: FilesTouchedPayload,
  getReadGuard: () => ReadGuard | undefined,
): void {
  const readGuard = getReadGuard();
  if (!readGuard) return;

  for (const rawPath of payload.paths) {
    const isRelevant =
      readGuard.getReadHistory(rawPath).length > 0 || readGuard.getEditHistory(rawPath).length > 0;
    if (!isRelevant) {
      _relevanceFilteredCount++;
      continue;
    }

    const mapKey = normalizeMapKey(rawPath);
    const existing = _touched.get(mapKey);
    if (existing) {
      existing.reasons.add(payload.reason);
      existing.origin = "local";
      existing.contentDelivered = false;
    } else {
      _touched.set(mapKey, {
        displayPath: rawPath,
        reasons: new Set([payload.reason]),
        origin: "local",
        contentDelivered: false,
      });
    }
  }
}

export function recordCrossProcessTouches(
  entries: Array<{ path: string; reason: FilesTouchedPayload["reason"] }>,
): void {
  if (!isAgentNudgeEnabled()) return;
  for (const entry of entries) {
    const mapKey = normalizeMapKey(entry.path);
    const existing = _touched.get(mapKey);
    if (existing) {
      existing.reasons.add(entry.reason);
      existing.contentDelivered = false;
    } else {
      _touched.set(mapKey, {
        displayPath: entry.path,
        reasons: new Set([entry.reason]),
        origin: "cross-process",
        contentDelivered: false,
      });
    }
  }
}

export function noteAuthoritativeContentAttachment(filePath: string, attached: boolean): void {
  const entry = _touched.get(normalizeMapKey(filePath));
  if (entry) entry.contentDelivered = attached;
}

export interface WireAgentNudgeSubscriberArgs {
  events:
    | { on?: (channel: string, handler: (data: FilesTouchedPayload) => void) => () => void }
    | undefined;
  getReadGuard: () => ReadGuard | undefined;
  dbg?: (msg: string) => void;
}

export function wireAgentNudgeSubscriber(args: WireAgentNudgeSubscriberArgs): void {
  const { events, getReadGuard, dbg } = args;
  if (!events?.on) return;

  try {
    events.on(BUS_FILES_TOUCHED_EVENT, (data: FilesTouchedPayload) => {
      if (!isAgentNudgeEnabled()) return;
      if (!isValidPayload(data)) return;
      try {
        recordTouchedEvent(data, getReadGuard);
      } catch (err) {
        dbg?.(`agent-nudge: failed to record touched event: ${err}`);
      }
    });
  } catch (err) {
    dbg?.(`agent-nudge: subscribe failed (older pi host?): ${err}`);
  }
}

export function consumeAgentNudge(
  dbg?: (msg: string) => void,
): { messages: Array<{ role: "user"; content: string }> } | undefined {
  const drained = Array.from(_touched.values());
  _touched.clear();
  const filesFiltered = _relevanceFilteredCount;
  _relevanceFilteredCount = 0;

  if (!isAgentNudgeEnabled()) return undefined;
  if (drained.length === 0) return undefined;

  try {
    const entries = drained.filter((e) => !e.contentDelivered);
    const filesContentDelivered = drained.length - entries.length;
    const filesTotal = entries.length;
    const shown = entries.slice(0, MAX_NAMES_SHOWN);
    const remaining = filesTotal - shown.length;

    const allReasons = new Set<FilesTouchedPayload["reason"]>();
    for (const e of entries) {
      for (const r of e.reasons) allReasons.add(r);
    }
    const verbLabel =
      allReasons.size > 1
        ? "autofixed/reformatted"
        : allReasons.has("format")
          ? "reformatted"
          : "autofixed";

    const names = shown.map((e) => e.displayPath);
    const nameList =
      remaining > 0 ? `${names.join(", ")}, and ${remaining} more` : names.join(", ");

    const crossProcessCount = entries.filter((e) => e.origin === "cross-process").length;
    const localCount = filesTotal - crossProcessCount;

    logLatency({
      type: "phase",
      filePath: "<choco-pi-lsp>",
      phase: "agent_nudge",
      durationMs: 0,
      metadata: {
        filesTotal,
        filesShown: shown.length,
        filesFiltered,
        filesContentDelivered,
        reasonMix: Array.from(allReasons),
        originLocal: localCount,
        originCrossProcess: crossProcessCount,
      },
    });

    if (filesTotal === 0) return undefined;

    const attribution =
      localCount === 0
        ? "by an automatic run outside your turn"
        : crossProcessCount === 0
          ? "after your last turn"
          : `after your last turn (${crossProcessCount} of them by an automatic run outside it)`;
    const message = `choco-pi-lsp: ${filesTotal} file(s) were ${verbLabel} ${attribution}: ${nameList} — working-tree changes to these are expected; re-read before editing.`;

    return {
      messages: [
        {
          role: "user",
          content: `[choco-pi-lsp automated context — not a user request] ${message}`,
        },
      ],
    };
  } catch (err) {
    dbg?.(`agent-nudge: consume failed: ${err}`);
    return undefined;
  }
}
