import type { Api, Model } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveModel } from "../../choco-pi-subagents/src/model-resolver.ts";
import { buildAdvisorPrompt } from "./consult.ts";
import { buildAdvisorExcerpt, countAdvisorCallsThisTurn } from "./excerpt.ts";
import { resolveAdvisorManager } from "./manager-slot.ts";
import { isSameModel, sameModelDisabledMessage } from "./model-gate.ts";
import {
  registerAdvisorPreferencesProvider,
  surfaceAdvisorWriteError,
  waitForAdvisorWrites,
} from "./preferences-section.ts";
import { type AdvisorSettings, loadAdvisorSettings } from "./settings.ts";

const ADVISOR_TOOL_NAME = "advisor";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

export default function (pi: ExtensionAPI) {
  // Safe in child sessions: the advisor agent excludes this extension, so only non-advisor children register the tool.
  const agentDir = getAgentDir();
  let generation = 0;
  let active = true;
  const settingsByCwd = new Map<string, AdvisorSettings>();
  const unregister = registerAdvisorPreferencesProvider(agentDir, settingsByCwd, () => active);
  pi.on("session_shutdown", () => {
    active = false;
    generation += 1;
    unregister?.();
  });
  pi.on("session_start", async (_event, ctx) => {
    const owner = generation;
    const cwd = ctx.cwd;
    const loaded = await loadAdvisorSettings(agentDir, cwd);
    if (!active || generation !== owner) return;
    settingsByCwd.set(cwd, loaded.settings);
    if (ctx.hasUI) for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
    surfaceAdvisorWriteError(ctx);
  });
  pi.registerTool(
    defineTool({
      name: ADVISOR_TOOL_NAME,
      label: "Advisor",
      description:
        "Consult a fresh high-intelligence read-only advisor before finalizing complex multi-step plans, when verifying a hypothesis or claim that is costly to be wrong about, or when stuck after repeated failed attempts. Keep questions focused. Advisor output is advice, not evidence: verify its claims against files before acting on them.",
      parameters: Type.Object({ question: Type.String(), context: Type.Optional(Type.String()) }),
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const owner = generation;
        const cwd = ctx.cwd;
        const question = params.question;
        const context = params.context;
        const current = () => active && generation === owner;
        try {
          if (!current()) return textResult("advisor consult failed: session ended");
          await waitForAdvisorWrites();
          if (!current()) return textResult("advisor consult failed: session ended");
          surfaceAdvisorWriteError(ctx);
          const loaded = await loadAdvisorSettings(agentDir, cwd);
          if (!current()) return textResult("advisor consult failed: session ended");
          if (signal?.aborted) return textResult("advisor consult failed: aborted");
          const settings = loaded.settings;
          settingsByCwd.set(cwd, settings);
          if (ctx.hasUI) for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
          if (!settings.enabled) return textResult("advisor is disabled in /preferences");
          const entries = ctx.sessionManager.getBranch();
          if (
            settings.maxUses !== undefined &&
            countAdvisorCallsThisTurn(entries) >= settings.maxUses
          ) {
            return textResult(
              `advisor per-turn cap reached (maxUses=${settings.maxUses}); continue without a consult or raise it in /preferences`,
            );
          }
          const resolution = resolveModel(settings.model, ctx.modelRegistry);
          if (resolution.tag === "error")
            return textResult(`advisor model not available: ${settings.model}`);
          // Resolve through the typed registry after the shared resolver chooses a model.
          const selected: Model<Api> = resolution.model;
          if (isSameModel(ctx.model, selected))
            return textResult(sameModelDisabledMessage(selected));
          const model = ctx.modelRegistry.find(selected.provider, selected.id);
          if (!model) return textResult(`advisor model not available: ${settings.model}`);
          const manager = resolveAdvisorManager();
          if (!manager)
            return textResult("advisor consult failed: the subagents package is not loaded");
          const prompt = buildAdvisorPrompt(buildAdvisorExcerpt(entries), context, question);
          const id = manager.spawn(pi, ctx, "advisor", prompt, {
            description: "Advisor consult",
            model,
            thinkingLevel: settings.effort,
            isBackground: false,
            signal,
            onTextDelta: (_delta, fullText) => {
              if (current() && !signal?.aborted) onUpdate?.(textResult(fullText));
            },
          });
          onUpdate?.(textResult("advisor consult running…"));
          const record = manager.getRecord(id);
          if (!record || !(record.promise instanceof Promise))
            return textResult("advisor consult failed: missing agent record");
          await record.promise;
          const { status, result, error } = record;
          manager.disposeSettledRecord?.(id);
          if (!current()) return textResult("advisor consult failed: session ended");
          if (signal?.aborted) return textResult("advisor consult failed: aborted");
          if (status !== "completed")
            return textResult(`advisor consult failed: ${error ?? status ?? "unknown status"}`);
          return textResult(
            `${result ?? ""}\n\nadvisor: ${model.provider}/${model.id} effort=${settings.effort}`,
          );
        } catch (error) {
          return textResult(
            `advisor consult failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    }),
  );
}
