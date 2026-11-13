export const scenarios = [
  { id: "S1", title: "semantic non-interference", tier: "both" },
  { id: "S2", title: "structured refusal", tier: "both" },
  { id: "S3", title: "no duplicate retry", tier: "both" },
  { id: "S4", title: "cancellation acknowledgement", tier: "both" },
  { id: "S5", title: "stale state", tier: "both" },
  { id: "S6", title: "foreground grant control", tier: "both" },
  { id: "S7", title: "second client ownership", tier: "a" },
] as const;
export type ScenarioId = (typeof scenarios)[number]["id"];
