import {
  CORE_ADAPTER_TOOL_NAMES,
  DEFAULT_TOOL_NAMES,
  IMAGE_GENERATION_TOOL_NAME,
  NOTEBOOK_MODE_TOOL_NAMES,
  VIEW_IMAGE_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from "./tool-set.ts";

const ALL_CODEX_ADAPTER_TOOL_NAMES = [
  ...CORE_ADAPTER_TOOL_NAMES,
  ...NOTEBOOK_MODE_TOOL_NAMES,
  WEB_SEARCH_TOOL_NAME,
  IMAGE_GENERATION_TOOL_NAME,
  VIEW_IMAGE_TOOL_NAME,
];

export function mergeAdapterTools(
  activeTools: string[],
  adapterTools: string[],
  adapterOwnedTools: string[] = adapterTools,
): string[] {
  const owned = new Set([...adapterTools, ...adapterOwnedTools]);
  const preserved = activeTools.filter(
    (name) => !DEFAULT_TOOL_NAMES.includes(name) && !owned.has(name),
  );
  return [...adapterTools, ...preserved];
}

export function restoreTools(
  previousTools: string[],
  activeTools: string[],
  adapterOwnedTools: string[] = ALL_CODEX_ADAPTER_TOOL_NAMES,
): string[] {
  const restored = stripAdapterTools(previousTools, adapterOwnedTools);
  for (const name of activeTools)
    if (!adapterOwnedTools.includes(name) && !restored.includes(name)) restored.push(name);
  return restored;
}

export function stripAdapterTools(
  toolNames: string[],
  adapterOwnedTools: string[] = ALL_CODEX_ADAPTER_TOOL_NAMES,
): string[] {
  return toolNames.filter((name) => !adapterOwnedTools.includes(name));
}
