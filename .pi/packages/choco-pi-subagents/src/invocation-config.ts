import { Type } from "typebox";
import type {
  AgentConfig,
  IsolationMode,
  JoinMode,
  ModelProvenance,
  ModelSource,
  ThinkingLevel,
} from "./types.ts";

/**
 * When true (the default), a fresh spawn through the Agent tool or the nested
 * Agent tool must name both `model` and `thinking`; omitting either returns a
 * refusal instead of silently running on a role default or the parent model.
 * Resume, /btw forks, cross-extension RPC, schedules and workflow steps are
 * exempt. Module state (like `scopeModels`) so the nested tools see it too.
 */
let requireExplicitModel = true;

export function isRequireExplicitModel(): boolean {
  return requireExplicitModel;
}
export function setRequireExplicitModel(enabled: boolean): void {
  requireExplicitModel = enabled;
}

/**
 * The model-facing `isolation` parameter, shared by the `Agent` tool and the
 * nested delegation tool so the two cannot drift.
 *
 * Shape matters more than wording here. As a single-value optional literal,
 * models that fill every optional parameter — the transcript on #231 shows one
 * emitting `resume: ""`, `schedule: ""` and `model: "default"` alongside it —
 * had only `"worktree"` available to fill it with, and kept spawning worktrees
 * across three turns while their own reasoning said to omit the field. Every
 * other optional parameter has an inert filler; this one did not. `"off"` is
 * listed first and described as the default so the harmless value is the
 * obvious one to reach for.
 *
 * The wording tracks Claude Code's own `isolation` parameter, whose phrasing
 * models have the most exposure to: one description on the union rather than
 * per-value ones, opening "Isolation mode.", then a sentence per value in
 * schema order, each with its caveats in a trailing parenthetical. Two clauses
 * are ours, because our shape is not theirs — `"off"` has no counterpart there
 * (their enum is `worktree | remote`, so both of their values do something),
 * and neither does the uncommitted-work warning, which is the specific trap
 * #231 fell into. Deliberately absent is any "only use a worktree when…"
 * restriction: Claude Code's `Agent` tool states the capability and stops, and
 * a second legal value is what lets a model decline one, not being told to.
 */
const isolationSchemaFields = {
  isolation: Type.Optional(
    Type.Union([Type.Literal("off"), Type.Literal("worktree")], {
      description:
        '"off" uses this checkout; "worktree" creates an isolated temporary copy. Applies unless the agent definition pins it.',
    }),
  ),
};

/**
 * Build the `isolation` parameter for a tool schema, or nothing when the
 * project disabled worktrees (`worktreeIsolation: false`).
 *
 * Dropping the field beats accepting it and quietly downgrading. The setting is
 * for a project whose model passes `"worktree"` on *every* call, so a
 * per-result "isolation was disabled" note would be noise on every result and
 * would keep raising the salience of a capability that isn't there. With no
 * field there is nothing to pass, nothing to drop, and nothing to explain — the
 * same trade `scheduleParam` makes for disabled scheduling, at zero LLM-context
 * cost. The resolver gate and the `agent-manager` check still cover the paths a
 * schema can't reach: agent files, the scheduler, and cross-extension RPC.
 *
 * Like `scheduleParam`, this is read once at tool registration — flipping the
 * setting needs a new pi session for the schema to change.
 */
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
  /**
   * Untyped on purpose. Both tool schemas now build this field conditionally
   * and spread it, which erases TypeBox's literal inference to `unknown` (the
   * `schedule` param has the same shape). The resolver below narrows by
   * comparison rather than trusting the declaration, which also makes it safe
   * for the cross-extension RPC path, where options arrive unvalidated.
   */
  isolation?: unknown;
}

/** Where the effective model string came from; "inherit" means the parent runtime. */
export type ModelInputSource = ModelSource;

/** Caller fields a frontmatter pin overrode. */
export type OverriddenCallerField = "model" | "thinking";

