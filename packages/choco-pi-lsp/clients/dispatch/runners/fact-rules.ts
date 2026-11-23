import type { DispatchContext, RunnerDefinition, RunnerResult } from "../types.ts";
import { PRIORITY } from "../priorities.ts";
import { evaluateRules } from "../fact-rule-runner.ts";

const factRulesRunner: RunnerDefinition = {
  id: "fact-rules",
  appliesTo: ["jsts", "python", "go", "rust", "ruby", "shell", "cmake"],
  priority: PRIORITY.GENERAL_ANALYSIS + 1,
  enabledByDefault: true,

  async run(ctx: DispatchContext): Promise<RunnerResult> {
    const diagnostics = evaluateRules(ctx);

    if (diagnostics.length === 0) {
      return { status: "succeeded", diagnostics: [], semantic: "none" };
    }

    const hasBlocking = diagnostics.some(
      (d) => d.semantic === "blocking" || d.severity === "error",
    );

    return {
      status: hasBlocking ? "failed" : "succeeded",
      diagnostics,
      semantic: hasBlocking ? "blocking" : "warning",
    };
  },
};

export default factRulesRunner;
