/**
 * Agent tool registrations.
 */
import { createSubagentLimitsTool, formatConcurrencyCap } from "../limits.ts";
import { getMaxSubagentDepth, setMaxSubagentDepth } from "../nested-tools.ts";
import { createAgentMessageTool } from "../agent-message.ts";
import { opt, str, obj, num, int, bool } from "@earendil-works/pi-schema";
import {
  getAvailableTypes,
  getAgentConfig,
  resolveSpawnType,
  resolveType,
} from "../agent-types.ts";
import {
  describeRoleModel,
  isolationParam,
  explicitModelRefusal,
  tierRefusal,
  resolveAgentInvocationConfig,
  describeModelResolution,
  buildModelProvenance,
  withOverrideReason,
  formatModelLine,
  resolveJoinMode,
} from "../invocation-config.ts";
import { type AgentSession, defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_TOOL_NAMES, normalizeMaxTurns, getDefaultMaxTurns } from "../agent-runner.ts";
import { hostParams } from "../schema-bridge.ts";
import {
  WORK_TASK_PATTERN,
  isRoundGatedRole,
  scheduleUnsupportedMessage,
} from "../review-rounds.ts";
import { thinkingLevelSchema } from "../workflow.ts";
import { isWorktreeIsolationEnabled } from "../worktree.ts";
import { delegationRenderers, buildRecordDetails, buildDetails } from "../delegation-render.ts";
import type { SubagentType, AgentRecord, AgentInvocation } from "../types.ts";
import {
  getDisplayName,
  buildInvocationTags,
  type AgentDetails,
  describeActivity,
  SPINNER,
  formatMs,
} from "../ui/agent-widget.ts";
import {
  loadFlagshipModels,
  chooseVariant,
  loadPreferredVariants,
  variantNote,
} from "../model-tiers.ts";
import { resolveModel } from "../model-resolver.ts";
import { isWithinModelScope, checkModelScope } from "../model-scope.ts";
import {
  getOutputTranscriptDefault,
  createOutputFilePath,
  writeInitialEntry,
  streamToOutputFile,
} from "../output-file.ts";
import { TERMINAL_RESULT_RETRIEVAL_GUIDANCE } from "../result-read.ts";
import { formatResetAt, describeUsageLimit } from "../usage-limit-seam.ts";
import { ResumeModelError } from "../agent-manager.ts";
import { partialOutputSuffix, getForegroundOutcomeNote } from "../status-note.ts";
import {
  type FleetPanelUIContext,
  textResult,
  createActivityTracker,
  formatLifetimeTokens,
} from "./helpers.ts";
import type { SubagentsRuntime } from "./runtime.ts";

