import { getAvailableTypes, getAgentConfig } from "../agent-types.ts";
import {
  type AgentSession,
  type ExtensionContext,
  defineTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  type WorkflowStepDefinition,
  type WorkflowStepRunner,
  WorkflowDefinitionSchema,
  WorkflowStepSchema,
} from "../workflow.ts";
import { resolveAgentInvocationConfig } from "../invocation-config.ts";
import { isWorktreeIsolationEnabled } from "../worktree.ts";
import { resolveModel } from "../model-resolver.ts";
import { chooseVariant, loadPreferredVariants } from "../model-tiers.ts";
import { isWithinModelScope, checkModelScope } from "../model-scope.ts";
import { normalizeMaxTurns, getDefaultMaxTurns } from "../agent-runner.ts";
import type { AgentInvocation } from "../types.ts";
import {
  getOutputTranscriptDefault,
  streamToOutputFile,
  createOutputFilePath,
  writeInitialEntry,
} from "../output-file.ts";
import { hostParams } from "../schema-bridge.ts";
import {
  isAdmissionOpen,
  ADMISSION_CLOSED_MESSAGE,
  readStopState,
} from "@choco-pi/shared/stop-control";
import { obj, str, opt, arr, bool } from "@earendil-works/pi-schema";
import { workflowResultView } from "../tool-output-keys.ts";
import { abortable } from "../abortable.ts";
import { splitGateKey, createActivityTracker, errorResult, textResult } from "./helpers.ts";
import type { SubagentsRuntime } from "./runtime.ts";

