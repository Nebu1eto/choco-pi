/**
 * Agent control tool registrations.
 */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hostParams } from "../schema-bridge.ts";
import { obj, str, bool, oneOf, opt, arr } from "@earendil-works/pi-schema";
import {
  SUBAGENT_TREE_TOOL_NAME,
  buildSubagentTree,
  SUBAGENT_STATUS_TOOL_NAME,
  buildSubagentStatusBatch,
} from "../subagent-tree.ts";
import { SUBAGENT_TOOL_NAMES, getAgentConversation } from "../agent-runner.ts";
import { delegationRenderers, buildRecordDetails } from "../delegation-render.ts";
import {
  claimSubagentResultRead,
  formatResultReadRefusal,
  waitForSubagentResult,
  formatResultReadGenerationChanged,
  releaseActiveResultRead,
  formatResultReadTimeout,
  TERMINAL_RESULT_RETRIEVAL_GUIDANCE,
} from "../result-read.ts";
import { getDisplayName, formatDuration } from "../ui/agent-widget.ts";
import { getSessionContextPercent } from "../usage.ts";
import { getStatusNote, partialOutputSuffix } from "../status-note.ts";
import { formatResetAt } from "../usage-limit-seam.ts";
import { formatSteerMessage, ROOT_AGENT_PATH } from "../messaging.ts";
import { resolveStopOutcome } from "../stop-subagent.ts";
import { errorResult, textResult, formatLifetimeTokens } from "./helpers.ts";
import type { SubagentsRuntime } from "./runtime.ts";

