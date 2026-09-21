import {
  getCurrentSystemMessage,
  getCurrentTools,
  normalizeContext,
  type Context,
  type SystemMessage,
} from "@earendil-works/pi-ai";

export function projectForcedPromptContext(
  activePrompt: string,
  suppliedTools: NonNullable<Context["tools"]>,
  messages: Context["messages"],
): ReturnType<typeof normalizeContext> {
  const current = getCurrentSystemMessage(messages);
  const transcriptTools = getCurrentTools(messages);
  const tools = current === undefined ? suppliedTools : transcriptTools;
  const head: SystemMessage = {
    role: "system" as const,
    content: activePrompt,
    timestamp: current?.timestamp ?? Date.now(),
  };
  if (tools.length > 0) head.toolsAdded = tools;
  return normalizeContext({
    messages: [head, ...messages.filter((message) => message.role !== "system")],
  });
}