interface ResolvedAgentInvocationConfig {
  modelInput?: string;
  modelFromParams: boolean;
  /** "inherit" when nothing chose a model and the parent runtime applies. */
  modelSource: ModelInputSource;
  /**
   * True only when the caller's model is in effect AND differs from the role's
   * declared model. Scope policy treats a caller echoing the role's own model
   * as the role's choice (warn-and-proceed), not as a runtime override.
   */
  callerOverridesRoleModel: boolean;
  /**
   * Caller-supplied fields a `model_locked` agent definition discarded. Spawn
   * paths report these so an orchestrator learns its override did not apply
   * instead of assuming it did.
   */
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
  /**
   * Run mode when neither the agent file nor the caller chooses one. The
   * top-level Agent tool defaults to background; nested spawns stay foreground
   * because a settled parent aborts the children it owns.
   */
  defaultRunInBackground?: boolean;
  /**
   * Whether worktree isolation is permitted at all. False when the project set
   * `worktreeIsolation: false`, which drops a requested worktree rather than
   * failing the call: the fail-loud precedent covers spawns that *cannot* work,
   * while this one is the user opting out, and throwing would break exactly the
   * calls the `"off"` value exists to tolerate. Defaults to allowed.
   */
  worktreeAllowed?: boolean;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
  opts?: ResolveOptions,
): ResolvedAgentInvocationConfig {
  // Precedence first, collapse second — reversing these loses the veto, since
  // an agent file's "off" only outranks a caller's "worktree" while it is still
  // a value. Everything downstream then sees "worktree" or nothing at all.
  const requested = agentConfig?.isolation ?? params.isolation;
  const isolation =
    requested === "worktree" && opts?.worktreeAllowed !== false ? "worktree" : undefined;

  // Frontmatter model/thinking are overridable defaults; `model_locked` makes
  // them pins that outrank the caller.
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

/**
 * Notes a spawn result carries about model and effort resolution. Both the
 * top-level Agent tool and the nested delegation tool prepend these, so an
 * orchestrator learns when its override was discarded by a frontmatter pin or
 * when the agent definition's model was unavailable and the parent runtime ran
 * instead. Without them both outcomes are silent and indistinguishable from the
 * requested one.
 */
export function describeModelResolution(args: {
  agentLabel: string;
  resolved: Pick<
    ResolvedAgentInvocationConfig,
    "modelInput" | "modelSource" | "overriddenCallerFields"
  >;
  /** True when `modelInput` failed to resolve and the parent model runs. */
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

/** `provider/id, thinking, definition` facts a role file declares. */
function roleFacts(config: AgentConfig | undefined) {
  return {
    definition: config?.sourcePath ?? "built-in",
    model: config?.model ?? "none",
    thinking: config?.thinking ?? "none",
  };
}

/**
 * One-line role summary for tool descriptions and `/agents`: what the role
 * declares and where it was loaded from, so a shadowing definition is visible.
 */
export function describeRoleModel(name: string, config: AgentConfig | undefined): string {
  return `${name}: ${describeRoleDeclaration(config)}`;
}

/** `model …, thinking …, definition …` for one role, without its name. */
export function describeRoleDeclaration(config: AgentConfig | undefined): string {
  const facts = roleFacts(config);
  const lock = config?.modelLocked === true ? " (locked)" : "";
  return `model ${facts.model}${lock}, thinking ${facts.thinking}, definition ${facts.definition}`;
}

/**
 * The `requireExplicitModel` refusal, or undefined when the spawn may proceed.
 * Callers apply it to fresh spawns only — resume, /btw, RPC, schedules and
 * workflow steps are exempt by never calling it.
 */
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
    : "choose them from .pi/model-guidance.md for this role and record the reason.";
  return (
    `Spawn refused: pass model and thinking. Role "${name}" (${facts.definition}) declares model ` +
    `${facts.model}, thinking ${facts.thinking}; ${advice}`
  );
}

/**
 * Provenance for the effective spawn model. An unavailable configured model
 * runs on the parent, so it reports `inherit` — the line names what ran.
 */
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

/** `Model: provider/id (source: …) · thinking: … · definition: …` */
export function formatModelLine(provenance: ModelProvenance): string {
  return (
    `Model: ${provenance.model ?? "unknown"} (source: ${provenance.source}) · ` +
    `thinking: ${provenance.thinking ?? "none"} · definition: ${provenance.definition ?? "built-in"}`
  );
}
