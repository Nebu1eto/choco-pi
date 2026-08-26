import {
  defineTool,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

/** Persisted settings and runtime setters never exceed these safety bounds. */
export const MAX_CONCURRENT_SANITY_CAP = 1024;
export const SUBAGENT_DEPTH_CEILING = 16;

export interface SubagentLimitController {
  getMaxConcurrent(): number;
  setMaxConcurrent(value: number): void;
  getMaxSubagentDepth(): number;
  setMaxSubagentDepth(value: number): void;
  getActiveCount(): number;
  getScheduledActiveCount(): number;
}

export interface SubagentReminderSource {
  getMaxConcurrent(): number;
  getMaxSubagentDepth(): number;
  getActiveCount(): number;
  getScheduledActiveCount(): number;
  depth?: number;
}

export interface SubagentLimitUpdate {
  maxConcurrent?: number;
  maxSubagentDepth?: number;
}

/** Preserve 0 as the unlimited sentinel while bounding its real scheduler fan-out. */
export function normalizeMaxConcurrent(value: number): number {
  if (value === 0) return 0;
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_CONCURRENT_SANITY_CAP, Math.max(1, Math.floor(value)));
}

/** Concrete scheduler limit for a configured value; unlimited still has a machine-safety cap. */
export function schedulingMaxConcurrent(value: number): number {
  return value === 0 ? MAX_CONCURRENT_SANITY_CAP : value;
}

export function formatConcurrencyCap(value: number): string {
  return value === 0 ? "unlimited" : String(value);
}

function formatActivityCounts(scheduled: number, tree: number, maxConcurrent: number): string {
  return `${scheduled} scheduled / cap ${formatConcurrencyCap(maxConcurrent)}; ${tree} in tree`;
}

/** Compact result shared by the root-only tool and pure tests. */
export function formatSubagentLimits(controller: SubagentLimitController): string {
  const maxConcurrent = controller.getMaxConcurrent();
  const concurrency =
    maxConcurrent === 0
      ? `unlimited (sanity cap ${MAX_CONCURRENT_SANITY_CAP})`
      : String(maxConcurrent);
  return (
    `subagent limits: maxConcurrent=${concurrency}, ` +
    `maxSubagentDepth=${controller.getMaxSubagentDepth()}; ` +
    formatActivityCounts(
      controller.getScheduledActiveCount(),
      controller.getActiveCount(),
      maxConcurrent,
    )
  );
}

/** Apply an optional runtime-only update, then report the effective values. */
export function applySubagentLimits(
  update: SubagentLimitUpdate,
  controller: SubagentLimitController,
): string {
  if (update.maxConcurrent !== undefined) {
    controller.setMaxConcurrent(update.maxConcurrent);
  }
  if (update.maxSubagentDepth !== undefined) {
    controller.setMaxSubagentDepth(update.maxSubagentDepth);
  }
  return formatSubagentLimits(controller);
}

/** One-line turn-start snapshot; no active agents means no persisted message. */
export function buildSubagentReminder(source: SubagentReminderSource): string | undefined {
  const tree = source.getActiveCount();
  if (tree === 0) return undefined;
  const maxDepth = source.getMaxSubagentDepth();
  const position =
    source.depth === undefined ? "" : `; current depth ${source.depth} of ${maxDepth}`;
  return (
    `<system-reminder>Turn-start subagent snapshot (historical after this turn): ${formatActivityCounts(
      source.getScheduledActiveCount(),
      tree,
      source.getMaxConcurrent(),
    )}; inherited depth ceiling ${maxDepth}` + `${position}</system-reminder>`
  );
}

/** Persist one hidden status message at each active agent-run start. */
export function registerSubagentStatusMessage(
  pi: Pick<ExtensionAPI, "on">,
  source: SubagentReminderSource,
): void {
  pi.on("before_agent_start", () => {
    const reminder = buildSubagentReminder(source);
    if (reminder === undefined) return undefined;
    return {
      message: {
        customType: "subagent-status",
        content: reminder,
        display: false,
      },
    };
  });
}

/** Build the root-only LLM-callable runtime limit control. */
export function createSubagentLimitsTool(controller: SubagentLimitController): ToolDefinition {
  return defineTool({
    name: "subagent_limits",
    label: "Subagent Limits",
    description:
      "Read or adjust subagent limits only when the user asks for a different limit. " +
      "Values apply to this session only and are not persisted. " +
      "maxConcurrent=0 means unlimited concurrency (with a sanity cap of 1024).",
    parameters: Type.Object({
      maxConcurrent: Type.Optional(
        Type.Integer({ minimum: 0, description: "Maximum concurrency; 0 means unlimited." }),
      ),
      maxSubagentDepth: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: SUBAGENT_DEPTH_CEILING,
          description: "Maximum nesting depth; 0 or 1 disables nesting.",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => ({
      content: [{ type: "text" as const, text: applySubagentLimits(params, controller) }],
      details: {},
    }),
  });
}
