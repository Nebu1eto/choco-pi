export function unavailableToolsGuardPreamble(toolNames: readonly string[]): string {
  const availableTools = JSON.stringify(toolNames.join(", "));
  return [
    "globalThis.tools=new Proxy(globalThis.tools,{",
    "get(target,property,receiver){",
    'if(typeof property==="string"&&!Reflect.has(target,property))',
    `throw new Error('"'+property+'" is not available in code mode. Available tools: '+${availableTools}+'. If it exists as a regular tool, call it directly as a tool call outside exec.');`,
    "return Reflect.get(target,property,receiver);",
    "}});",
  ].join("");
}
