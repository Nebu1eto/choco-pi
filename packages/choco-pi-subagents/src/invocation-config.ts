import { oneOf, opt } from "@earendil-works/pi-schema";
import { normalizeTierModel } from "./model-tiers.ts";
import type {
  AgentConfig,
  IsolationMode,
  JoinMode,
  ModelProvenance,
  ModelSource,
  ThinkingLevel,
} from "./types.ts";

let requireExplicitModel = true;

export function isRequireExplicitModel(): boolean {
  return requireExplicitModel;
}
export function setRequireExplicitModel(enabled: boolean): void {
  requireExplicitModel = enabled;
}

const isolationSchemaFields = {
  isolation: opt(
    oneOf(["off", "worktree"], {
      description:
        '"off" uses this checkout; "worktree" creates an isolated temporary copy. Applies unless the agent definition pins it.',
    }),
  ),
};

export function isolationParam(enabled: boolean): Partial<typeof isolationSchemaFields> {
  return enabled ? isolationSchemaFields : {};
}

interface AgentInvocationParams {
  model?: string;
  thinking?: string;
  max_turns?: number;
  timeout_ms?: number;
  max_tool_calls?: number;
  max_tokens?: number;
  idle_timeout_ms?: number;
  run_in_background?: boolean;
  inherit_context?: boolean;
  isolated?: boolean;
  fast_mode?: boolean;
  daybreak?: boolean;
  model_override_reason?: string;
  isolation?: unknown;
}

export type ModelInputSource = ModelSource;

export type OverriddenCallerField = "model" | "thinking";

interface ResolvedAgentInvocationConfig {
  modelInput?: string;
  modelFromParams: boolean;
  modelSource: ModelInputSource;
  callerOverridesRoleModel: boolean;
  overriddenCallerFields: OverriddenCallerField[];
  thinking?: ThinkingLevel;
  maxTurns?: number;
  timeoutMs?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  idleTimeoutMs?: number;
  inheritContext: boolean;
  runInBackground: boolean;
  isolated: boolean;
  isolation?: IsolationMode;
  fastMode?: boolean;
  daybreak?: boolean;
}

interface ResolveOptions {
  defaultRunInBackground?: boolean;
  worktreeAllowed?: boolean;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
  opts?: ResolveOptions,
): ResolvedAgentInvocationConfig {
  const requested = agentConfig?.isolation ?? params.isolation;
  const isolation =
    requested === "worktree" && opts?.worktreeAllowed !== false ? "worktree" : undefined;

  const locked = agentConfig?.modelLocked === true;
  const requestedThinking = locked
    ? agentConfig?.thinking
    : (params.thinking ?? agentConfig?.thinking);
  // SAFETY: Pi accepts the advertised "off" level at runtime although ThinkingLevel omits it.
  const thinking = (
    requestedThinking === "off" ||
    requestedThinking === "minimal" ||
    requestedThinking === "low" ||
    requestedThinking === "medium" ||
    requestedThinking === "high" ||
    requestedThinking === "xhigh" ||
    requestedThinking === "max"
      ? requestedThinking
      : undefined
  ) as ThinkingLevel | undefined;

  const modelInput = locked ? agentConfig?.model : (params.model ?? agentConfig?.model);
  let modelSource: ModelInputSource = "default";
  if (modelInput == null) modelSource = "inherit";
  else if (locked) modelSource = "pin";
  else if (params.model != null) modelSource = "caller";
  const overriddenCallerFields: OverriddenCallerField[] = [];
  if (locked && params.model != null && params.model !== agentConfig?.model)
    overriddenCallerFields.push("model");
  if (locked && params.thinking != null && params.thinking !== agentConfig?.thinking)
    overriddenCallerFields.push("thinking");

  return {
    modelInput,
    modelFromParams: modelSource === "caller",
    modelSource,
    callerOverridesRoleModel: modelSource === "caller" && params.model !== agentConfig?.model,
    overriddenCallerFields,
    thinking,
    maxTurns: agentConfig?.maxTurns ?? params.max_turns,
    timeoutMs: params.timeout_ms,
    maxToolCalls: params.max_tool_calls,
    maxTokens: params.max_tokens,
    idleTimeoutMs: params.idle_timeout_ms,
    inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
    runInBackground:
      agentConfig?.runInBackground ??
      params.run_in_background ??
      opts?.defaultRunInBackground ??
      false,
    isolated: agentConfig?.isolated ?? params.isolated ?? false,
    fastMode: params.fast_mode ?? agentConfig?.fastMode,
    daybreak: params.daybreak ?? agentConfig?.daybreak,
    isolation,
  };
}

