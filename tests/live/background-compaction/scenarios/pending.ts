import type { PendingScenario } from "./types.ts";

export const PENDING_SCENARIOS: readonly PendingScenario[] = [
  {
    name: "codex-native-replay",
    description: "Codex native steady-state cached-WebSocket replay",
    pending: [
      "The launcher serves only the offline Anthropic model; no openai-codex provider or credential seeding",
      "No verified scripted cached-WebSocket server for Codex foreground traffic",
      "No injected Codex native lane HTTP fixture or transport capture",
    ],
  },
  {
    name: "codex-long-child-turn",
    description: "Long single-prompt Codex child over 32 offline tool cycles",
    pending: [
      "Needs the Codex model launch, cached-WebSocket fixture and lane fixture of codex-native-replay",
      "No child Codex request capture at a mid-turn cut",
    ],
  },
  {
    name: "child-cancellation-during-adoption",
    description: "Child cancellation and late completion during parent adoption",
    pending: [
      "The fake server cannot hold a summarizer response open while a child is stopped",
      "No hook pauses the parent inside its adopting window to land a child completion",
      "No per-completion delivery counter on the runner notification path",
    ],
  },
];
