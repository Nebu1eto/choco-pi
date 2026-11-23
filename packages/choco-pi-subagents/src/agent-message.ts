import {
  type AgentSession,
  defineTool,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { hostParams } from "./schema-bridge.ts";
import { mayTriggerTurn } from "@choco-pi/shared/stop-control";
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

export type QueuedInputDisposition = Awaited<ReturnType<AgentSession["steer"]>>;

export interface SteerableAgentSession {
  steer(message: string): Promise<QueuedInputDisposition>;
}

export interface AgentMessageRecord extends MessagingRecord {
  admissionRoot?: string;
  admissionEpoch?: number;
  session?: SteerableAgentSession;
  pendingSteers?: string[];
}

export interface AgentMessageManager {
  getRecord(id: string): AgentMessageRecord | undefined;
  listAgents(): AgentMessageRecord[];
}

export interface AgentMessageToolContext {
  manager: AgentMessageManager;
  pi: Pick<ExtensionAPI, "events" | "sendMessage">;
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

export async function deliverAgentMessage(
  context: AgentMessageToolContext,
  params: AgentMessageParams,
) {
  const lookup = (id: string) => context.manager.getRecord(id);
  let senderIdentity = ROOT_AGENT_PATH;
  let senderRoot: string | undefined;
  let senderEpoch: number | undefined;
  if (context.senderAgentId) {
    const sender = lookup(context.senderAgentId);
    if (!sender) {
      return textResult(`Calling agent not found: "${context.senderAgentId}".`, true);
    }
    try {
      senderIdentity = getAgentIdentity(sender);
      senderRoot = sender.admissionRoot;
      senderEpoch = sender.admissionEpoch;
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
      {
        deliverAs: "steer",
        triggerTurn: mayTriggerTurn(senderRoot, senderEpoch),
      },
    );
    context.pi.events.emit("subagents:message", {
      from: senderIdentity,
      to: recipient.address,
      toId: undefined,
      type,
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
  const recipientId = recipient.record.id;
  const generation = recipient.record.resultGeneration ?? 1;
  let disposition: QueuedInputDisposition | undefined;
  if (held) {
    recipient.record.pendingSteers ??= [];
    recipient.record.pendingSteers.push(envelope);
  } else {
    try {
      disposition = await session.steer(envelope);
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
  if (held) return textResult(`Message held for ${recipient.address} until its session starts.`);
  if (disposition === "handled") {
    return textResult(
      `Message to ${recipient.address} was handled by an input handler in the recipient's session and was not queued; the recipient's model will not receive it as a message.`,
    );
  }
  return textResult(
    `Message steered to ${recipient.address}; it arrives at the recipient's next safe boundary.`,
  );
}

export function createAgentMessageTool(context: AgentMessageToolContext): ToolDefinition {
  return defineTool({
    name: AGENT_MESSAGE_TOOL_NAME,
    label: "Agent Message",
    description:
      "Send an agent-authored message to any live agent by its globally unique identity. " +
      "User instruction authority always outranks agent messages. Delivery uses Pi's shared FIFO " +
      "steering queue at safe boundaries, so this does not promise strict user-first scheduling.",
    promptSnippet: "Send a message to another live agent.",
    parameters: hostParams(
      obj(
        {
          to: str({ description: "Recipient alias, handle, id, or /root." }),
          message: str({ description: "Agent-authored message text." }),
          type: opt(
            oneOf(["MESSAGE", "TASK", "FINAL"], {
              description:
                "MESSAGE = coordination/FYI; TASK = work request to an agent you own; FINAL = result summary to your parent.",
            }),
          ),
        },
        { open: true },
      ),
    ),
    execute: async (_toolCallId, params) => deliverAgentMessage(context, params),
  });
}
