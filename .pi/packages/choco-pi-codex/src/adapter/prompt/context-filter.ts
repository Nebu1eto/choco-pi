import type { BoundaryValue } from "../runtime-values.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { CustomMessageEntry } from "@earendil-works/pi-coding-agent";
import { NATIVE_COMPACTION_DISPLAY_MESSAGE_TYPE } from "../compaction/types.ts";
import { EXECUTION_MODE_SESSION_ENTRY } from "../activation/execution-mode.ts";

// Voice and Notebook Mode were removed from this fork, but sessions recorded by
// the upstream package may still contain their custom entries. The message-type
// strings are inlined verbatim so replay and compaction keep excluding them
// exactly as upstream did.
const REALTIME_VOICE_MESSAGE_TYPE = "codex-realtime-voice";
const CODEX_VOICE_MODE_MESSAGE_TYPE = "codex-voice-mode";
const NOTEBOOK_TREE_EPOCH_ENTRY = "pi-codex-conversion-notebook-tree-epoch";

const ADAPTER_CONTEXT_EXCLUDED_CUSTOM_MESSAGE_TYPES = new Set([
  NATIVE_COMPACTION_DISPLAY_MESSAGE_TYPE,
  EXECUTION_MODE_SESSION_ENTRY,
  NOTEBOOK_TREE_EPOCH_ENTRY,
]);

function isVoiceContextExcludedMessage(message: {
  role: string;
  customType?: string | undefined;
  content?: BoundaryValue;
}): boolean {
  if (message.role !== "custom") return false;
  if (message.customType === REALTIME_VOICE_MESSAGE_TYPE) return true;
  return (
    message.customType === CODEX_VOICE_MODE_MESSAGE_TYPE &&
    (!Value.Check(Type.String(), message.content) ||
      !message.content.startsWith('<realtime_voice_session state="'))
  );
}

export function isProviderContextExcludedMessage(message: {
  role: string;
  customType?: string | undefined;
  content?: BoundaryValue;
}): boolean {
  return (
    isVoiceContextExcludedMessage(message) ||
    (message.role === "custom" &&
      Value.Check(Type.String(), message.customType) &&
      ADAPTER_CONTEXT_EXCLUDED_CUSTOM_MESSAGE_TYPES.has(message.customType))
  );
}

export function isProviderContextExcludedCustomMessageEntry(entry: CustomMessageEntry): boolean {
  return isProviderContextExcludedMessage({
    role: "custom",
    customType: entry.customType,
    content: entry.content,
  });
}
