import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { hasAgentBadge, renderAgentName } from "./agent-color.ts";
import type { AgentRecord } from "./types.ts";
import { getLifetimeTotal, type LifetimeUsage } from "./usage.ts";
import {
  type AgentActivity,
  type AgentDetails,
  type Theme,
  buildInvocationTags,
  fgPreservingNestedStyles,
  formatMs,
  formatTokens,
  formatTurns,
  getDisplayName,
  SPINNER,
} from "./ui/agent-widget.ts";

const AgentDetailsSchema = Type.Object({
  displayName: Type.String(),
  description: Type.String(),
  subagentType: Type.String(),
  toolUses: Type.Number(),
  tokens: Type.String(),
  durationMs: Type.Number(),
  status: Type.Union(
    (
      [
        "queued",
        "running",
        "completed",
        "steered",
        "aborted",
        "stopped",
        "budget_exceeded",
        "watchdog_stopped",
        "error",
        "waiting_for_reset",
        "background",
      ] as const
    ).map((status) => Type.Literal(status)),
  ),
  modelName: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
  turnCount: Type.Optional(Type.Number()),
  maxTurns: Type.Optional(Type.Number()),
  agentId: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  activity: Type.Optional(Type.String()),
  spinnerFrame: Type.Optional(Type.Number()),
});
export function renderRunningAgentStatus(
  frame: string,
  statsText: string,
  activity: string,
  theme: Pick<Theme, "fg">,
): Container {
  const container = new Container();
  container.addChild(
    new Text(theme.fg("accent", frame) + (statsText ? " " + statsText : ""), 0, 0),
  );
  container.addChild(new Text(theme.fg("dim", `  ⎿  ${activity}`), 0, 0));
  return container;
}

/** Format an agent's lifetime token total, or "" when zero. */
function formatLifetimeTokens(o: { lifetimeUsage: LifetimeUsage }): string {
  const t = getLifetimeTotal(o.lifetimeUsage);
  return t > 0 ? formatTokens(t) : "";
}

/** Build AgentDetails from a base + record-specific fields. */
export function buildDetails(
  base: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">,
  record: {
    toolUses: number;
    startedAt: number;
    completedAt?: number;
    status: AgentDetails["status"];
    error?: string;
    id?: string;
    alias?: string;
    handle?: string;
    outputFile?: string;
    session?: AgentRecord["session"];
    lifetimeUsage: LifetimeUsage;
  },
  activity?: AgentActivity,
  overrides?: Partial<AgentDetails>,
) {
  return {
    ...base,
    toolUses: record.toolUses,
    tokens: formatLifetimeTokens(record),
    turnCount: activity?.turnCount,
    maxTurns: activity?.maxTurns,
    durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
    status: record.status,
    agentId: record.id,
    error: record.error,
    alias: record.alias,
    handle: record.handle,
    outputFile: record.outputFile,
    resumed: false,
    ...overrides,
  };
}

export function buildRecordDetails(record: AgentRecord, background = false, resumed = false) {
  const invocation = buildInvocationTags(record.invocation ?? {});
  const base = {
    displayName: getDisplayName(record.type),
    description: record.description,
    subagentType: record.type,
    modelName: invocation.modelName,
    tags: invocation.tags.length > 0 ? invocation.tags : undefined,
  };
  return {
    ...buildDetails(
      base,
      record,
      undefined,
      background
        ? {
            status: "background",
            toolUses: resumed ? record.toolUses : 0,
            tokens: "",
            durationMs: 0,
          }
        : undefined,
    ),
    resumed,
  };
}

const DelegationRenderArguments = Type.Object({
  subagent_type: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  agent_id: Type.Optional(Type.String()),
});
type DelegationRenderers = Required<
  Pick<
    ToolDefinition<typeof DelegationRenderArguments, unknown, unknown>,
    "renderCall" | "renderResult"
  >
>;

