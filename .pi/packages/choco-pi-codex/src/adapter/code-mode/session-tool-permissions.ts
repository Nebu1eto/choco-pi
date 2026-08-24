interface NamedTool {
  name: string;
}

export interface SessionToolSource {
  getActiveTools(): string[];
  getAllTools(): NamedTool[];
}

/** Resolve the registered tools the session selected before Code Mode replaced its outer tool set. */
export function activeRegisteredSessionToolNames(
  source: SessionToolSource,
  preAdapterToolNames?: readonly string[] | undefined,
): ReadonlySet<string> {
  const registeredNames = new Set(source.getAllTools().map((tool) => tool.name));
  const selectedNames = preAdapterToolNames ?? source.getActiveTools();
  return new Set(selectedNames.filter((name) => registeredNames.has(name)));
}

/**
 * Pin a permission-restricted session to the restricted `code` runtime.
 *
 * Filtering the tools namespace is the whole attack surface in `code`, whose
 * cells hold nothing but the injected tools. A notebook cell instead runs on
 * shared Deno globals with `Deno`, npm imports and Web APIs, so `Deno.writeTextFile`
 * would reopen every path this module closes. A session that already holds
 * `bash` or file mutation keeps the notebook, which grants it nothing new.
 */
export function codeModeExecutionKindForPermissions(
  requested: "code" | "notebook",
  activeToolNames: ReadonlySet<string>,
): "code" | "notebook" {
  if (requested !== "notebook") return requested;
  const canMutateFiles = activeToolNames.has("edit") || activeToolNames.has("write");
  if (canMutateFiles || activeToolNames.has("bash")) return "notebook";
  return "code";
}

/** Keep native Code Mode capabilities no stronger than the corresponding Pi permissions. */
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
