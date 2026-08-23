import type { CodeModeToolDefinition, CodeModeToolIdentity } from "./types.ts";

const DEFAULT_TOOL_NAMESPACE = "functions";

export function resolveCodeModeToolIdentity(tool: CodeModeToolDefinition): CodeModeToolIdentity {
  return tool.toolName ?? { name: tool.name };
}

export function codeModeNameForToolIdentity(identity: CodeModeToolIdentity): string {
  const namespace = identity.namespace;
  if (!namespace || namespace === DEFAULT_TOOL_NAMESPACE) return identity.name;
  return namespace.endsWith("_") || identity.name.startsWith("_")
    ? `${namespace}${identity.name}`
    : `${namespace}__${identity.name}`;
}

export function codeModeToolDisplayName(name: string, label?: string): string {
  const explicit = label?.trim();
  if (explicit) return explicit;
  const words = name.replaceAll("__", " ").replaceAll(/[_-]+/g, " ").trim();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : name;
}
