import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchemaOptions, type TUnsafe } from "typebox";

import { goalToolResponse, toToolText, type GoalToolResponse } from "./format.ts";
import { createGoal, replaceGoal } from "./state.ts";
import { TOOL_PROMPT_GUIDELINES } from "./prompts.ts";
import type { GoalEntrySource, GoalResult, ThreadGoal } from "./types.ts";

/** Local string-enum schema; Pi 1.5.0 pi-ai StringEnum returns a pi-schema Schema, not a TypeBox one. */
function StringEnum<const T extends readonly string[]>(
  values: T,
  options?: TSchemaOptions,
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({ ...options, type: "string", enum: [...values] });
}

const EmptyParams = Type.Object({});

const CreateGoalParams = Type.Object({
  objective: Type.String({
    description: "Concrete objective to pursue until completion.",
  }),
  token_budget: Type.Optional(
    Type.Integer({
      description:
        "Optional positive integer cumulative token cap. Omit unless the user explicitly supplied one.",
      minimum: 1,
    }),
  ),
  replace_existing: Type.Optional(
    Type.Boolean({
      description: "Replace a non-complete goal only when explicitly requested.",
    }),
  ),
});

const UpdateGoalParams = Type.Object({
  status: StringEnum(["complete"] as const, {
    description:
      "Confirmation token; only complete is accepted. Call only when no required work remains.",
  }),
});

export interface ToolHost {
  getGoal(): ThreadGoal | null;
  setGoal(goal: ThreadGoal, source: GoalEntrySource, ctx: ExtensionContext): void;
  completeGoal(source: GoalEntrySource, ctx: ExtensionContext): GoalResult;
}

function textResult(
  text: string,
  goal: ThreadGoal | null,
  includeCompletionBudgetReport = false,
): AgentToolResult<GoalToolResponse & { error: string | null }> {
  return {
    content: [{ type: "text", text }],
    details: { ...goalToolResponse(goal, includeCompletionBudgetReport), error: null },
  };
}

function throwToolError(message: string): never {
  throw new Error(message);
}

export function registerGoalTools(pi: ExtensionAPI, host: ToolHost): void {
  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Get the current Codex-style goal and usage for this pi session.",
    promptSnippet: "Inspect the current goal and usage.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: EmptyParams,
    async execute() {
      const goal = host.getGoal();
      return textResult(toToolText(goal), goal);
    },
  });

  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description: "Create a Codex-style long-running goal for this pi session.",
    promptSnippet: "Create a long-running goal for this session.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: CreateGoalParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const current = host.getGoal();
      const shouldReplaceExisting =
        params.replace_existing === true && current !== null && current.status !== "complete";
      const result = shouldReplaceExisting
        ? replaceGoal(params.objective, params.token_budget ?? null)
        : createGoal(current, params.objective, params.token_budget ?? null);
      if (!result.ok || !result.goal) {
        throwToolError(result.message);
      }
      host.setGoal(result.goal, "tool", ctx);
      return textResult(toToolText(result.goal), result.goal);
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description: "Mark the current goal complete after its objective is achieved.",
    promptSnippet: "Mark the achieved current goal complete.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: UpdateGoalParams,
    executionMode: "sequential",
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const result = host.completeGoal("tool", ctx);
      if (!result.ok || !result.goal) {
        throwToolError(result.message);
      }
      return textResult(toToolText(result.goal, true), result.goal, true);
    },
  });
}
