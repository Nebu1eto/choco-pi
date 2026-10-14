/**
 * Live-tier usage policy (user decision (a)+(b)): no tuning caps. The ledger
 * counts real provider-reported tokens per request; a tokenizer-free estimate
 * is used only before send, by a runaway safety stop at 10x the expected usage.
 */
export interface Expectation {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}
interface ExpectationTable {
  readonly [scenario: string]: Expectation;
}
/** Approved subjects and provider-unavailability fallbacks (authorization). */
export const APPROVED_LIVE_MODELS: readonly string[] = [
  "anthropic/claude-haiku-5-5",
  "anthropic/claude-sonnet-5-5",
  "anthropic/claude-fable-5-1",
  "openai-codex/gpt-6-luna",
  "openai-codex/gpt-6.1-sol",
];
/**
 * Expected usage per process (restart-recovery: per worker phase). Full worktree profile:
 * about 7k tokens of system prompt and tool schemas per request, plus a
 * ~16k-token seeded prefix.
 */
export const LIVE_EXPECTATIONS: ExpectationTable = {
  "text-boundary-adoption": { requests: 7, inputTokens: 220_000, outputTokens: 12_000 },
  "anthropic-native-adoption": { requests: 8, inputTokens: 260_000, outputTokens: 24_000 },
  "idle-input-adoption": { requests: 3, inputTokens: 90_000, outputTokens: 8_000 },
  "restart-recovery": { requests: 4, inputTokens: 130_000, outputTokens: 10_000 },
  // No seeded padding: three short turns, one lane request and at most one
  // fallback turn, each ~15k tokens of system prompt and tool schemas. Sized for
  // claude-fable-5-1 ($10/$50 per MTok, 100x Haiku 5.5): about $0.80 expected,
  // so the 10x runaway stop bounds one run near $8.
  "anthropic-foreground-compaction": { requests: 5, inputTokens: 70_000, outputTokens: 4_000 },
};
export const RUNAWAY_FACTOR = 10;

export function requireLiveRun(
  scenario: string,
  model: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Expectation {
  if (env.CHOCO_PI_LIVE_E2E !== "1" || !model || !model.includes("/"))
    throw new Error("Live requires CHOCO_PI_LIVE_E2E=1 and explicit provider/model");
  if (!APPROVED_LIVE_MODELS.includes(model)) throw new Error(`Unapproved live model ${model}`);
  const expected = LIVE_EXPECTATIONS[scenario];
  if (!expected) throw new Error(`No live driver for ${scenario}`);
  return { ...expected };
}

/** Tokenizer-free upper estimate (about 3 UTF-8 bytes per token); pre-send guard only. */
export function estimateTokens(bodyText: string): number {
  return Math.ceil(Buffer.byteLength(bodyText) / 3);
}
