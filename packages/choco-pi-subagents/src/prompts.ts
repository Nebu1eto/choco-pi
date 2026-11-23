import type { AgentConfig, EnvInfo } from "./types.ts";

export const READ_ONLY_SIDE_CONVERSATION_TOOLS = ["read", "find", "ls"] as const;

const READ_ONLY_SIDE_CONVERSATION_BLOCK = `<read_only_side_conversation>
You are answering a parallel side conversation owned by the main orchestrator.
Use the inherited conversation only as context. Do not edit files, run commands, delegate work, or alter the main conversation.
You may inspect the project with read, find, and ls when needed, then answer the user's question directly.
</read_only_side_conversation>`;

export function buildReadOnlySideConversationPrompt(parentSystemPrompt: string): string {
  return `${parentSystemPrompt}\n\n${READ_ONLY_SIDE_CONVERSATION_BLOCK}`;
}

export interface ToolSurface {
  codeMode: boolean;
  tools: readonly string[];
}

const DEFAULT_TOOL_SURFACE: ToolSurface = {
  codeMode: false,
  tools: ["read", "bash", "edit", "write", "find", "ls"],
};

const NORMAL_TOOL_LINES: ReadonlyArray<readonly [string, string]> = [
  ["read", "Use the read tool instead of cat/head/tail"],
  ["edit", "Use the edit tool instead of sed/awk"],
  ["write", "Use the write tool instead of echo/heredoc"],
  ["find", "Use the find tool instead of bash find/ls for file search"],
  ["grep", "Use the grep tool instead of bash grep/rg for content search"],
];

export function buildToolGuidance(surface: ToolSurface): string[] {
  const has = new Set(surface.tools);
  const lines: string[] = [];
  if (surface.codeMode) {
    lines.push(
      has.has("exec_command")
        ? "Code Mode has no read or grep tool: read and search files with tools.exec_command (rg, sed -n) inside exec"
        : "Code Mode has no read or grep tool",
    );
    if (has.has("apply_patch")) lines.push("Edit files with tools.apply_patch inside exec");
    lines.push(
      has.has("tool_search")
        ? "Call Pi tools as tools.<name> inside exec; the exec description lists them and tool_search finds the rest"
        : "Call Pi tools as tools.<name> inside exec; the exec description lists them",
    );
    return lines;
  }
  for (const [name, line] of NORMAL_TOOL_LINES) if (has.has(name)) lines.push(line);
  if (has.has("exec_command") && !has.has("read"))
    lines.push("Read and search files with exec_command (rg, sed -n)");
  if (has.has("apply_patch") && !has.has("edit")) lines.push("Edit files with apply_patch");
  if (has.has("tool_search")) lines.push("Use tool_search to find tools that are not loaded yet");
  return lines;
}

export interface PromptExtras {
  memoryBlock?: string;
  skillBlocks?: { name: string; content: string }[];
  worktreeBase?: string;
  readOnly?: boolean;
  scratchLine?: string;
  toolSurface?: ToolSurface;
}

export function buildAgentPrompt(
  config: AgentConfig,
  cwd: string,
  env: EnvInfo,
  parentSystemPrompt?: string,
  extras?: PromptExtras,
): string {
  const activeAgentTag = `<active_agent name="${config.name}"/>\n\n`;

  const envBlock = `# Environment
Working directory: ${cwd}
${env.isGitRepo ? `Git repository: yes\nBranch: ${env.branch}` : "Not a git repository"}
Platform: ${env.platform}${extras?.scratchLine ? `\n${extras.scratchLine}` : ""}`;

  const worktreeBlock = extras?.worktreeBase
    ? `\n\n<worktree_isolation>
Your working directory is an isolated git worktree copy of ${extras.worktreeBase}.
Work only inside it — never in ${extras.worktreeBase}, even if other instructions name that path as your working directory.
</worktree_isolation>`
    : "";

  const extraSections: string[] = [];
  if (extras?.memoryBlock) {
    extraSections.push(extras.memoryBlock);
  }
  if (extras?.skillBlocks?.length) {
    for (const skill of extras.skillBlocks) {
      extraSections.push(`\n# Preloaded Skill: ${skill.name}\n${skill.content}`);
    }
  }
  if (extras?.readOnly) {
    extraSections.push(READ_ONLY_SIDE_CONVERSATION_BLOCK);
  }
  const extrasSuffix = extraSections.length > 0 ? "\n\n" + extraSections.join("\n") : "";

  if (config.promptMode === "append") {
    const identity = parentSystemPrompt || genericBase;
    const toolLines = buildToolGuidance(extras?.toolSurface ?? DEFAULT_TOOL_SURFACE)
      .map((line) => `- ${line}\n`)
      .join("");

    const bridge = `<sub_agent_context>
You are operating as a sub-agent invoked to handle a specific task.
${toolLines}- Make independent tool calls in parallel
- Use absolute file paths
- Do not use emojis
- Be concise but complete
</sub_agent_context>`;

    const customSection = config.systemPrompt?.trim()
      ? `\n\n<agent_instructions>\n${config.systemPrompt}\n</agent_instructions>`
      : "";

    return (
      identity +
      "\n\n" +
      bridge +
      "\n\n" +
      activeAgentTag +
      envBlock +
      worktreeBlock +
      customSection +
      extrasSuffix
    );
  }

  const replaceHeader = `You are a pi coding agent sub-agent.
You have been invoked to handle a specific task autonomously.

${envBlock}`;

  return (
    activeAgentTag + replaceHeader + worktreeBlock + "\n\n" + config.systemPrompt + extrasSuffix
  );
}

const genericBase = `# Role
You are a general-purpose coding agent for complex, multi-step tasks.
You have full access to read, write, edit files, and execute commands.
Do what has been asked; nothing more, nothing less.`;
