import path from "node:path";

export const PROFILE_LINKS: readonly (readonly [string, string])[] = [
  ["profile/SYSTEM.md", "SYSTEM.md"],
  ["profile/writing-policy.md", "writing-policy.md"],
  ["profile/review-policy.md", "review-policy.md"],
  ["profile/subagents.json", "subagents.json"],
  ["profile/models.json", "models.json"],
  ["profile/keybindings.json", "keybindings.json"],
  ["profile/agents/advisor.md", "agents/advisor.md"],
  ["profile/agents/general.md", "agents/general.md"],
  ["profile/agents/planner.md", "agents/planner.md"],
  ["profile/agents/implementer.md", "agents/implementer.md"],
  ["profile/agents/reviewer.md", "agents/reviewer.md"],
  ["profile/agents/verifier.md", "agents/verifier.md"],
  ["profile/agents/handoff.md", "agents/handoff.md"],
  ["profile/agents/explore.md", "agents/explore.md"],
  ["profile/extensions/apex-provider.json", "extensions/apex-provider.json"],
  ["profile/extensions/review.json", "extensions/review.json"],
];

export const PROFILE_SEEDS: readonly (readonly [string, string])[] = [
  ["profile/choco-pi-codex.json", "choco-pi-codex.json"],
  ["profile/zentui.json", "choco-pi-ui.json"],
];

export const MIGRATED_SIDECARS: readonly string[] = ["extensions/background-compaction.json"];

export const RETIRED_PROFILE_FILES: readonly string[] = ["extensions/context-cap.json"];

export const DEFAULT_PROFILE_PACKAGES: readonly string[] = [
  "./packages/choco-pi-web-search",
  "./packages/choco-pi-provider-synthetic",
  "./packages/choco-pi-provider-google-antigravity",
  "./packages/choco-pi-ui",
  "./packages/choco-pi-shells",
  "./packages/choco-pi-hooks",
  "./packages/choco-pi-subagents",
  "./packages/choco-pi-advisor",
  "./packages/choco-pi-goal",
  "./packages/choco-pi-mcp",
  "./packages/choco-pi-lsp",
  "./packages/choco-pi-compaction",
  "./packages/choco-pi-codex",
  "./packages/choco-pi-code-mode",
  "./packages/choco-pi-agents-md",
  "./packages/choco-pi-agent-browser",
  "./packages/choco-pi-computer-use",
  "./packages/choco-pi-editor-context",
];

export const DEFAULT_PROFILE_PACKAGE_NAMES: readonly string[] = DEFAULT_PROFILE_PACKAGES.map(
  (spec) => path.basename(spec),
);

export const PRE_RECORD_BUNDLED_PACKAGE_NAMES: readonly string[] = [
  "choco-pi-web-search",
  "choco-pi-web-access",
  "choco-pi-provider-synthetic",
  "choco-pi-ui",
  "choco-pi-shells",
  "choco-pi-hooks",
  "choco-pi-subagents",
  "choco-pi-advisor",
  "choco-pi-goal",
  "choco-pi-mcp",
  "choco-pi-lsp",
  "choco-pi-compaction",
  "choco-pi-codex",
  "choco-pi-agents-md",
  "choco-pi-agent-browser",
  "choco-pi-computer-use",
  "choco-pi-editor-context",
];

export const DEFAULT_PROFILE_EXTENSIONS: readonly string[] = [
  "-builtin:codemode",
  "-builtin:tool-search",
];

export const DEFAULT_PROFILE_ENABLED_MODELS: readonly string[] = [
  "anthropic/claude-mythos-5-2",
  "anthropic/claude-fable-5-2",
  "anthropic/claude-mythos-5-1",
  "anthropic/claude-fable-5-1",
  "anthropic/claude-opus-5-5",
  "anthropic/claude-opus-4-6",
  "anthropic/claude-sonnet-5-5",
  "anthropic/claude-haiku-5-5",
  "openai-codex/gpt-6.2-astra",
  "openai-codex/gpt-6.2-sol",
  "openai-codex/gpt-6-astra",
  "openai-codex/gpt-6.1-sol",
  "openai-codex/gpt-6.1-terra",
  "openai-codex/gpt-6-sol",
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-6-luna",
  "synthetic/hf:moonshotai/Kimi-K3.1-Pro",
  "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017",
  "synthetic/hf:zai-org/GLM-5.3",
  "synthetic/hf:zai-org/GLM-5.3-Flash",
  "xai/grok-4.6",
  "xai/grok-4.7",
];

export const DEFAULT_PROFILE_MODEL_THINKING_LEVELS = {
  "anthropic/claude-fable-5": "high",
  "anthropic/claude-opus-5": "medium",
  "anthropic/claude-opus-4-6": "high",
  "anthropic/claude-sonnet-5": "xhigh",
  "openai/gpt-6-astra": "low",
  "openai-codex/gpt-6-astra": "low",
  "openai/gpt-5.6-sol": "low",
  "openai-codex/gpt-5.6-sol": "low",
  "openai/gpt-daybreak-blue-latest": "high",
  "openai/gpt-5.6-terra": "high",
  "openai-codex/gpt-5.6-terra": "high",
  "openai/gpt-5.6-luna": "xhigh",
  "openai-codex/gpt-5.6-luna": "xhigh",
  "synthetic/hf:moonshotai/Kimi-K3": "high",
  "anthropic/claude-fable-5-1": "low",
  "anthropic/claude-opus-5-5": "medium",
  "anthropic/claude-sonnet-5-5": "medium",
  "anthropic/claude-haiku-5-5": "medium",
  "openai/gpt-6-sol": "low",
  "openai-codex/gpt-6-sol": "low",
  "openai/gpt-6.1-sol": "low",
  "openai-codex/gpt-6.1-sol": "low",
  "openai/gpt-6.1-terra": "high",
  "openai-codex/gpt-6.1-terra": "high",
  "openai/gpt-6-luna": "high",
  "openai-codex/gpt-6-luna": "high",
  "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash": "low",
  "synthetic/hf:zai-org/GLM-5.3": "high",
  "synthetic/hf:zai-org/GLM-5.3-Flash": "high",
  "anthropic/claude-mythos-5-1": "low",
  "anthropic/claude-fable-5-2": "high",
  "anthropic/claude-mythos-5-2": "high",
  "synthetic/hf:moonshotai/Kimi-K3.1-Pro": "high",
  "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017": "high",
  "openai-codex/gpt-6.2-astra": "medium",
  "openai-codex/gpt-6.2-sol": "low",
} as const satisfies Readonly<Record<string, string>>;

export const PROFILE_DIRECTORY_NAMES = ["extensions", "skills", "prompts"] as const;
