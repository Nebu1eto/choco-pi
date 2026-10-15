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
  // User-approved for the RPC compaction probe matrix.
  "anthropic/claude-opus-5-5",
  "openai-codex/gpt-6-luna",
  "openai-codex/gpt-6-sol",
  "openai-codex/gpt-6.1-sol",
  // Synthetic, $3/$15 per MTok (catalog): the context-window-presets estimate
  // (40k in / 2k out) is about $0.15 a run; the 10x runaway stop near $1.50.
  "synthetic/hf:moonshotai/Kimi-K3",
  // Synthetic, $1.4/$4.4 per MTok (catalog; 524,288 window, reasoning always
  // on). User-approved for the manual background-compaction runs; spend per
  // scenario is in LIVE_EXPECTATIONS below.
  "synthetic/hf:zai-org/GLM-5.3",
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
  // Five short turns and three background summaries over the seeded prefix.
  // Synthetic: GLM-5.3 about $0.31 in + $0.06 out; Kimi-K3 about $0.66 + $0.21.
  "manual-background-compaction": { requests: 8, inputTokens: 220_000, outputTokens: 14_000 },
  // Same flow over the large seed (MANUAL_LARGE_SEED in the scenario): 40 tool
  // results x 22,000 chars = 880,000 chars plus 3 x 20,000 chars of padding,
  // a raw chars/4 estimate near 235,000 tokens (> the old flat 200,000 gate).
  // Only the first turn carries the whole prefix: a real tokenizer reads the
  // seeded prose at 4-7 chars per token, so ~135k-235k tokens plus ~15k of
  // system prompt and tools. The first summary reads the rendered prompt (tool
  // results cut to 2,000 chars: ~140k chars, ~25-40k tokens); the six later
  // requests sit on a checkpoint (~15-25k each). Sum: ~250k-400k input; output
  // is mostly reasoning (GLM-5.3 and Kimi-K3 always reason): ~40k.
  // Spend: GLM-5.3 ~$0.35-0.56 in + ~$0.18 out (~$0.75 max expected);
  // Kimi-K3 ~$0.75-1.20 in + ~$0.60 out (~$1.80). The 10x runaway stop bounds
  // one run near $7.40 (GLM-5.3) / $18 (Kimi-K3). The pre-send guard estimates
  // bytes/3: the first request's ~1 MB body reserves ~350k of the 4M limit.
  "manual-background-compaction-large": {
    requests: 8,
    inputTokens: 400_000,
    outputTokens: 40_000,
  },
  "restart-recovery": { requests: 4, inputTokens: 130_000, outputTokens: 10_000 },
  // No seeded padding: three short turns, one lane request and at most one
  // fallback turn, each ~15k tokens of system prompt and tool schemas. Sized for
  // claude-fable-5-1 ($10/$50 per MTok, 100x Haiku 5.5): about $0.80 expected,
  // so the 10x runaway stop bounds one run near $8.
  "anthropic-foreground-compaction": { requests: 5, inputTokens: 70_000, outputTokens: 4_000 },
  // One short turn; preset changes and /status, /context are local (no request).
  // Codex traffic rides choco-pi-codex's WebSocket, outside this fetch ledger;
  // Synthetic (OpenAI-compatible) rides fetch, and the ledger parses its
  // chat-completions usage (final SSE chunk or JSON body).
  "context-window-presets": { requests: 1, inputTokens: 40_000, outputTokens: 2_000 },
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