export const delegationRenderers: DelegationRenderers = {
  renderCall(args, theme, context) {
    // A badge closes its own background, which would clear the tool block's row tint
    // for the rest of the line, so the badge restores it. The tint is opened here too:
    // the TUI's Box paints it, but HTML export takes it from CSS, and restoring a
    // background the line never opened is what banded the export before. The line is
    // deliberately left open — Box.applyBackgroundToLine pads to width and *then*
    // wraps, so closing here would leave that padding untinted, and HTML export closes
    // any open span per line anyway. No badge means no tint, so an uncolored agent
    // renders exactly the line it always did.
    const rowBackground = hasAgentBadge(args.subagent_type ?? "Agent")
      ? theme.getBgAnsi(
          context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg",
        )
      : "";
    const desc = args.description ?? "";
    const name = renderAgentName(args.subagent_type ?? "Agent", theme, {
      fallbackColor: "toolTitle",
      restoreBackground: rowBackground,
      bold: true,
    });
    return new Text(
      rowBackground + "▸ " + name + (desc ? "  " + theme.fg("muted", desc) : ""),
      0,
      0,
    );
  },

  renderResult(result, { expanded, isPartial }, theme, renderContext) {
    const details = Value.Check(AgentDetailsSchema, result.details) ? result.details : undefined;
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    // Pi reports pre-execution failures (extension block, abort, argument
    // validation) as `{ content: [reason], details: {} }` with isError set —
    // no status to render, so show the reason instead of inventing one (#199).
    if (renderContext.isError || !details?.status) {
      return new Text(text, 0, 0);
    }

    // Helper: build "haiku · thinking: high · ↻5≤30 · 3 tool uses · 33.8k tokens" stats string
    const stats = (d: AgentDetails) => {
      const parts: string[] = [];
      if (d.modelName) parts.push(d.modelName);
      if (d.tags) parts.push(...d.tags);
      if (d.turnCount != null && d.turnCount > 0) {
        parts.push(formatTurns(d.turnCount, d.maxTurns));
      }
      if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
      if (d.tokens) parts.push(d.tokens);
      return parts
        .map((p) => fgPreservingNestedStyles(theme, "dim", p))
        .join(" " + theme.fg("dim", "·") + " ");
    };

    // ---- While running (streaming) ----
    if (isPartial || details.status === "running") {
      const frame = SPINNER[details.spinnerFrame ?? 0];
      const s = stats(details);
      return renderRunningAgentStatus(frame, s, details.activity ?? "thinking…", theme);
    }

    // ---- Background agent launched ----
    if (details.status === "background") {
      return new Text(theme.fg("dim", `  ⎿  Running in background (ID: ${details.agentId})`), 0, 0);
    }

    // ---- Completed / Steered ----
    if (details.status === "completed" || details.status === "steered") {
      const duration = formatMs(details.durationMs);
      const isSteered = details.status === "steered";
      const icon = isSteered ? theme.fg("warning", "✓") : theme.fg("success", "✓");
      const s = stats(details);
      let line = icon + (s ? " " + s : "");
      line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);

      if (expanded) {
        const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
        if (resultText) {
          const lines = resultText.split("\n").slice(0, 50);
          for (const l of lines) {
            line += "\n" + theme.fg("dim", `  ${l}`);
          }
          if (resultText.split("\n").length > 50) {
            line +=
              "\n" +
              theme.fg("muted", "  ... (use get_subagent_result with verbose for full output)");
          }
        }
      } else {
        const doneText = isSteered ? "Wrapped up (turn limit)" : "Done";
        line += "\n" + theme.fg("dim", `  ⎿  ${doneText}`);
      }
      return new Text(line, 0, 0);
    }

    // ---- Stopped (user-initiated abort) ----
    if (details.status === "stopped") {
      const s = stats(details);
      let line = theme.fg("dim", "■") + (s ? " " + s : "");
      line += "\n" + theme.fg("dim", "  ⎿  Stopped");
      return new Text(line, 0, 0);
    }

    if (details.status === "budget_exceeded" || details.status === "watchdog_stopped") {
      const s = stats(details);
      let line = theme.fg("warning", "■") + (s ? " " + s : "");
      line +=
        "\n" +
        theme.fg(
          "warning",
          `  ⎿  ${details.status === "budget_exceeded" ? "Budget exceeded" : "Idle watchdog stopped"}: ${details.error ?? "unknown"}`,
        );
      return new Text(line, 0, 0);
    }

    // Anything left ("queued", or a status added later) has no rendering of
    // its own — the turn-limit wording below must not be the catch-all.
    if (details.status !== "error" && details.status !== "aborted") {
      return new Text(text, 0, 0);
    }

    // ---- Error / Aborted (hard max_turns) ----
    const s = stats(details);
    let line = theme.fg("error", "✗") + (s ? " " + s : "");

    if (details.status === "error") {
      line += "\n" + theme.fg("error", `  ⎿  Error: ${details.error ?? "unknown"}`);
    } else {
      line += "\n" + theme.fg("warning", "  ⎿  Aborted (max turns exceeded)");
    }

    return new Text(line, 0, 0);
  },
};
