import { compile, lit, obj, oneOf, str } from "@earendil-works/pi-schema";

import { isFiniteNumber, isString } from "./guards.ts";
import { CUSTOM_ENTRY_TYPE } from "./types.ts";

// Both objects are open, as the previous TypeBox objects were: extra keys are accepted.
const isQueuedGoalTextPart = compile(obj({ type: lit("text"), text: str() }, { open: true })).check;
const activeGoalQueuedDetailsSchema = obj(
  {
    kind: oneOf(["continuation", "command_start", "command_resume"]),
    goalId: str(),
  },
  { open: true },
);
const isActiveGoalQueuedDetailsValue = compile(activeGoalQueuedDetailsSchema).check;

type GoalQueuedWorkKind = "continuation" | "command_start" | "command_resume";

export interface ActiveGoalQueuedDetails {
  kind: GoalQueuedWorkKind;
  goalId: string;
}

export interface QueuedGoalTextPart {
  readonly type: "text";
  readonly text: string;
}

export type QueuedGoalUserContent = QueuedGoalTextPart[];

/** External provider-context message shape before normalization. */
export interface QueuedGoalContextInput {
  role: string;
  customType?: string;
  content?: unknown;
  display?: boolean;
  details?: unknown;
  timestamp?: number;
}

/** Normalized provider-context carrier with required runtime fields. */
export interface QueuedGoalContextCarrier {
  role: string;
  timestamp: number;
  customType?: string;
  content?: unknown;
  display?: boolean;
  details?: unknown;
}

export interface QueuedGoalCustomMessage extends QueuedGoalContextCarrier {
  role: "custom";
  customType: typeof CUSTOM_ENTRY_TYPE;
  content: string | QueuedGoalUserContent;
  display: boolean;
}

export interface QueuedGoalUserMessage extends QueuedGoalContextCarrier {
  role: "user";
  content: QueuedGoalUserContent;
}

export type QueuedGoalWorkSourceMessage = QueuedGoalCustomMessage | QueuedGoalUserMessage;

/** Role/customType only — does not prove normalized content or display. */
interface QueuedGoalCustomRoleCarrier {
  role: "custom";
  customType: typeof CUSTOM_ENTRY_TYPE;
}

function isQueuedGoalCustomRole(
  message: QueuedGoalContextCarrier,
): message is QueuedGoalContextCarrier & QueuedGoalCustomRoleCarrier {
  return message.role === "custom" && message.customType === CUSTOM_ENTRY_TYPE;
}

export function userContentFromUnknown(
  content: QueuedGoalContextInput["content"],
): QueuedGoalUserContent {
  if (!Array.isArray(content)) {
    return [];
  }

  const parts: QueuedGoalTextPart[] = [];
  for (const part of content) {
    if (isQueuedGoalTextPart(part)) {
      parts.push({ type: "text", text: part.text });
    }
  }
  return parts;
}

function customContentFromUnknown(
  content: QueuedGoalContextInput["content"],
): string | QueuedGoalUserContent {
  if (isString(content)) {
    return content;
  }

  const normalized = userContentFromUnknown(content);
  return normalized.length > 0 ? normalized : "";
}

/** Copies provider-context fields into a carrier with the runtime-required timestamp. */
export function toQueuedGoalContextCarrier(
  message: QueuedGoalContextInput,
): QueuedGoalContextCarrier | null {
  if (!isFiniteNumber(message.timestamp)) {
    return null;
  }

  const carrier: QueuedGoalContextCarrier = {
    role: message.role,
    timestamp: message.timestamp,
  };
  if (message.customType !== undefined) {
    carrier.customType = message.customType;
  }
  if (message.content !== undefined) {
    carrier.content = message.content;
  }
  if (message.display !== undefined) {
    carrier.display = message.display;
  }
  if (message.details !== undefined) {
    carrier.details = message.details;
  }
  return carrier;
}

/** Narrows a carrier to queued-goal user/custom work and normalizes its content. */
export function toQueuedGoalWorkSource(
  message: QueuedGoalContextCarrier,
): QueuedGoalWorkSourceMessage | null {
  switch (message.role) {
    case "user":
      return {
        ...message,
        role: "user",
        content: userContentFromUnknown(message.content),
      };
    case "custom": {
      if (!isQueuedGoalCustomRole(message)) {
        return null;
      }
      const normalized: QueuedGoalCustomMessage = {
        role: "custom",
        customType: message.customType,
        timestamp: message.timestamp,
        content: customContentFromUnknown(message.content),
        display: message.display ?? false,
      };
      if (message.details !== undefined) {
        normalized.details = message.details;
      }
      return normalized;
    }
    default:
      return null;
  }
}

export function isActiveGoalQueuedDetails(
  details: QueuedGoalContextInput["details"],
): details is ActiveGoalQueuedDetails {
  return isActiveGoalQueuedDetailsValue(details);
}

export function isCommandResumeQueuedGoalMessage(message: QueuedGoalContextCarrier): boolean {
  return (
    isQueuedGoalCustomRole(message) &&
    isActiveGoalQueuedDetails(message.details) &&
    message.details.kind === "command_resume"
  );
}