export function resolveJoinMode(
  defaultJoinMode: JoinMode,
  runInBackground: boolean,
): JoinMode | undefined {
  return runInBackground ? defaultJoinMode : undefined;
}

export function describeModelResolution(args: {
  agentLabel: string;
  resolved: Pick<
    ResolvedAgentInvocationConfig,
    "modelInput" | "modelSource" | "overriddenCallerFields"
  >;
  modelUnavailable: boolean;
  parentModel: { provider: string; id: string } | undefined;
}): string {
  const { agentLabel, resolved, modelUnavailable, parentModel } = args;
  const notes: string[] = [];
  if (resolved.overriddenCallerFields.length > 0) {
    const fields = resolved.overriddenCallerFields.join(" and ");
    notes.push(
      `Note: agent "${agentLabel}" pins ${fields} (model_locked); the caller-supplied ${fields} was ignored.`,
    );
  }
  const parent = parentModel ? `${parentModel.provider}/${parentModel.id}` : "the parent model";
  if (modelUnavailable && resolved.modelInput !== undefined && resolved.modelSource !== "inherit") {
    const origin = resolved.modelSource === "pin" ? "pinned model" : "default model";
    notes.push(
      `Note: agent "${agentLabel}" ${origin} "${resolved.modelInput}" is not available; running on ${parent} instead.`,
    );
  }
  if (resolved.modelSource === "inherit" && !resolved.overriddenCallerFields.includes("model")) {
    notes.push(
      `Note: agent "${agentLabel}" declares no model and the caller passed none; it inherits ${parent}.`,
    );
  }
  return notes.length > 0 ? `${notes.join("\n")}\n\n` : "";
}

function roleFacts(config: AgentConfig | undefined) {
  return {
    definition: config?.sourcePath ?? "built-in",
    model: config?.model ?? "none",
    thinking: config?.thinking ?? "none",
  };
}

export function describeRoleModel(name: string, config: AgentConfig | undefined): string {
  return `${name}: ${describeRoleDeclaration(config)}`;
}

export function describeRoleDeclaration(config: AgentConfig | undefined): string {
  const facts = roleFacts(config);
  const lock = config?.modelLocked === true ? " (locked)" : "";
  return `model ${facts.model}${lock}, thinking ${facts.thinking}, definition ${facts.definition}`;
}

export function explicitModelRefusal(
  name: string,
  config: AgentConfig | undefined,
  params: { model?: string; thinking?: string },
): string | undefined {
  if (!requireExplicitModel || (params.model && params.thinking)) return undefined;
  const facts = roleFacts(config);
  const declaresAny = config?.model !== undefined || config?.thinking !== undefined;
  const advice = declaresAny
    ? "pass those or an override with a reason."
    : "choose them from profile/model-guidance.md for this role and record the reason.";
  return (
    `Spawn refused: pass model and thinking. Role "${name}" (${facts.definition}) declares model ` +
    `${facts.model}, thinking ${facts.thinking}; ${advice}`
  );
}

export function tierRefusal(
  name: string,
  config: AgentConfig | undefined,
  params: { model?: string; model_override_reason?: string },
  flagship: ReadonlySet<string>,
): string | undefined {
  const model = params.model?.trim();
  if (!model || !flagship.has(normalizeTierModel(model))) return undefined;
  if (config?.model !== undefined && flagship.has(normalizeTierModel(config.model))) {
    return undefined;
  }
  if ((params.model_override_reason ?? "").trim() !== "") return undefined;
  return (
    `Spawn refused: "${model}" is a Flagship-tier model and role "${name}" declares ` +
    `${config?.model ?? "no model"}; pass model_override_reason with the profile/model-guidance.md reason, ` +
    "or choose a Workhorse/Utility model."
  );
}

export function withOverrideReason(line: string, reason: string | undefined): string {
  const trimmed = reason?.trim();
  return trimmed ? `${line} · override reason: ${trimmed}` : line;
}

export function buildModelProvenance(args: {
  model: { provider: string; id: string } | undefined;
  source: ModelSource;
  modelUnavailable: boolean;
  thinking: string | undefined;
  config: AgentConfig | undefined;
}): ModelProvenance {
  return {
    model: args.model ? `${args.model.provider}/${args.model.id}` : undefined,
    source: args.modelUnavailable ? "inherit" : args.source,
    thinking: args.thinking,
    definition: args.config?.sourcePath,
  };
}

export function formatModelLine(provenance: ModelProvenance): string {
  return (
    `Model: ${provenance.model ?? "unknown"} (source: ${provenance.source}) · ` +
    `thinking: ${provenance.thinking ?? "none"} · definition: ${provenance.definition ?? "built-in"}`
  );
}
