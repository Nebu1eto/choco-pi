export function unavailableToolsGuardPreamble(
  toolNames: readonly string[],
  outsideToolNames: readonly string[] = [],
): string {
  const availableTools = JSON.stringify(
    [...toolNames].sort((left, right) => left.localeCompare(right)),
  );
  const outsideTools = JSON.stringify(
    [...outsideToolNames].sort((left, right) => left.localeCompare(right)),
  );
  return [
    "globalThis.tools=((__codeModeTools,__directPiTools)=>{",
    "const __toolDistance=(a,b)=>{let p=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){let c=[i];for(let j=1;j<=b.length;j++)c[j]=Math.min(c[j-1]+1,p[j]+1,p[j-1]+(a[i-1]===b[j-1]?0:1));p=c;}return p[b.length];};",
    "return new Proxy(globalThis.tools,{",
    "get(target,property,receiver){",
    'if(typeof property==="string"&&!Reflect.has(target,property)){',
    "const suggestions=[...new Set([...__codeModeTools,...__directPiTools])].filter(name=>name!==property).map(name=>({name,d:__toolDistance(property,name)})).filter(({d})=>d<=Math.max(2,Math.floor(property.length/3))).sort((a,b)=>a.d-b.d||a.name.localeCompare(b.name)).slice(0,3).map(({name})=>name+(__directPiTools.includes(name)&&!__codeModeTools.includes(name)?' (direct Pi tool only)':''));",
    "const direct=__directPiTools.includes(property);",
    "throw new Error('Code mode tool error [unavailable_tool]: tools.'+property+' is not available in this cell. Available tools: '+(__codeModeTools.join(', ')||'(none)')+'. Close matches: '+(suggestions.join(', ')||'(none)')+'. Outside code mode: '+(direct?'yes — '+property+' is registered as a direct Pi tool; call it directly outside exec when active':'no — it is not registered as a direct Pi tool either')+'.');",
    "}",
    "return Reflect.get(target,property,receiver);",
    "}});",
    `})(${availableTools},${outsideTools});`,
  ].join("");
}
