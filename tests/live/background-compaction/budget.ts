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
  // xAI, $2/$6 per MTok (installed catalog; the $4/$12 tier starts above 200k
  // input tokens per request, which no probe request reaches). User-approved
  // (plan Q2) for the RPC probe's manual xAI cell only; spend in
  // LIVE_EXPECTATIONS["rpc-xai-grok-4.7-manual"].
  "xai/grok-4.7",
];
/**
 * Approved models the RPC probe may run in manual cells only: an automatic
 * cell on them costs several times the manual one (Fable 5.1 auto ≈ 460k
 * input tokens ≈ $4.9, runaway ≈ $49), so the auto cell runs on Haiku 5.5.
 */
export const MANUAL_ONLY_LIVE_MODELS: readonly string[] = ["anthropic/claude-fable-5-1"];
/**
 * Models the RPC probe may select with RPC `set_model` and switch straight
 * back from, without ever prompting them (no request reaches the provider,
 * so no spend). The `captures-cleared-before-compact` case needs a second
 * model of the subject's provider; `xai/grok-4.7` is the only approved xAI
 * model, so the xAI cell has no default target and that case fails until one
 * is approved.
 *
 * Nothing enters this list without the user's explicit approval.
 * `xai/grok-4.6` (the installed catalog's other xAI Responses model) was
 * approved as a switch-only target in the compaction-lane session on
 * 2026-06 ("I'll approve for all"); the xAI cell selects it by default
 * (`--switch-model` accepts only approved or listed models).
 */
export const SWITCH_ONLY_LIVE_MODELS: readonly string[] = ["xai/grok-4.6"];
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
  // RPC compaction probe cells (`tests/live/rpc-compaction-probe.ts`), one row
  // per cell (one background setting x one point); the probe sums the assistant
  // usage its RPC stream reports per cell and stops at RUNAWAY_FACTOR x the row.
  // Native lane requests (Anthropic `compaction`, xAI `/responses/compact`,
  // Codex compact) are not assistant messages and are not counted.
  // Manual cell: 6 seed turns, 2 SEED-B turns, plain / instructions /
  // captures-cleared compactions with one follow-up each, then the resume
  // relaunch (one local fallback summary, one turn, one compaction, one
  // follow-up): about 20 requests of ~12k tokens (system prompt and tools).
  // Fable 5.1 ($10/$50 per MTok): ≈ $2.4 in + $0.4 out ≈ $2.8 expected; the
  // runaway stop bounds a cell near $28. (Plan estimate before the
  // captures-cleared and resume cases: 140k in / 6k out ≈ $1.7.)
  "rpc-anthropic-fable-manual": { requests: 20, inputTokens: 240_000, outputTokens: 8_000 },
  // Auto cell on Haiku 5.5 ($0.10/$0.50 per MTok below 100k input per request):
  // calibration (2 turns), 6 seed turns, up to 12 turns to the point and one
  // follow-up per process, ≈ 460k in ≈ $0.05 expected; runaway ≈ $0.5.
  "rpc-anthropic-haiku-auto": { requests: 22, inputTokens: 460_000, outputTokens: 10_000 },
  // Same manual flow on Grok 4.7 ($2/$6 per MTok): ≈ $0.48 in + $0.05 out
  // ≈ $0.55 expected; the runaway stop bounds a cell near $5.3.
  "rpc-xai-grok-4.7-manual": { requests: 20, inputTokens: 240_000, outputTokens: 8_000 },
  // GPT-6 Luna over the ChatGPT subscription (no dollar spend; quota only):
  // the manual flow plus the model-switch case over its foreground checkpoint
  // (one gpt-6-sol turn and one Luna turn).
  "rpc-codex-luna-manual": { requests: 22, inputTokens: 260_000, outputTokens: 8_000 },
  // Luna auto cell (subscription quota, no dollars), background on: the Haiku
  // auto flow (calibration, 6 seed turns, up to 12 turns until the preparer's
  // background candidate is adopted, one follow-up), then the background
  // model-switch case (one gpt-6-sol turn over the background checkpoint, one
  // Luna turn): about 24 requests, ≈ 520k input tokens. A manual cell cannot
  // produce a background Codex checkpoint (routes.ts `manualLanes` gives a
  // Codex owner no manual lane), so plan Q5's background branch runs here.
  "rpc-codex-luna-auto": { requests: 24, inputTokens: 520_000, outputTokens: 12_000 },
};

/**
 * The LIVE_EXPECTATIONS row of one RPC probe cell, or undefined when the
 * cell has none (the probe then runs without a runaway stop and says so).
 */
export function rpcProbeExpectationKey(
  model: string,
  point: "auto" | "manual",
): string | undefined {
  return RPC_PROBE_ROWS.get(`${model}|${point}`);
}

const RPC_PROBE_ROWS: ReadonlyMap<string, string> = new Map([
  ["anthropic/claude-fable-5-1|manual", "rpc-anthropic-fable-manual"],
  ["anthropic/claude-haiku-5-5|auto", "rpc-anthropic-haiku-auto"],
  ["xai/grok-4.7|manual", "rpc-xai-grok-4.7-manual"],
  ["openai-codex/gpt-6-luna|manual", "rpc-codex-luna-manual"],
  ["openai-codex/gpt-6-luna|auto", "rpc-codex-luna-auto"],
]);
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
