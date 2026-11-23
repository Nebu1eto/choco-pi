import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

export type CompactionMessage =
  SessionBeforeCompactEvent["preparation"]["messagesToSummarize"][number];

export type CompactionSettings = SessionBeforeCompactEvent["preparation"]["settings"];

export type CompactionFileOperations = SessionBeforeCompactEvent["preparation"]["fileOps"];

export type EntryIdRange = readonly [string, string];
