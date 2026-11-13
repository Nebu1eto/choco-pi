import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

/**
 * One conversation message as the host hands it to compaction.
 *
 * Derived from the event type instead of importing `AgentMessage` directly, so
 * this package depends only on the two host packages it already declares.
 */
export type CompactionMessage =
  SessionBeforeCompactEvent["preparation"]["messagesToSummarize"][number];

/** Compaction settings the host resolved for this session. */
export type CompactionSettings = SessionBeforeCompactEvent["preparation"]["settings"];

/** File operations the host extracted from the messages it is discarding. */
export type CompactionFileOperations = SessionBeforeCompactEvent["preparation"]["fileOps"];

/** First and last session entry IDs of a contiguous evidence range. */
export type EntryIdRange = readonly [string, string];