/** Registers subagent_limits, agent_message, and the Agent tool. */
export function installAgentTools(pi: ExtensionAPI, rt: SubagentsRuntime) {
  pi.registerTool(
    createSubagentLimitsTool({
      getActiveCount: () => rt.core.manager.getActiveCount(),
      getScheduledActiveCount: () => rt.core.manager.getScheduledActiveCount(),
      getMaxConcurrent: () => rt.core.manager.getMaxConcurrent(),
      setMaxConcurrent: (value) => rt.core.manager.setMaxConcurrent(value),
      getMaxSubagentDepth,
      setMaxSubagentDepth,
    }),
  );

  pi.registerTool(createAgentMessageTool({ manager: rt.core.manager, pi }));

  // ---- Agent tool ----

  // The schedule parameter is gated on `schedulingEnabled` (read once
  // at registration; flipping the setting later requires next pi session for
  // the schema to update). Defining the shape once and spreading it via Partial
  // preserves obj()'s inference when present and produces a
  // `schedule`-free schema when absent — zero LLM-context cost in disabled mode.
  const scheduleSchemaFields = {
    schedule: opt(
      str({
        description:
          "Schedule for later; refused with run_in_background:false; incompatible with inherit_context/resume. Accepts cron, interval, +delay, or ISO.",
      }),
    ),
  };
  const scheduleParam: Partial<typeof scheduleSchemaFields> = rt.preferences.isSchedulingEnabled()
    ? scheduleSchemaFields
    : {};

  // Each type carries its declared model, thinking and definition file, so the
  // orchestrator chooses model/thinking knowing what the role (and any
  // shadowing workspace file) actually declares.
  const agentToolDescription =
    "Launch a child-safe nested subagent for bounded delegated work. Available types:\n" +
    getAvailableTypes()
      .map((name) => `- ${describeRoleModel(name, getAgentConfig(name))}`)
      .join("\n");

  // Held rather than registered inline: the mention clone reuses this exact
  // definition, so the agent it starts is an ordinary top-level spawn instead
  // of a second implementation that has to be kept in step with this one.
  const agentTool = defineTool({
    name: SUBAGENT_TOOL_NAMES.AGENT,
    label: "Agent",
    description: agentToolDescription,
    promptSnippet: "Launch a specialized subagent for a bounded task.",
    promptGuidelines: [
      "Use Agent with specialized agents when the task matches an agent type's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
      "For broad codebase exploration or research, spawn Agent with an appropriate subagent_type (e.g. Explore). Otherwise read the files yourself when the target is already known.",
      "When an agent runs in the background, you will be notified on completion — do not poll or sleep waiting for it. Continue with other work instead.",
      "Trust but verify: an agent's summary describes intent, not outcome. When an agent writes or edits code, check the actual changes before reporting work as done.",
    ],
    parameters: hostParams(
      obj(
        {
          prompt: str({
            description: "The task for the agent to perform.",
          }),
          description: str({
            description: "A short (3-5 word) description of the task (shown in UI).",
          }),
          name: opt(
            str({
              description: "Short kebab-case alias; with resume, renames the existing alias.",
            }),
          ),
          subagent_type: str({
            description: `Agent type. Available: ${getAvailableTypes().join(", ")}.`,
          }),
          model: opt(
            str({
              description:
                'Model as "provider/modelId" or a fuzzy name. Required for a fresh spawn unless requireExplicitModel is off; choose it per profile/model-guidance.md. Overrides the agent definition\'s model unless it sets model_locked. With resume: optional; a different model switches a usage-limited child first.',
            }),
          ),
          model_override_reason: opt(
            str({
              description:
                "Required when model is a Flagship-tier model and the role's declared model is not Flagship; state the model-guidance reason.",
            }),
          ),
          work_task: opt(
            str({
              pattern: WORK_TASK_PATTERN,
              description:
                "Stable id of the work task this review or verification belongs to (lowercase, digits, hyphens). Required for review roles (reviewer) and verification roles (verifier); reuse it for every round of the same task.",
            }),
          ),
          thinking: opt(
            thinkingLevelSchema(
              "Thinking level. Required for a fresh spawn unless requireExplicitModel is off. Overrides the agent definition's thinking unless it sets model_locked.",
            ),
          ),
          max_turns: opt(
            num({
              description:
                "Maximum agentic turns; applies unless the agent definition pins it. Omit for unlimited (default).",
              minimum: 1,
              maximum: Number.MAX_VALUE,
            }),
          ),
          timeout_ms: opt(
            int({
              minimum: 1,
              maximum: Number.MAX_SAFE_INTEGER,
              description: "Wall-clock run budget in milliseconds.",
            }),
          ),
          max_tool_calls: opt(
            int({
              minimum: 1,
              maximum: Number.MAX_SAFE_INTEGER,
              description: "Completed tool-call cap for this run.",
            }),
          ),
          max_tokens: opt(
            int({
              minimum: 1,
              maximum: Number.MAX_SAFE_INTEGER,
              description:
                "Omit unless the user sets a budget; the first request alone costs roughly 15–25k tokens.",
            }),
          ),
          idle_timeout_ms: opt(
            int({
              minimum: 1,
              maximum: Number.MAX_SAFE_INTEGER,
              description: "Inactivity interval before conclusion steering and watchdog stop.",
            }),
          ),
          run_in_background: opt(
            bool({
              description:
                "Default true: return an ID and notify on completion. false blocks until the agent finishes; use it only when the user asks. Applies unless the agent definition pins it.",
            }),
          ),
          resume: opt(
            str({
              description:
                "Finished agent ID to resume; name optionally renames its alias; model switches it first (continue a usage-limited child on another model).",
            }),
          ),
          isolated: opt(
            bool({
              description:
                "If true, agent gets no extension/MCP tools — only built-in tools. Applies unless the agent definition pins it.",
            }),
          ),
          inherit_context: opt(
            bool({
              description:
                "If true, fork parent conversation into the agent. Default: false (fresh context). Applies unless the agent definition pins it.",
            }),
          ),
          fast_mode: opt(
            bool({
              description: "Request fast mode for this run; defaults to the parent request.",
            }),
          ),
          daybreak: opt(
            bool({
              description: "Request Daybreak for this run; defaults to the parent request.",
            }),
          ),
          ...isolationParam(isWorktreeIsolationEnabled()),
          ...scheduleParam,
        },
        { open: true },
      ),
    ),

    // ---- Custom rendering: Claude Code style ----

    renderCall: delegationRenderers.renderCall,
    renderResult: delegationRenderers.renderResult,

    // ---- Execute ----

    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      // SAFETY: Pi's UI context implements the FleetPanel UI surface consumed here.
      const fleetContext = ctx as FleetPanelUIContext;
      rt.views.fleet.setUICtx(fleetContext.ui);

      // Reload custom agents so new project/global .md files are picked up without restart
      if (!(await rt.revival.refreshAgentsForSession())) {
        return textResult(
          "Session changed while agent definitions were loading; nothing was started.",
        );
      }

      const rawType: SubagentType = params.subagent_type;
      // Single decision point for dispatch (#183): unknown, disabled and
      // case-ambiguous types are refused here, BEFORE anything spawns, so a
      // background or scheduled call can't start running the wrong agent while
      // the caller is still unaware. `fallbackSubagent` decides whether an
      // unresolvable type falls back or fails closed.
      const dispatch = resolveSpawnType(rawType);
      // `resume` replays a stored session and ignores `subagent_type` entirely,
      // but the parameter is required by the schema — so gating it here would
      // make a live agent unresumable the moment its type is deleted, disabled,
      // or gains a case-clashing sibling. Only a real spawn is gated.
      if (!dispatch.ok && !params.resume) return textResult(dispatch.message);
      const subagentType = dispatch.ok ? dispatch.type : rawType;
      // What the caller actually asked for, named once: `fellBackFrom` is "" for
      // a blank request, so reading it inline invites the `??`-vs-`||` slip that
      // once persisted an empty type into a scheduled job.
      const requestedType = (dispatch.ok && dispatch.fellBackFrom) || subagentType;
      // Computed at resolution rather than after the run, so the background and
      // schedule branches carry it too — previously it existed only on the
      // foreground path. Resume deliberately doesn't: it replays the stored
      // session and ignores `subagent_type` entirely, so a note about type
      // substitution would be describing something that didn't happen.
      const typeNote =
        dispatch.ok && dispatch.fellBackFrom !== undefined
          ? `Note: Unknown agent type "${dispatch.fellBackFrom}" — using ${resolveType(subagentType) ? subagentType : "the fallback agent config"}.\n\n`
          : "";

      const displayName = getDisplayName(subagentType);

      // Get agent config (if any)
      const customConfig = getAgentConfig(subagentType);

      // requireExplicitModel: a fresh spawn names its model and thinking.
      // Resume and schedule are exempt (they continue or defer, not choose).
      if (!params.resume && !params.schedule) {
        const refusal = explicitModelRefusal(subagentType, customConfig, params);
        if (refusal !== undefined) return textResult(typeNote + refusal);
        const tier = tierRefusal(subagentType, customConfig, params, await loadFlagshipModels());
        if (tier !== undefined) return textResult(typeNote + tier);
      }

      const resolvedConfig = resolveAgentInvocationConfig(customConfig, params, {
        worktreeAllowed: isWorktreeIsolationEnabled(),
        defaultRunInBackground: true,
      });
      // SAFETY: choco-pi-hooks adds this internal member in PreToolUse only after a successful WorktreeCreate hook.
      const hookWorktreePath = (
        params as typeof params & {
          __choco_hook_worktree_path?: string;
        }
      ).__choco_hook_worktree_path;

      // Resolve the model chosen by invocation-config: caller first, then the
      // role default, unless the role sets model_locked.
      let model = ctx.model;
      let modelUnavailable = false;
      let preferredNote = "";
      if (resolvedConfig.modelInput) {
        const resolution = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
        switch (resolution.tag) {
          case "error":
            if (resolvedConfig.modelFromParams) return textResult(resolution.message);
            // config-specified: fall back to the parent, but say so — the
            // result note and toast below are the only trace of this.
            modelUnavailable = true;
            break;
          case "resolved": {
            // Routing prefers the access-program variant (Fable -> Mythos) the account can use.
            const choice = chooseVariant(
              resolution.model,
              await loadPreferredVariants(),
              ctx.modelRegistry,
              (candidate) => isWithinModelScope(candidate, ctx.cwd, ctx.modelRegistry),
            );
            model = choice.model;
            preferredNote = variantNote(choice);
            break;
          }
        }
      }
      const modelNote = describeModelResolution({
        agentLabel: customConfig?.displayName ?? subagentType,
        resolved: resolvedConfig,
        modelUnavailable,
        parentModel: ctx.model,
      });
      if (modelUnavailable) ctx.ui.notify(modelNote.trim(), "warning");
      const fallbackNote = typeNote + modelNote + preferredNote;

      // Scope validation: the effective resolved model is checked against the
      // user's enabledModels list. Policy (hard error vs warn-and-proceed) lives
      // in model-scope.ts so the nested delegation tools apply the same rule.
      const scopeVerdict = checkModelScope({
        model,
        cwd: ctx.cwd,
        modelRegistry: ctx.modelRegistry,
        callerSupplied: resolvedConfig.callerOverridesRoleModel,
        agentLabel: customConfig?.displayName ?? subagentType,
        modelInput: resolvedConfig.modelInput,
      });
      if (scopeVerdict.kind === "error") return textResult(scopeVerdict.message);
      if (scopeVerdict.kind === "warn") ctx.ui.notify(scopeVerdict.message, "warning");

      const thinking = resolvedConfig.thinking;
      const modelProvenance = buildModelProvenance({
        model,
        source: resolvedConfig.modelSource,
        modelUnavailable,
        thinking,
        config: customConfig,
      });
      const modelLine = `${withOverrideReason(formatModelLine(modelProvenance), params.model_override_reason)}\n`;
      // A synchronous start failure deletes the record before the throw
      // propagates; journal its identity first so the failure is traceable.
      const onStartFailed = (info: { id: string; alias?: string; reason: string }): void => {
        pi.appendEntry("subagents:record", {
          id: info.id,
          ...(info.alias && { alias: info.alias }),
          type: subagentType,
          description: params.description,
          status: "error",
          error: info.reason,
          startFailed: true,
          modelProvenance,
          modelLine: formatModelLine(modelProvenance),
        });
      };
      const inheritContext = resolvedConfig.inheritContext;
      const runInBackground = resolvedConfig.runInBackground;
      const isolated = resolvedConfig.isolated;
      const isolation = resolvedConfig.isolation;
      // Whether this spawn writes its .output transcript. Per-agent
      // frontmatter (`output_transcript`) wins; otherwise the project/global
      // default applies. `attachTranscript` below is the SOLE gate — every
      // downstream consumer keys off record.outputFile being set, so no spawn
      // path can re-enable the transcript by accident.
      const outputTranscript = customConfig?.outputTranscript ?? getOutputTranscriptDefault();
      const attachTranscript = (rec: AgentRecord | undefined, agentId: string): void => {
        if (!rec || !outputTranscript) return;
        rec.outputFile = createOutputFilePath(ctx.cwd, agentId, ctx.sessionManager.getSessionId());
        writeInitialEntry(rec.outputFile, agentId, params.prompt, ctx.cwd);
      };

      const parentModelId = ctx.model?.id;
      const effectiveModelId = model?.id;
      const modelName =
        effectiveModelId && effectiveModelId !== parentModelId
          ? (model?.name ?? effectiveModelId).replace(/^Claude\s+/i, "").toLowerCase()
          : undefined;
      const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? getDefaultMaxTurns());
      const budgets = {
        timeoutMs: resolvedConfig.timeoutMs,
        maxToolCalls: resolvedConfig.maxToolCalls,
        maxTokens: resolvedConfig.maxTokens,
        idleTimeoutMs: resolvedConfig.idleTimeoutMs,
      };
      const agentInvocation: AgentInvocation = {
        modelName,
        thinking,
        // Explicit value only — the default fallback would just add noise.
        // Normalize so `0` (unlimited) doesn't surface as a misleading "max turns: 0".
        maxTurns: normalizeMaxTurns(resolvedConfig.maxTurns),
        timeoutMs: resolvedConfig.timeoutMs,
        maxToolCalls: resolvedConfig.maxToolCalls,
        maxTokens: resolvedConfig.maxTokens,
        idleTimeoutMs: resolvedConfig.idleTimeoutMs,
        isolated,
        inheritContext,
        runInBackground,
        isolation,
        fastMode: resolvedConfig.fastMode,
        daybreak: resolvedConfig.daybreak,
      };
      const { tags: invocationTags } = buildInvocationTags(agentInvocation);
      const detailBase = {
        displayName,
        description: params.description,
        subagentType,
        modelName,
        tags: invocationTags.length > 0 ? invocationTags : undefined,
      };

      // ---- Schedule: register a job, don't spawn now ----
      if (params.schedule) {
        if (isRoundGatedRole(subagentType)) {
          return textResult(scheduleUnsupportedMessage(subagentType));
        }
        if (!rt.preferences.isSchedulingEnabled()) {
          return textResult(
            "Scheduling is disabled in this project. Enable via /agents → Settings → Scheduling.",
          );
        }
        if (params.resume) {
          return textResult(
            "Cannot combine `schedule` with `resume` — schedules create fresh agents.",
          );
        }
        if (params.inherit_context) {
          return textResult(
            "Cannot combine `schedule` with `inherit_context` — there is no parent conversation at fire time.",
          );
        }
        if (params.run_in_background === false) {
          return textResult(
            "Cannot combine `schedule` with `run_in_background: false` — scheduled jobs always run in background.",
          );
        }
        // session_start loads the store in the background; wait for that load
        // rather than refusing a schedule that arrives while it is in flight.
        const starting = rt.state.schedulerStarting;
        if (!rt.scheduling.scheduler.isActive() && starting !== undefined) await starting;
        if (!rt.scheduling.scheduler.isActive()) {
          return textResult(
            "Scheduler is not active in this session yet. Try again after the session has fully started.",
          );
        }
        try {
          // SAFETY: The Agent tool schema validates model as an optional string before execute runs.
          const job = await rt.scheduling.scheduler.addJob({
            name: params.description,
            description: params.description,
            schedule: params.schedule as string,
            // The caller's own name, not the substitute — the scheduler re-resolves
            // at fire time, and the original is what a user edits.
            subagent_type: requestedType,
            prompt: params.prompt,
            model: params.model as string | undefined,
            thinking: thinking,
            max_turns: effectiveMaxTurns,
            timeout_ms: resolvedConfig.timeoutMs,
            max_tool_calls: resolvedConfig.maxToolCalls,
            max_tokens: resolvedConfig.maxTokens,
            idle_timeout_ms: resolvedConfig.idleTimeoutMs,
            isolated: isolated,
            isolation: isolation,
            fast_mode: resolvedConfig.fastMode,
            daybreak: resolvedConfig.daybreak,
          });
          const next = rt.scheduling.scheduler.getNextRun(job.id);
          return textResult(
            `${fallbackNote}Scheduled "${job.name}" (id: ${job.id}, type: ${job.scheduleType}). ` +
              `Next run: ${next ?? "(unknown)"}. ` +
              `Manage via /agents → Scheduled jobs.`,
          );
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err));
        }
      }

      // Resume existing agent
      if (params.resume) {
        let existing = rt.core.manager.getRecord(params.resume);
        // A settled journaled record without a session (a re-armed usage wait
        // that was stopped) continues from its saved file like a dormant one.
        if (
          existing !== undefined &&
          existing.parentAgentId === undefined &&
          existing.session === undefined &&
          existing.sessionFile !== undefined &&
          rt.state.journalActive &&
          rt.core.manager.disposeSettledRecord(existing.id)
        ) {
          existing = undefined;
        }
        if (!existing) {
          const dormant = rt.revival.findTopLevelDormant(params.resume);
          if (dormant !== undefined) {
            return rt.revival.resumeDormantFromTool(
              ctx,
              dormant,
              params.prompt,
              // Same rule as a live resume: only a caller-supplied model switches.
              resolvedConfig.modelFromParams && model ? `${model.provider}/${model.id}` : undefined,
              toolCallId,
              params.work_task,
            );
          }
        }
        if (!existing || existing.parentAgentId) {
          return textResult(`Agent not found: "${params.resume}".`);
        }
        // Keep this caller-facing check mode-independent. AgentManager.resume
        // repeats the guard at the causal boundary so a concurrent state change
        // still cannot re-enter the live record or rename it.
        if (existing.status === "running" || existing.status === "queued") {
          return textResult(
            `Agent "${params.resume}" is still ${existing.status} — it can only be resumed once its current run finishes.\n` +
              `${TERMINAL_RESULT_RETRIEVAL_GUIDANCE} Use steer_subagent to send it a message mid-run.`,
          );
        }
        if (existing.status === "waiting_for_reset") {
          return textResult(
            `Agent "${params.resume}" is paused until its provider usage window resets ` +
              `(${formatResetAt(existing.usageLimit?.resetAt)}) and will resume on its own. ` +
              `To continue it on another model now, stop it with stop_subagent, then resume it with model.`,
          );
        }
        if (!existing.session) {
          return textResult(`Agent "${params.resume}" has no active session to resume.`);
        }
        // Only a caller-supplied model switches the resumed session; an agent
        // file's default model never overrides the model the child already has.
        const resumeModel =
          resolvedConfig.modelFromParams && model ? `${model.provider}/${model.id}` : undefined;
        // Resuming a review-role agent is a new review round: admit it first.
        const resumeAdmission = await rt.registry.admitReviewRound(
          ctx,
          existing.type,
          params.work_task,
          "agent-resume",
        );
        if (resumeAdmission.kind === "refused") return textResult(resumeAdmission.message);
        const resumeTicket = rt.registry.ticketOf(resumeAdmission);
        const resumeNotice = rt.registry.noticeOf(resumeAdmission);

        // Background resume: detached run that notifies on completion, mirroring
        // a background spawn. Previously run_in_background was silently ignored
        // on resume (this branch returned before the background branch below),
        // so a resumed agent always blocked the main loop until it finished.
        if (runInBackground) {
          const id = existing.id;
          let record: AgentRecord | undefined;
          try {
            record = await rt.background.startBackgroundResume(ctx, existing, params.prompt, {
              reviewTicket: resumeTicket,
              outputTranscript,
              maxTurns: params.max_turns,
              toolCallId,
              name: params.name,
              model: resumeModel,
              fastModeRequested: params.fast_mode,
              daybreakRequested: params.daybreak,
              budgets,
            });
          } catch (error) {
            if (error instanceof ResumeModelError) {
              return textResult(`Failed to resume agent "${params.resume}": ${error.message}`);
            }
            throw error;
          }
          if (!record) {
            return textResult(`${resumeNotice}Failed to resume agent "${params.resume}".`);
          }

          const isQueued = record.status === "queued";
          const address = record.alias ?? record.handle ?? record.id;
          return textResult(
            `${resumeNotice}Agent ${isQueued ? "queued" : "resumed"} in background.\n` +
              `Agent ID: ${id}\n` +
              `Alias: @${address}\n` +
              `Type: ${existing.type}\n` +
              (record.outputFile ? `Output file: ${record.outputFile}\n` : "") +
              (isQueued
                ? `Position: queued (cap ${formatConcurrencyCap(rt.core.manager.getMaxConcurrent())})\n`
                : "") +
              `\nYou will be notified when this agent completes.\n` +
              `${TERMINAL_RESULT_RETRIEVAL_GUIDANCE} Use steer_subagent to send it messages.`,
            buildRecordDetails(record, true, true),
          );
        }

        let record: AgentRecord | undefined;
        try {
          record = await rt.core.manager.resume(params.resume, params.prompt, signal, {
            reviewTicket: resumeTicket,
            maxTurns: params.max_turns,
            name: params.name,
            model: resumeModel,
            fastModeRequested: params.fast_mode,
            daybreakRequested: params.daybreak,
            budgets,
          });
        } catch (error) {
          if (error instanceof ResumeModelError) {
            // Refused before any run started: refund the round.
            if (resumeTicket !== undefined) await rt.registry.reviewRounds.release(resumeTicket);
            return textResult(`Failed to resume agent "${params.resume}": ${error.message}`);
          }
          throw error;
        }
        if (!record) {
          if (resumeTicket !== undefined) await rt.registry.reviewRounds.release(resumeTicket);
          return textResult(`Failed to resume agent "${params.resume}".`);
        }
        const address = record.alias ?? record.handle ?? record.id;
        // Parked on a usage limit under auto-resume: the manager converted this
        // resume to background, so answer now, exactly like a foreground spawn.
        if (record.status === "waiting_for_reset") {
          const until =
            record.usageLimit?.resetAt === undefined
              ? "the provider reports capacity again (reset time unknown)"
              : formatResetAt(record.usageLimit.resetAt);
          return textResult(
            `${resumeNotice}Agent alias: @${address}\nAgent paused until ${until}; result will arrive as a notification.\n` +
              `Agent ID: ${record.id}\n` +
              (record.usageLimit ? `Usage limit: ${describeUsageLimit(record.usageLimit)}\n` : "") +
              `It resumes on the same model after the reset. ${TERMINAL_RESULT_RETRIEVAL_GUIDANCE}`,
            buildRecordDetails(record, false, true),
          );
        }
        // A failed resume surfaces the error, plus any partial output THIS
        // resume produced (never the previous turn's answer, #144).
        if (
          record.status === "error" ||
          record.status === "budget_exceeded" ||
          record.status === "watchdog_stopped"
        ) {
          return textResult(
            `${resumeNotice}Agent alias: @${address}\nAgent failed: ${record.error}${partialOutputSuffix(record)}`,
            buildRecordDetails(record, false, true),
          );
        }
        return textResult(
          `${resumeNotice}Agent alias: @${address}\n\n${record.result?.trim() || "No output."}`,
          buildRecordDetails(record, false, true),
        );
      }

      // A stored usage-limit closure on the target provider is re-checked
      // against live evidence before spawn's synchronous gate reads it.
      await rt.core.manager.refreshProviderBlock(
        model?.provider ?? ctx.model?.provider ?? "unknown",
        ctx.sessionManager.getSessionId(),
        model !== undefined ? model.id : ctx.model?.id,
      );

      // Review roles: reserve a round (or refuse) after every other early return
      // and immediately before the manager call.
      const admission = await rt.registry.admitReviewRound(
        ctx,
        subagentType,
        params.work_task,
        "agent",
      );
      if (admission.kind === "refused") return textResult(admission.message);
      const reviewTicket = rt.registry.ticketOf(admission);
      const reviewNotice = rt.registry.noticeOf(admission);

      // Background execution
      if (runInBackground) {
        const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(effectiveMaxTurns);

        // Wrap onSessionCreated to wire output file streaming.
        // The callback lazily reads record.outputFile (set right after spawn)
        // rather than closing over a value that doesn't exist yet.
        let id: string;
        const origBgOnSession = bgCallbacks.onSessionCreated;
        bgCallbacks.onSessionCreated = (session: AgentSession) => {
          origBgOnSession(session);
          const rec = rt.core.manager.getRecord(id);
          if (rec?.outputFile) {
            rec.outputCleanup = streamToOutputFile(session, rec.outputFile, id, ctx.cwd);
          }
        };

        // A throw here means the agent never started. Let it out: pi marks a
        // tool call failed only when execute throws, and a returned message
        // reads to the model as a subagent that ran and reported this (#179).
        try {
          id = rt.core.manager.spawn(pi, ctx, subagentType, params.prompt, {
            reviewTicket,
            description: params.description,
            name: params.name,
            model,
            maxTurns: effectiveMaxTurns,
            budgets,
            isolated,
            inheritContext,
            thinkingLevel: thinking,
            fastModeRequested: resolvedConfig.fastMode,
            daybreakRequested: resolvedConfig.daybreak,
            isBackground: true,
            isolation,
            hookWorktreePath,
            invocation: agentInvocation,
            modelProvenance,
            onStartFailed,
            rootSessionId: ctx.sessionManager.getSessionId(),
            ...bgCallbacks,
          });
        } catch (error) {
          // spawn() throws only before an agent exists: refund the round.
          if (reviewTicket !== undefined) await rt.registry.reviewRounds.release(reviewTicket);
          throw error;
        }

        // Set output file + join mode synchronously after spawn, before the
        // event loop yields — onSessionCreated is async so this is safe.
        const joinMode = resolveJoinMode(rt.state.defaultJoinMode, true);
        const record = rt.core.manager.getRecord(id);
        if (record && joinMode) {
          record.joinMode = joinMode;
          record.toolCallId = toolCallId;
          attachTranscript(record, id);
        }

        if (joinMode == null || joinMode === "async") {
          // Foreground/no join mode or explicit async — not part of any batch
        } else {
          // smart or group — add to current batch
          rt.state.currentBatchAgents.push({ id, joinMode });
          // Debounce: reset timer on each new agent so parallel tool calls
          // dispatched across multiple event loop ticks are captured together
          if (rt.state.batchFinalizeTimer) clearTimeout(rt.state.batchFinalizeTimer);
          rt.state.batchFinalizeTimer = setTimeout(rt.background.finalizeBatch, 100);
        }

        rt.agentActivity.set(id, bgState);
        rt.views.fleet.ensureTimer();
        rt.views.fleet.update();

        // Emit created event
        rt.notifications.emitLifecycle("subagents:created", {
          id,
          type: subagentType,
          description: params.description,
          isBackground: true,
        });

        const isQueued = record?.status === "queued";
        return textResult(
          `${reviewNotice}${fallbackNote}Agent ${isQueued ? "queued" : "started"} in background.\n` +
            `Agent ID: ${id}\n` +
            `Type: ${displayName}\n` +
            `Description: ${params.description}\n` +
            modelLine +
            (record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
            (isQueued
              ? `Position: queued (cap ${formatConcurrencyCap(rt.core.manager.getMaxConcurrent())})\n`
              : "") +
            `\nYou will be notified when this agent completes.\n` +
            `${TERMINAL_RESULT_RETRIEVAL_GUIDANCE} Use steer_subagent to send it messages.\n` +
            `Do not duplicate this agent's work.`,
          record
            ? buildRecordDetails(record, true)
            : {
                ...detailBase,
                toolUses: 0,
                tokens: "",
                durationMs: 0,
                status: "background",
                agentId: id,
              },
        );
      }

      // Foreground (synchronous) execution — stream progress via onUpdate
      let spinnerFrame = 0;
      const startedAt = Date.now();
      let fgId: string | undefined;

      const streamUpdate = () => {
        const details: AgentDetails = {
          ...detailBase,
          toolUses: fgState.toolUses,
          tokens: formatLifetimeTokens(fgState),
          turnCount: fgState.turnCount,
          maxTurns: fgState.maxTurns,
          durationMs: Date.now() - startedAt,
          status: "running",
          activity: describeActivity(fgState.activeTools, fgState.responseText),
          spinnerFrame: spinnerFrame % SPINNER.length,
        };
        onUpdate?.({
          content: [{ type: "text", text: `${fgState.toolUses} tool uses...` }],
          details,
        });
      };

      const { state: fgState, callbacks: fgCallbacks } = createActivityTracker(
        effectiveMaxTurns,
        streamUpdate,
      );

      // Wire session creation: register in widget + stream to output file.
      // The output file path is set synchronously after spawn (below),
      // before onSessionCreated fires — same pattern as background agents.
      const origOnSession = fgCallbacks.onSessionCreated;
      fgCallbacks.onSessionCreated = (session: AgentSession) => {
        origOnSession(session);
        for (const a of rt.core.manager.listAgents()) {
          if (a.session === session) {
            fgId = a.id;
            rt.agentActivity.set(a.id, fgState);
            rt.views.fleet.ensureTimer();
            rt.views.fleet.update();
            break;
          }
        }
        // Stream conversation to output file (foreground agent logging)
        if (fgId) {
          const rec = rt.core.manager.getRecord(fgId);
          if (rec?.outputFile) {
            rec.outputCleanup = streamToOutputFile(session, rec.outputFile, fgId, ctx.cwd);
          }
        }
      };

      // Animate spinner at ~80ms (smooth rotation through 10 braille frames)
      const spinnerInterval = setInterval(() => {
        spinnerFrame++;
        streamUpdate();
      }, 80);

      streamUpdate();

      let record: AgentRecord;
      let fgSpawned = false;
      try {
        const fgResult = await rt.core.manager.spawnAndWait(
          pi,
          ctx,
          subagentType,
          params.prompt,
          {
            reviewTicket,
            description: params.description,
            name: params.name,
            model,
            maxTurns: effectiveMaxTurns,
            budgets,
            isolated,
            inheritContext,
            thinkingLevel: thinking,
            fastModeRequested: resolvedConfig.fastMode,
            daybreakRequested: resolvedConfig.daybreak,
            isolation,
            hookWorktreePath,
            invocation: agentInvocation,
            modelProvenance,
            onStartFailed,
            signal,
            rootSessionId: ctx.sessionManager.getSessionId(),
            ...fgCallbacks,
          },
          (fgAgentId) => {
            // onSpawned: called synchronously after spawn, before onSessionCreated fires.
            // Set up the output file so streamToOutputFile can pick it up.
            fgSpawned = true;
            const fgRec = rt.core.manager.getRecord(fgAgentId);
            attachTranscript(fgRec, fgAgentId);
          },
        );
        record = fgResult.record;
      } catch (error) {
        // No agent was created: refund the round. Once spawned, the round stays counted.
        if (!fgSpawned && reviewTicket !== undefined)
          await rt.registry.reviewRounds.release(reviewTicket);
        throw error;
      } finally {
        // Runs on both paths, so a startup throw — which now propagates, see
        // the background spawn above (#179) — no longer leaves the spinner
        // ticking or a finished agent on the widget.
        clearInterval(spinnerInterval);
        if (fgId) {
          rt.agentActivity.delete(fgId);
          rt.views.fleet.markFinished(fgId);
          rt.views.fleet.onAgentFinished(fgId);
        }
      }

      // Get final token count
      const tokenText = formatLifetimeTokens(fgState);

      const details = buildDetails(detailBase, record, fgState, { tokens: tokenText });
      // The session existed by now and may have clamped the requested
      // thinking; report the record's refreshed provenance, not the request.
      const settledModelLine = record.modelProvenance
        ? `${formatModelLine(record.modelProvenance)}\n`
        : modelLine;

      // Parked on a provider usage limit under auto-resume: the manager has
      // converted this child to background, so answer the tool call now.
      if (record.status === "waiting_for_reset") {
        const address = record.alias ?? record.handle ?? record.id;
        const until =
          record.usageLimit?.resetAt === undefined
            ? "the provider reports capacity again (reset time unknown)"
            : formatResetAt(record.usageLimit.resetAt);
        return textResult(
          `${reviewNotice}${fallbackNote}Agent paused until ${until}; result will arrive as a notification.\n` +
            `Agent ID: ${record.id}\n` +
            `Alias: @${address}\n` +
            settledModelLine +
            (record.usageLimit ? `Usage limit: ${describeUsageLimit(record.usageLimit)}\n` : "") +
            `It resumes on the same model after the reset. ${TERMINAL_RESULT_RETRIEVAL_GUIDANCE}`,
          details,
        );
      }

      if (
        record.status === "error" ||
        record.status === "budget_exceeded" ||
        record.status === "watchdog_stopped"
      ) {
        // Error headline + any partial output the run produced before failing.
        return textResult(
          `${reviewNotice}${fallbackNote}${settledModelLine}Agent failed: ${record.error}${partialOutputSuffix(record)}`,
          details,
        );
      }

      const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
      const statsParts = [`${record.toolUses} tool uses`];
      if (tokenText) statsParts.push(tokenText);
      return textResult(
        `${reviewNotice}${fallbackNote}${settledModelLine}Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getForegroundOutcomeNote(record.status)}.\n\n` +
          (record.result?.trim() || "No output."),
        details,
      );
    },
  });
  pi.registerTool(agentTool);

  return { agentTool };
}
