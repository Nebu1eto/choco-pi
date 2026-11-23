import type { ProtocolDictionary } from "./runtime-values.ts";
import type { RuntimeValue } from "./runtime-values.ts";
import { isRuntimeFunction, isRuntimeObject, isRuntimeString } from "./runtime-values.ts";

import { arr, obj, oneOf } from "@earendil-works/pi-schema";
import { hostParams } from "./schema-bridge.ts";

const PREFIX_LOCK_SYMBOL = Symbol.for("choco-pi.prefix.locked");

function isPrefixLocked(): boolean {
  const prefixLock = Object.getOwnPropertyDescriptor(globalThis, PREFIX_LOCK_SYMBOL)?.value;
  if (!isRuntimeObject(prefixLock) || prefixLock === null) return false;
  const isLocked = Object.getOwnPropertyDescriptor(prefixLock, "isLocked")?.value;
  return isRuntimeFunction(isLocked) && isLocked() === true;
}

export interface ActivatableToolInfo {
  name: string;
  summary: string;
}

export type ActiveToolsHost = {
  getActiveTools?: () => string[];
  setActiveTools?: (names: string[]) => void;
};

export interface ActivateToolsOptions {
  deferredToolSupport?: (ctx: RuntimeValue) => boolean;
  onActivated?: (names: string[]) => void;
  onMutation?: (mutation: {
    addedCount: number;
    removedCount: number;
    reason: "lazy_activation";
    deferralApplies: boolean;
  }) => void;
}

export function createActivateToolsTool(
  pi: ActiveToolsHost,
  lazyTools: ActivatableToolInfo[],
  options: ActivateToolsOptions = {},
) {
  const lazyNames = lazyTools.map((t) => t.name);
  const lazyNameSet = new Set(lazyNames);
  const catalog = lazyTools.map((t) => `${t.name} — ${t.summary}`).join("\n");

  return {
    name: "lsp_activate_tools" as const,
    label: "Activate choco-pi-lsp Tools",
    description:
      "Activate one or more situational choco-pi-lsp tools that stay registered but inactive by default, so the default tool list stays lean. " +
      "Call this ONCE with the tools you need before using them — they become callable starting the NEXT turn. " +
      `Available:\n${catalog}`,
    promptSnippet: "Activate situational ast-grep / lsp_navigation tools before using them",
    parameters: hostParams(
      obj(
        {
          tools: arr(oneOf(lazyNames), {
            minItems: 1,
            description:
              "Names of situational tools to activate (see this tool's description for the catalog).",
          }),
        },
        { open: true },
      ),
    ),
    async execute(
      _toolCallId: string,
      params: ProtocolDictionary,
      _signal: AbortSignal | undefined,
      _onUpdate: RuntimeValue,
      ctx?: RuntimeValue,
    ) {
      const requested = Array.isArray(params.tools)
        ? // SAFETY: The tool schema or typed LSP producer establishes this shape; consumers validate optional response fields before use.
          (params.tools as unknown[]).filter(
            (t): t is string => isRuntimeString(t) && lazyNameSet.has(t),
          )
        : [];

      if (requested.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No valid tool names given. Available: ${lazyNames.join(", ")}`,
            },
          ],
          isError: true,
          details: { matches: [], added: [] },
        };
      }

      if (isPrefixLocked()) {
        const entries = requested
          .map((name) => {
            const summary = lazyTools.find((tool) => tool.name === name)?.summary ?? "";
            return `- ${name}: ${summary}\n  Call: await tools.${name}({ ...args })`;
          })
          .join("\n");
        return {
          content: [
            {
              type: "text" as const,
              text: `The provider tool list is locked. Call through exec instead:\n${entries}`,
            },
          ],
          details: { matches: requested, added: [] },
        };
      }

      options.onActivated?.(requested);

      const active = pi.getActiveTools?.() ?? [];
      const activeSet = new Set(active);
      const added = requested.filter((name) => !activeSet.has(name));
      const merged = [...new Set([...active, ...added])];
      if (added.length > 0 && pi.setActiveTools) {
        pi.setActiveTools(merged);
        options.onMutation?.({
          addedCount: added.length,
          removedCount: 0,
          reason: "lazy_activation",
          deferralApplies: options.deferredToolSupport?.(ctx) ?? false,
        });
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Activated: ${requested.join(", ")}. Available starting next turn.`,
          },
        ],
        details: { matches: requested, added },
      };
    },
  };
}
