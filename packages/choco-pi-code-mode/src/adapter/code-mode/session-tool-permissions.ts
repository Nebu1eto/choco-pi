interface NamedTool {
  name: string;
}

export interface SessionToolSource {
  getActiveTools(): string[];
  getAllTools(): NamedTool[];
}

export function activeRegisteredSessionToolNames(
  source: SessionToolSource,
  preAdapterToolNames?: readonly string[] | undefined,
): ReadonlySet<string> {
  const registeredNames = new Set(source.getAllTools().map((tool) => tool.name));
  const selectedNames = preAdapterToolNames ?? source.getActiveTools();
  return new Set(selectedNames.filter((name) => registeredNames.has(name)));
}

export function codeModeExecutionKindForPermissions(
  requested: "code" | "notebook",
  activeToolNames: ReadonlySet<string>,
): "code" | "notebook" {
  if (requested !== "notebook") return requested;
  const canMutateFiles = activeToolNames.has("edit") || activeToolNames.has("write");
  if (canMutateFiles || activeToolNames.has("bash")) return "notebook";
  return "code";
}

export function scopeCodeModeToolsToSessionPermissions<Tool extends NamedTool>(
  tools: readonly Tool[],
  activeToolNames: ReadonlySet<string>,
): Tool[] {
  const canMutateFiles = activeToolNames.has("edit") || activeToolNames.has("write");
  const canRunShellCommands = activeToolNames.has("bash");
  return tools.filter((tool) => {
    if (tool.name === "apply_patch") return canMutateFiles;
    if (tool.name === "exec_command" || tool.name === "write_stdin") {
      return canRunShellCommands;
    }
    return true;
  });
}
