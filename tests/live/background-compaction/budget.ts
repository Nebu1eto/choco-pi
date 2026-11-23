export interface Expectation {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}
interface ExpectationTable {
  readonly [scenario: string]: Expectation;
}
export const APPROVED_LIVE_MODELS: readonly string[] = [
  "anthropic/claude-haiku-5-5",
  "anthropic/claude-sonnet-5-5",
  "anthropic/claude-fable-5-1",
  "anthropic/claude-opus-5-5",
  "openai-codex/gpt-6-luna",
  "openai-codex/gpt-6-sol",
  "openai-codex/gpt-6.1-sol",
  "synthetic/hf:moonshotai/Kimi-K3",
  "synthetic/hf:zai-org/GLM-5.3",
  "xai/grok-4.7",
];
export const MANUAL_ONLY_LIVE_MODELS: readonly string[] = ["anthropic/claude-fable-5-1"];
export const SWITCH_ONLY_LIVE_MODELS: readonly string[] = ["xai/grok-4.6"];
export const LIVE_EXPECTATIONS: ExpectationTable = {
  "text-boundary-adoption": { requests: 7, inputTokens: 220_000, outputTokens: 12_000 },
  "anthropic-native-adoption": { requests: 8, inputTokens: 260_000, outputTokens: 24_000 },
  "idle-input-adoption": { requests: 3, inputTokens: 90_000, outputTokens: 8_000 },
  "manual-background-compaction": { requests: 8, inputTokens: 220_000, outputTokens: 14_000 },
  "manual-background-compaction-large": {
    requests: 8,
    inputTokens: 400_000,
    outputTokens: 40_000,
  },
  "restart-recovery": { requests: 4, inputTokens: 130_000, outputTokens: 10_000 },
  "anthropic-foreground-compaction": { requests: 5, inputTokens: 70_000, outputTokens: 4_000 },
  "context-window-presets": { requests: 1, inputTokens: 40_000, outputTokens: 2_000 },
  "rpc-anthropic-fable-manual": { requests: 20, inputTokens: 240_000, outputTokens: 8_000 },
  "rpc-anthropic-haiku-auto": { requests: 22, inputTokens: 460_000, outputTokens: 10_000 },
  "rpc-xai-grok-4.7-manual": { requests: 20, inputTokens: 240_000, outputTokens: 8_000 },
  "rpc-codex-luna-manual": { requests: 22, inputTokens: 260_000, outputTokens: 8_000 },
  "rpc-codex-luna-auto": { requests: 24, inputTokens: 520_000, outputTokens: 12_000 },
};

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

export function estimateTokens(bodyText: string): number {
  return Math.ceil(Buffer.byteLength(bodyText) / 3);
}
