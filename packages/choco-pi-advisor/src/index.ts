import type { Api, Model } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { obj, opt, str, type Static } from "@earendil-works/pi-schema";
import { resolveModel } from "../../choco-pi-subagents/src/model-resolver.ts";
import { loadEnabledModels } from "../../choco-pi-subagents/src/enabled-models.ts";
import { buildAdvisorPrompt } from "./consult.ts";
import { buildAdvisorExcerpt, countAdvisorCallsThisTurn } from "./excerpt.ts";
import { resolveAdvisorManager } from "./manager-slot.ts";
import { loadFlagshipPrimaries, loadPreferredVariants } from "./flagship-models.ts";
import {
  registerAdvisorPreferencesProvider,
  surfaceAdvisorWriteError,
  waitForAdvisorWrites,
} from "./preferences-section.ts";
import { selectAdvisorModel } from "./select-model.ts";
import { hostParams } from "./schema-bridge.ts";
import { type AdvisorSettings, loadAdvisorSettings } from "./settings.ts";

const ADVISOR_TOOL_NAME = "advisor";
// TypeBox objects were open; keep extra keys tolerated.
const advisorParams = obj({ question: str(), context: opt(str()) }, { open: true });
type AdvisorParams = Static<typeof advisorParams>;

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
    // Both reads together: the preferences section shows only once the
    // enabled-models snapshot for this cwd exists (see preferences-section.ts).
    const [loaded] = await Promise.all([
      loadAdvisorSettings(agentDir, cwd),
      loadEnabledModels(cwd),
    ]);
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
        "Consult a fresh read-only advisor on an unproven diagnosis, a consequential plan, or final acceptance; its answer is advice, not evidence.",
      promptSnippet: "Consult a fresh read-only advisor for a focused second opinion.",
      parameters: hostParams(advisorParams),
      async execute(_toolCallId, params: AdvisorParams, signal, onUpdate, ctx) {
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
          const selection = await selectAdvisorModel(
            selected,
            ctx.model,
            ctx.modelRegistry,
            () => loadFlagshipPrimaries(),
            () => loadPreferredVariants(),
          );
          if (!current()) return textResult("advisor consult failed: session ended");
          if (selection.tag === "disabled") return textResult(selection.message);
          const switchNotice = selection.notice;
          const model = ctx.modelRegistry.find(selection.model.provider, selection.model.id);
          if (!model) return textResult(`advisor model not available: ${settings.model}`);
          const manager = resolveAdvisorManager();
          if (!manager)
            return textResult(
              "advisor consult failed: the subagents package is not loaded or cannot spawn internal agents",
            );
          const prompt = buildAdvisorPrompt(buildAdvisorExcerpt(entries), context, question);
          const id = manager.spawnInternal(pi, ctx, "advisor", prompt, {
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
            `${switchNotice ? `${switchNotice}\n` : ""}${result ?? ""}\n\nadvisor: ${model.provider}/${model.id} effort=${settings.effort}`,
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
