import {
  defineTool,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type AgentMessageType,
  classifyMessageDelivery,
  formatAgentMessage,
  getAgentIdentity,
  type MessagingRecord,
  resolveMessageRecipient,
  ROOT_AGENT_PATH,
} from "./messaging.ts";

export const AGENT_MESSAGE_TOOL_NAME = "agent_message";

/** The only session capability this tool uses; `AgentSession` satisfies it. */
export interface SteerableAgentSession {
  steer(message: string): Promise<void>;
}

/** The record surface this tool reads and writes, narrowed from `AgentRecord`. */
export interface AgentMessageRecord extends MessagingRecord {
  session?: SteerableAgentSession;
  /** Steering messages held until the recipient's session exists. */
  pendingSteers?: string[];
}

export interface AgentMessageManager {
  getRecord(id: string): AgentMessageRecord | undefined;
  listAgents(): AgentMessageRecord[];
}

export interface AgentMessageToolContext {
  manager: AgentMessageManager;
  pi: Pick<ExtensionAPI, "events" | "sendMessage">;
  /** Omitted for the root tool; otherwise the calling agent's own record id. */
  senderAgentId?: string;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError, details: {} };
}

export interface AgentMessageParams {
  to: string;
  message: string;
  type?: AgentMessageType;
}

/**
 * Deliver one agent-authored message. The registered tool is a thin wrapper
 * around this: the execution context carries nothing this delivery reads, so
 * the whole behavior is reachable without an extension host.
 */
export async function deliverAgentMessage(
  context: AgentMessageToolContext,
  params: AgentMessageParams,
) {
  const lookup = (id: string) => context.manager.getRecord(id);
  let senderIdentity = ROOT_AGENT_PATH;
  if (context.senderAgentId) {
    const sender = lookup(context.senderAgentId);
    if (!sender) {
      return textResult(`Calling agent not found: "${context.senderAgentId}".`, true);
    }
    try {
      senderIdentity = getAgentIdentity(sender);
    } catch {
      return textResult(`Calling agent identity unavailable: "${context.senderAgentId}".`, true);
    }
  }

  const recipient = resolveMessageRecipient(params.to, context.manager.listAgents());
  if (!recipient.ok) return textResult(recipient.error, true);

  const type = params.type ?? "MESSAGE";
  const envelope = formatAgentMessage(senderIdentity, params.message, type);

  if (recipient.kind === "root") {
    context.pi.sendMessage(
      { customType: "subagent-message", content: envelope, display: true },
      // SDK steering waits for the next safe boundary; it does not abort a tool/provider.
      { deliverAs: "steer", triggerTurn: true },
    );
    context.pi.events.emit("subagents:message", {
      from: senderIdentity,
      to: recipient.address,
      toId: undefined,
      type,
      // Not "queued": deliverAs "steer" hands the envelope to the root
      // session's steering queue (drained before its next LLM call while it
      // streams), and triggerTurn starts a turn when it is idle. Only a
      // recipient whose session does not exist yet is genuinely held.
      queued: false,
    });
    return textResult(
      `Message steered to ${recipient.address}; it arrives at the recipient's next safe boundary.`,
    );
  }

  const delivery = classifyMessageDelivery(recipient.record);
  if (delivery === "closing") {
    return textResult(
      `Agent ${recipient.address} is cancelling and cannot receive new work.`,
      true,
    );
  }
  if (delivery === "finished") {
    return textResult(
      `Agent ${recipient.address} already finished (status: ${recipient.record.status}).`,
      true,
    );
  }

  const session = recipient.record.session;
  const held = delivery === "queued" || !session;
  // Snapshot the owner before the only await: the acknowledgement below claims
  // delivery to this record, generation, and session, and none of them remain
  // ours to assume across suspension.
  const recipientId = recipient.record.id;
  const generation = recipient.record.resultGeneration ?? 1;
  if (held) {
    recipient.record.pendingSteers ??= [];
    recipient.record.pendingSteers.push(envelope);
  } else {
    try {
      await session.steer(envelope);
    } catch (error) {
      return textResult(
        `Failed to deliver to ${recipient.address}: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
    const current = context.manager.getRecord(recipientId);
    if (
      current !== recipient.record ||
      (current.resultGeneration ?? 1) !== generation ||
      current.session !== session ||
      current.cancellation?.generation === generation ||
      classifyMessageDelivery(current) !== "running"
    ) {
      // The recipient was retired, replaced, cancelled, or shut down while the
      // steer was in flight. Report that plainly and touch neither the event bus
      // nor the UI; retrying would duplicate an envelope the prior session may
      // already hold.
      return textResult(
        `Delivery to ${recipient.address} is stale: the recipient was replaced, cancelled, or shut down while the message was in flight.`,
        true,
      );
    }
  }

  context.pi.events.emit("subagents:message", {
    from: senderIdentity,
    to: recipient.address,
    toId: recipientId,
    type,
    queued: held,
  });
  return textResult(
    held
      ? `Message held for ${recipient.address} until its session starts.`
      : `Message steered to ${recipient.address}; it arrives at the recipient's next safe boundary.`,
  );
}

/** Build the root or nested peer-message tool. */
export function createAgentMessageTool(context: AgentMessageToolContext): ToolDefinition {
  return defineTool({
    name: AGENT_MESSAGE_TOOL_NAME,
    label: "Agent Message",
    description:
      "Send an agent-authored message to any live agent by its globally unique identity. " +
      "User instruction authority always outranks agent messages. Delivery uses Pi's shared FIFO " +
      "steering queue at safe boundaries, so this does not promise strict user-first scheduling.",
    promptSnippet: "Send a message to another live agent.",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient alias, handle, id, or /root." }),
      message: Type.String({ description: "Agent-authored message text." }),
      type: Type.Optional(
        Type.Union([Type.Literal("MESSAGE"), Type.Literal("TASK"), Type.Literal("FINAL")], {
          description:
            "MESSAGE = coordination/FYI; TASK = work request to an agent you own; FINAL = result summary to your parent.",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => deliverAgentMessage(context, params),
  });
}