export function installWorkflowTools(pi: ExtensionAPI, rt: SubagentsRuntime) {
  const resolveWorkflowType = (requested: string): string | undefined => {
    const available = getAvailableTypes();
    if (available.includes(requested)) return requested;
    const matches = available.filter((type) => type.toLowerCase() === requested.toLowerCase());
    return matches.length === 1 ? matches[0] : undefined;
  };

  const resolveWorkflowStepModel = (ctx: ExtensionContext, step: WorkflowStepDefinition) => {
    const config = getAgentConfig(step.subagent_type);
    const resolvedConfig = resolveAgentInvocationConfig(config, step, {
      worktreeAllowed: isWorktreeIsolationEnabled(),
    });
    let model = ctx.model;
    let fromInput = false;
    if (resolvedConfig.modelInput) {
      const resolution = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
      switch (resolution.tag) {
        case "error":
          if (resolvedConfig.modelFromParams) throw new Error(resolution.message);
          break;
        case "resolved":
          model = resolution.model;
          fromInput = true;
          break;
      }
    }
    return { config, resolvedConfig, model, fromInput };
  };

  const createWorkflowRunner = (
    ctx: ExtensionContext,
    workTask: string | undefined,
  ): WorkflowStepRunner => {
    let owner: string | undefined;
    try {
      owner = ctx.sessionManager.getSessionId();
    } catch {
      owner = undefined;
    }
    return {
      providerKey: (step) => {
        try {
          const model = resolveWorkflowStepModel(ctx, step).model;
          return model === undefined ? "unknown" : `${model.provider.toLowerCase()}/${model.id}`;
        } catch {
          return undefined;
        }
      },
      isProviderAvailable: (gateKey) => {
        const { provider, modelId } = splitGateKey(gateKey);
        return rt.core.manager.isProviderAvailable(provider, owner, modelId);
      },
      refreshProvider: (gateKey) => {
        const { provider, modelId } = splitGateKey(gateKey);
        return rt.core.manager.refreshProviderBlock(provider, owner, modelId);
      },
      unavailableMessage: (gateKey) => {
        const { provider, modelId } = splitGateKey(gateKey);
        return rt.core.manager.providerUnavailableMessage(provider, owner, modelId);
      },
      run: async (step, prompt, workflowContext) => {
        const resolved = resolveWorkflowStepModel(ctx, step);
        const { config, resolvedConfig } = resolved;
        const model =
          resolved.fromInput && resolved.model
            ? chooseVariant(
                resolved.model,
                await loadPreferredVariants(),
                ctx.modelRegistry,
                (candidate) => isWithinModelScope(candidate, ctx.cwd, ctx.modelRegistry),
              ).model
            : resolved.model;
        const scopeVerdict = checkModelScope({
          model,
          cwd: ctx.cwd,
          modelRegistry: ctx.modelRegistry,
          callerSupplied: resolvedConfig.callerOverridesRoleModel,
          agentLabel: config?.displayName ?? step.subagent_type,
          modelInput: resolvedConfig.modelInput,
        });
        if (scopeVerdict.kind === "error") throw new Error(scopeVerdict.message);
        if (scopeVerdict.kind === "warn") ctx.ui.notify(scopeVerdict.message, "warning");

        const effectiveMaxTurns = normalizeMaxTurns(
          resolvedConfig.maxTurns ?? getDefaultMaxTurns(),
        );
        const parentModelId = ctx.model?.id;
        const effectiveModelId = model?.id;
        const invocation: AgentInvocation = {
          modelName:
            effectiveModelId && effectiveModelId !== parentModelId
              ? (model?.name ?? effectiveModelId).replace(/^Claude\s+/i, "").toLowerCase()
              : undefined,
          thinking: resolvedConfig.thinking,
          maxTurns: normalizeMaxTurns(resolvedConfig.maxTurns),
          isolated: resolvedConfig.isolated,
          inheritContext: false,
          runInBackground: true,
          isolation: resolvedConfig.isolation,
          fastMode: resolvedConfig.fastMode,
          daybreak: resolvedConfig.daybreak,
        };
        const { state, callbacks } = createActivityTracker(effectiveMaxTurns);
        const outputTranscript = config?.outputTranscript ?? getOutputTranscriptDefault();

        let id = "";
        const originalOnSessionCreated = callbacks.onSessionCreated;
        callbacks.onSessionCreated = (session: AgentSession) => {
          originalOnSessionCreated(session);
          const record = rt.core.manager.getRecord(id);
          if (record?.outputFile) {
            record.outputCleanup = streamToOutputFile(session, record.outputFile, id, ctx.cwd);
          }
        };

        const admission = await rt.registry.admitReviewRound(
          ctx,
          step.subagent_type,
          workTask,
          "workflow",
          owner,
        );
        if (admission.kind === "refused") throw new Error(admission.message);
        const reviewTicket = rt.registry.ticketOf(admission);
        try {
          id = rt.core.manager.spawn(pi, ctx, step.subagent_type, prompt, {
            reviewTicket,
            description: `Workflow step: ${step.id}`,
            model,
            maxTurns: effectiveMaxTurns,
            isolated: resolvedConfig.isolated,
            inheritContext: false,
            thinkingLevel: resolvedConfig.thinking,
            fastModeRequested: resolvedConfig.fastMode,
            daybreakRequested: resolvedConfig.daybreak,
            isBackground: true,
            isolation: resolvedConfig.isolation,
            invocation,
            signal: workflowContext.signal,
            workflowId: workflowContext.workflowId,
            workflowStepId: step.id,
            rootSessionId: ctx.sessionManager.getSessionId(),
            ...callbacks,
          });
        } catch (error) {
          if (reviewTicket !== undefined) await rt.registry.reviewRounds.release(reviewTicket);
          throw error;
        }
        workflowContext.onAgentStarted(id);

        const record = rt.core.manager.getRecord(id);
        if (!record) throw new Error(`Workflow step "${step.id}" disappeared after launch.`);
        record.resultConsumed = !rt.workflowRuntime.workflowManager.shouldNotifySteps(
          workflowContext.workflowId,
        );
        if (outputTranscript) {
          record.outputFile = createOutputFilePath(ctx.cwd, id, ctx.sessionManager.getSessionId());
          writeInitialEntry(record.outputFile, id, prompt, ctx.cwd);
        }
        rt.agentActivity.set(id, state);
        rt.views.fleet.ensureTimer();
        rt.views.fleet.update();
        rt.notifications.emitLifecycle("subagents:created", {
          id,
          type: step.subagent_type,
          description: record.description,
          isBackground: true,
          workflowId: workflowContext.workflowId,
          workflowStepId: step.id,
        });

        const abort = () => rt.core.manager.abort(id);
        workflowContext.signal.addEventListener("abort", abort, { once: true });
        if (workflowContext.signal.aborted) abort();
        try {
          while (record.status === "queued") {
            await new Promise<void>((resolve) =>
              setTimeout(resolve, rt.notifications.QUEUE_WAIT_POLL_MS),
            );
          }
          if (record.promise) await record.promise;
        } finally {
          workflowContext.signal.removeEventListener("abort", abort);
        }

        const successful = record.status === "completed" || record.status === "steered";
        return {
          status: successful
            ? "completed"
            : workflowContext.signal.aborted && record.status === "stopped"
              ? "cancelled"
              : "error",
          output: record.result,
          error: successful
            ? undefined
            : (record.error ?? `Agent ended with status ${record.status}.`),
          agentId: id,
        };
      },
    };
  };

  pi.registerTool(
    defineTool({
      name: "workflow_run",
      label: "Run Workflow",
      description: "Launch a dependency-aware workflow of subagents.",
      promptSnippet: "Launch a dynamic DAG workflow of subagents",
      parameters: hostParams(WorkflowDefinitionSchema),
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        let runRoot: string | undefined;
        try {
          runRoot = ctx.sessionManager.getSessionId();
        } catch {
          runRoot = undefined;
        }
        if (!(await rt.revival.refreshAgentsForSession())) {
          return errorResult(
            "Session changed while agent definitions were loading; the workflow was not started.",
          );
        }
        if (!isAdmissionOpen(runRoot)) return errorResult(ADMISSION_CLOSED_MESSAGE);
        try {
          const result = rt.workflowRuntime.workflowManager.start(
            params,
            resolveWorkflowType,
            createWorkflowRunner(ctx, params.work_task),
            rt.core.manager.getSchedulingMaxConcurrent(),
          );
          rt.workflowRuntime.workflowAdmissions.set(result.workflowId, {
            root: runRoot,
            epoch: runRoot === undefined ? 0 : readStopState(runRoot).epoch,
          });
          pi.events.emit("subagents:workflow_created", result);
          return textResult(
            `Workflow started.\nWorkflow ID: ${result.workflowId}\nName: ${result.name}\n` +
              `Steps: ${result.steps.length}\nMode: ${result.dynamic ? "dynamic (call workflow_update with finish: true when the plan is complete)" : "automatic"}\n\n` +
              "You will be notified when the workflow completes. Use get_workflow_result for aggregate status and per-step outputs.",
          );
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "workflow_update",
      label: "Update Workflow",
      description:
        "Add, replace, or finish pending workflow steps; requires steps or finish: true.",
      promptSnippet: "Adjust a running subagent workflow",
      parameters: hostParams(
        obj({
          workflow_id: str(),
          steps: opt(arr(WorkflowStepSchema, { minItems: 1 })),
          finish: opt(bool()),
        }),
      ),
      execute: async (_toolCallId, params) => {
        if (!(await rt.revival.refreshAgentsForSession())) {
          return errorResult(
            "Session changed while agent definitions were loading; the workflow was not updated.",
          );
        }
        if (!params.steps && params.finish !== true) {
          return errorResult("workflow_update requires `steps` or `finish: true`.");
        }
        try {
          let result = params.steps
            ? rt.workflowRuntime.workflowManager.update(
                params.workflow_id,
                params.steps,
                resolveWorkflowType,
              )
            : rt.workflowRuntime.workflowManager.get(params.workflow_id);
          if (!result) return errorResult(`Workflow not found: "${params.workflow_id}".`);
          if (params.finish === true)
            result = rt.workflowRuntime.workflowManager.finish(params.workflow_id);
          return textResult(JSON.stringify(workflowResultView(result), null, 2));
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "get_workflow_result",
      label: "Get Workflow Result",
      description: "Retrieve aggregate workflow status and step outputs.",
      promptSnippet: "Get aggregate subagent workflow results",
      parameters: hostParams(
        obj({
          workflow_id: str(),
          wait: opt(bool()),
        }),
      ),
      execute: async (_toolCallId, params, signal) => {
        let result = rt.workflowRuntime.workflowManager.get(params.workflow_id);
        if (!result) return errorResult(`Workflow not found: "${params.workflow_id}".`);
        if (params.wait && (result.status === "running" || result.status === "waiting")) {
          const completion = rt.workflowRuntime.workflowManager.wait(params.workflow_id);
          if (completion) {
            try {
              result = await abortable(completion, signal);
            } catch (error) {
              if (signal?.aborted) {
                return textResult(
                  "Result wait cancelled. The agent continues and its result remains unconsumed.",
                );
              }
              throw error;
            }
          }
        }
        if (result.completedAt !== undefined) {
          rt.workflowRuntime.workflowManager.markConsumed(params.workflow_id);
          rt.notifications.cancelNudge(`workflow:${params.workflow_id}`);
        }
        const serialized = JSON.stringify(workflowResultView(result), null, 2);
        if (params.wait && result.dynamic && !result.sealed && result.status === "waiting") {
          return textResult(
            "Workflow is idle and remains open. Add steps with workflow_update, or seal it with workflow_update { finish: true }.\n\n" +
              serialized,
          );
        }
        return textResult(serialized);
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "workflow_cancel",
      label: "Cancel Workflow",
      description: "Cancel pending and running workflow steps.",
      promptSnippet: "Cancel a running subagent workflow",
      parameters: hostParams(obj({ workflow_id: str() })),
      execute: async (_toolCallId, params) => {
        try {
          return textResult(
            JSON.stringify(
              workflowResultView(rt.workflowRuntime.workflowManager.cancel(params.workflow_id)),
              null,
              2,
            ),
          );
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }
      },
    }),
  );
}
