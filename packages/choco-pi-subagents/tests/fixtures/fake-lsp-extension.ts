import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { obj } from "@earendil-works/pi-schema";
import { hostParams } from "../../src/schema-bridge.ts";
import { type HostValue, isHostObject, isString } from "../../src/value-guards.ts";

export interface FakeLspCall {
  name: string;
  operation: string | undefined;
}

declare global {
  var chocoPiFakeLspCalls: FakeLspCall[] | undefined;
}

export function fakeLspCalls(): FakeLspCall[] {
  globalThis.chocoPiFakeLspCalls ??= [];
  return globalThis.chocoPiFakeLspCalls;
}

export const FAKE_LSP_ACTIVE_TOOLS = ["read_symbol", "read_enclosing", "symbol_search"];
export const FAKE_LSP_SITUATIONAL_TOOLS = [
  "ast_grep_search",
  "ast_grep_replace",
  "ast_grep_outline",
  "ast_grep_dump",
  "lsp_navigation",
  "diagnostic_mark",
];

function operationOf(params: HostValue): string | undefined {
  if (!isHostObject(params)) return undefined;
  if ("operation" in params && isString(params.operation)) return params.operation;
  if ("disposition" in params && isString(params.disposition)) return params.disposition;
  return undefined;
}

export default function fakeLspExtension(pi: ExtensionAPI): void {
  const register = (name: string, defaultActive: boolean) =>
    pi.registerTool({
      name,
      label: name,
      description: `fake ${name}`,
      parameters: hostParams(obj({}, { open: true })),
      defaultActive,
      execute: async (_toolCallId, params) => {
        fakeLspCalls().push({ name, operation: operationOf(params) });
        return { content: [{ type: "text", text: `${name} ran` }], details: {} };
      },
    });
  for (const name of FAKE_LSP_ACTIVE_TOOLS) register(name, true);
  for (const name of [...FAKE_LSP_SITUATIONAL_TOOLS, "lsp_activate_tools"]) register(name, false);
}