/** Registers the status, tree, result, steer, and stop tools. */
export function installAgentControlTools(pi: ExtensionAPI, rt: SubagentsRuntime) {
  pi.registerTool(
    defineTool({
      name: "set_subagent_fast_mode",
      label: "Set Subagent Fast Mode",
      description:
        "Enable or disable fast mode for a running or queued descendant. Applies deterministically to the accepted generation.",
      promptSnippet: "Change a descendant subagent's fast-mode request",
      parameters: hostParams(obj({ agent_id: str(), enabled: bool() })),
      execute: async (_toolCallId, params) => {
        const record = rt.registry.resolveAgentRef(params.agent_id);
        if (!record) return errorResult(`Agent not found: "${params.agent_id}".`);
        const updated = rt.core.manager.setFastMode(record.id, params.enabled);
        if (!updated) {
          return errorResult(`Agent "${params.agent_id}" is no longer retained.`);
        }
        const unavailable = params.enabled
          ? rt.core.manager.featureUnavailableReason(updated.id, "fast")
          : undefined;
        return textResult(
          (unavailable === undefined
            ? `Fast mode ${params.enabled ? "enabled" : "disabled"} for ${updated.id}. `
            : `Fast mode requested for ${updated.id} but not applied: ${unavailable}. `) +
            `Generation: ${updated.resultGeneration ?? 1}. Revision: ${updated.fastModeRevision ?? 0}. ` +
            `Status: ${updated.status}.`,
        );
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "set_subagent_daybreak",
      label: "Set Subagent Daybreak",
      description:
        "Enable or disable Daybreak for a running or queued descendant. Entitlement is checked separately.",
      promptSnippet: "Change a descendant subagent's Daybreak request",
      parameters: hostParams(obj({ agent_id: str(), enabled: bool() })),
      execute: async (_toolCallId, params) => {
        const record = rt.registry.resolveAgentRef(params.agent_id);
        if (!record) return errorResult(`Agent not found: "${params.agent_id}".`);
        const updated = rt.core.manager.setDaybreak(record.id, params.enabled);
        if (!updated) return errorResult(`Agent "${params.agent_id}" is no longer retained.`);
        const unavailable = params.enabled
          ? rt.core.manager.featureUnavailableReason(updated.id, "daybreak")
          : undefined;
        return textResult(
          (unavailable === undefined
            ? `Daybreak ${params.enabled ? "enabled" : "disabled"} for ${updated.id}. `
            : `Daybreak requested for ${updated.id} but unavailable: ${unavailable}. `) +
            `Generation: ${updated.resultGeneration ?? 1}. Revision: ${updated.daybreakRevision ?? 0}. ` +
            `Status: ${updated.status}.`,
        );
      },
    }),
  );

  // ---- get_subagent_result tool ----

  // ---- read-only whole-tree views (root only; never consume or steer) ----

  const TreeStatusFilterSchema = oneOf(["all", "active", "terminal"], {
    description: "Which records to list. Default: all.",
  });

  pi.registerTool(
    defineTool({
      name: SUBAGENT_TREE_TOOL_NAME,
      label: "Subagent Tree",
      description:
        "List every subagent record, nested descendants included, as a read-only tree. Never consumes results.",
      promptSnippet: "Inspect the full subagent tree, including nested descendants",
      parameters: hostParams(
        obj({
          status: opt(TreeStatusFilterSchema),
          root: opt(str({ description: "Agent ID, handle, or name whose subtree to list." })),
        }),
      ),
      execute: async (_toolCallId, params) => {
        const view = buildSubagentTree(rt.core.manager.listAgents(), {
          status: params.status,
          root: params.root,
        });
        if (view.kind === "unknown-root") {
          return {
            content: [{ type: "text" as const, text: `Agent not found: "${view.ref}".` }],
            details: { agents: [] },
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: view.text }],
          details: { agents: view.entries },
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: SUBAGENT_STATUS_TOOL_NAME,
      label: "Subagent Status",
      description:
        "Read status lines for subagents (nested included) without their results. Never consumes results.",
      promptSnippet: "Read status lines for subagents without consuming results",
      parameters: hostParams(
        obj({
          ids: arr(str({ description: "Agent ID, handle, or assigned name." }), {
            minItems: 1,
          }),
        }),
      ),
      execute: async (_toolCallId, params) => {
        const batch = buildSubagentStatusBatch(rt.core.manager.listAgents(), params.ids);
        return {
          content: [{ type: "text" as const, text: batch.text }],
          details: { agents: batch.entries, unknown: batch.unknown },
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: SUBAGENT_TOOL_NAMES.GET_RESULT,
      label: "Get Agent Result",
      renderCall: delegationRenderers.renderCall,
      renderResult: delegationRenderers.renderResult,
      description: "Retrieve a background agent's status or terminal result.",
      promptSnippet: "Retrieve a terminal background-agent result",
      parameters: hostParams(
        obj(
          {
            agent_id: str({
              description: "Agent ID, handle, or assigned name.",
            }),
            wait: opt(
              bool({
                description: "Wait up to five seconds on the first active read.",
              }),
            ),
            verbose: opt(
              bool({
                description:
                  "If true, include the agent's full conversation (messages + tool calls). Default: false.",
              }),
            ),
          },
          { open: true },
        ),
      ),
      execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
        const record = rt.registry.resolveAgentRef(params.agent_id);
        if (!record) {
          const dormant = rt.revival.findTopLevelDormant(params.agent_id);
          if (dormant !== undefined) return rt.revival.readDormantResult(dormant, params.verbose);
        }
        if (!record || record.parentAgentId) {
          return errorResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
        }

        let claim = claimSubagentResultRead(record, signal);
        if (
          claim.kind === "active-refused" ||
          claim.kind === "terminal-refused" ||
          claim.kind === "terminal-pending"
        ) {
          return errorResult(formatResultReadRefusal(record, claim));
        }
        let waitOutcome: "settled" | "timed-out" = "settled";
        if (claim.kind === "active" && params.wait) {
          const generation = claim.generation;
          try {
            waitOutcome = await waitForSubagentResult(record, signal);
            if (record.resultGeneration !== generation) {
              return errorResult(formatResultReadGenerationChanged(record, generation));
            }
            if (
              waitOutcome !== "timed-out" ||
              (record.status !== "running" &&
                record.status !== "queued" &&
                record.status !== "waiting_for_reset")
            ) {
              claim = claimSubagentResultRead(record, signal);
              if (
                claim.kind === "active-refused" ||
                claim.kind === "terminal-refused" ||
                claim.kind === "terminal-pending"
              ) {
                return errorResult(formatResultReadRefusal(record, claim));
              }
            }
          } catch (error) {
            releaseActiveResultRead(record, generation);
            if (signal?.aborted) {
              return textResult(
                "Result wait cancelled. The agent continues and its result remains unconsumed.",
              );
            }
            throw error;
          }
        }

        const displayName = getDisplayName(record.type);
        const duration = formatDuration(record.startedAt, record.completedAt);
        const tokens = formatLifetimeTokens(record);
        const contextPercent = getSessionContextPercent(record.session);
        const statsParts = [`Tool uses: ${record.toolUses}`];
        if (tokens) statsParts.push(tokens);
        if (contextPercent !== null) statsParts.push(`Context: ${Math.round(contextPercent)}%`);
        if (record.compactionCount) statsParts.push(`Compactions: ${record.compactionCount}`);
        statsParts.push(`Duration: ${duration}`);

        let output =
          `Agent: ${record.id}\n` +
          `Type: ${displayName} | Status: ${record.status}${getStatusNote(record.status)} | ${statsParts.join(" | ")}\n` +
          `Fast mode: ${record.fastModeRequested ? "requested" : "standard"} (revision ${record.fastModeRevision ?? 0})\n` +
          `Daybreak: ${record.daybreakRequested ? "requested" : "off"} (revision ${record.daybreakRevision ?? 0})\n` +
          `Description: ${record.description}\n\n`;

        const cancellation = record.cancellation;
        if (cancellation && cancellation.generation === record.resultGeneration) {
          output += `Cancellation: ${cancellation.cause} — ${cancellation.reason}\n\n`;
        }

        if (record.status === "waiting_for_reset") {
          output +=
            `Agent is paused until its provider usage window resets (${formatResetAt(record.usageLimit?.resetAt)}); ` +
            "it resumes on the same model and reports through its completion notification.";
        } else if (record.status === "running" || record.status === "queued") {
          output +=
            waitOutcome === "timed-out"
              ? formatResultReadTimeout(record.id, record.status)
              : `Agent is still ${record.status}. Retrieve the result only after its completion notification.`;
        } else if (record.status === "error") {
          output += `Error: ${record.error}${partialOutputSuffix(record)}`;
        } else {
          output += record.result?.trim() || "No output.";
        }

        // Terminal claim above already marked exactly this generation consumed.
        if (claim.kind === "terminal") {
          rt.notifications.cancelNudge(record.id);
          rt.core.manager.journalRecord(record.id);
        }

        // Verbose: include full conversation
        if (params.verbose && record.session) {
          const conversation = getAgentConversation(record.session);
          if (conversation) {
            output += `\n\n--- Agent Conversation ---\n${conversation}`;
          }
        }

        return textResult(output, buildRecordDetails(record));
      },
    }),
  );

  // ---- steer_subagent tool ----

  pi.registerTool(
    defineTool({
      name: SUBAGENT_TOOL_NAMES.STEER,
      label: "Steer Agent",
      renderCall: delegationRenderers.renderCall,
      renderResult: delegationRenderers.renderResult,
      description: "Send guidance to a running or queued agent.",
      promptSnippet: "Redirect a running or queued agent.",
      parameters: hostParams(
        obj(
          {
            agent_id: str({
              description: "Running or queued agent ID, handle, or assigned name.",
            }),
            message: str({
              description: "Guidance delivered as an agent MESSAGE.",
            }),
          },
          { open: true },
        ),
      ),
      execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
        const record = rt.registry.resolveAgentRef(params.agent_id);
        if (!record || record.parentAgentId) {
          return errorResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
        }
        if (record.status !== "running" && record.status !== "queued") {
          return errorResult(
            `Agent "${params.agent_id}" is not running or queued (status: ${record.status}). Cannot steer it.`,
          );
        }
        const envelope = formatSteerMessage(ROOT_AGENT_PATH, params.message);
        // UI steering (overlay composer, prompt mentions and fullscreen focus)
        // converges on this same manager path, including pre-session queueing.
        const queuedBeforeSession = !record.session;
        if (!rt.core.manager.steer(record.id, envelope)) {
          return errorResult(
            `Failed to steer agent ${record.id}. It is no longer running or queued, or is being cancelled.`,
          );
        }
        rt.notifications.emitLifecycle("subagents:steered", { id: record.id, message: envelope });
        if (queuedBeforeSession) {
          return textResult(
            `Steering message queued for agent ${record.id}. It will be delivered once the session initializes.`,
            buildRecordDetails(record),
          );
        }
        const tokens = formatLifetimeTokens(record);
        const contextPercent = getSessionContextPercent(record.session);
        const stateParts: string[] = [];
        if (tokens) stateParts.push(tokens);
        stateParts.push(`${record.toolUses} tool ${record.toolUses === 1 ? "use" : "uses"}`);
        if (contextPercent !== null) stateParts.push(`context ${Math.round(contextPercent)}% full`);
        if (record.compactionCount)
          stateParts.push(
            `${record.compactionCount} compaction${record.compactionCount === 1 ? "" : "s"}`,
          );
        return textResult(
          `Steering message sent to agent ${record.id}. The agent will process it after its current tool execution.\n` +
            `Current state: ${stateParts.join(" · ")}`,
          buildRecordDetails(record),
        );
      },
    }),
  );

  // ---- stop_subagent tool ----

  pi.registerTool(
    defineTool({
      name: SUBAGENT_TOOL_NAMES.STOP,
      label: "Stop Agent",
      description: "Stop a running or queued background agent.",
      promptSnippet: "Stop a running or queued agent.",
      parameters: hostParams(
        obj(
          {
            agent_id: str({
              description: "Agent ID, handle, or assigned name.",
            }),
          },
          { open: true },
        ),
      ),
      execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
        const live = rt.registry.resolveAgentRef(params.agent_id);
        if (!live) {
          const dormant = rt.revival.findTopLevelDormant(params.agent_id);
          if (dormant !== undefined) return rt.revival.stopDormantAgent(params.agent_id, dormant);
        }
        const outcome = resolveStopOutcome(live);
        if (outcome.kind === "not_found") {
          return errorResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
        }
        if (outcome.kind === "nested") {
          return errorResult(
            `Agent "${params.agent_id}" is nested under another agent and cannot be stopped from the top-level orchestrator.`,
          );
        }
        const record = outcome.record;
        if (outcome.kind === "already_settled") {
          return textResult(
            `Agent "${params.agent_id}" is already settled (status: ${record.status}). ` +
              "Its transcript is still readable with get_subagent_result.",
          );
        }

        if (outcome.kind === "pending") {
          return textResult(
            `Cancellation requested for agent ${record.id}; terminal result is still pending. ` +
              TERMINAL_RESULT_RETRIEVAL_GUIDANCE,
          );
        }

        // A stop acknowledgement is not a terminal-result read. Running cleanup
        // still owns publication and its eventual completion notification.
        if (!rt.core.manager.abort(record.id)) {
          return errorResult(
            `Failed to stop agent ${record.id}. It is no longer running or queued.`,
          );
        }
        rt.notifications.emitLifecycle(
          "subagents:stopped",
          rt.notifications.buildEventData(record),
        );
        const tokens = formatLifetimeTokens(record);
        const contextPercent = getSessionContextPercent(record.session);
        const stateParts: string[] = [];
        if (tokens) stateParts.push(tokens);
        stateParts.push(`${record.toolUses} tool ${record.toolUses === 1 ? "use" : "uses"}`);
        if (contextPercent !== null) stateParts.push(`context ${Math.round(contextPercent)}% full`);
        if (record.compactionCount)
          stateParts.push(
            `${record.compactionCount} compaction${record.compactionCount === 1 ? "" : "s"}`,
          );
        const pending = resolveStopOutcome(record).kind === "pending";
        return textResult(
          (pending
            ? `Cancellation requested for agent ${record.id}; terminal result is still pending.\n`
            : `Agent ${record.id} stopped and settled.\n`) +
            `Current state: ${stateParts.join(" · ")}\n` +
            (pending
              ? TERMINAL_RESULT_RETRIEVAL_GUIDANCE
              : "Retrieve its terminal result exactly once with get_subagent_result."),
        );
      },
    }),
  );
}
