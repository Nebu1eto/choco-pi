import { getFileKindsForExtension } from "./file-kinds.ts";
import { LSP_SERVERS } from "./lsp/server.ts";

export interface LspStatusSelection {
  activeIds: string[];
  failedIds: string[];
}

function serverById(id: string) {
  return LSP_SERVERS.find((s) => s.id === id);
}

export function selectLspStatus(
  aliveServerIds: string[],
  failedServerIds: string[],
  sessionKinds: string[],
): LspStatusSelection {
  const aliveSet = new Set(aliveServerIds);
  const aliveLangExts = new Set<string>();
  for (const s of LSP_SERVERS) {
    if (s.role === "auxiliary" || !aliveSet.has(s.id)) continue;
    for (const ext of s.extensions) aliveLangExts.add(ext.toLowerCase());
  }

  const sessionKindSet = new Set(sessionKinds);
  const failedIds: string[] = [];
  const seen = new Set<string>();
  for (const id of failedServerIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const server = serverById(id);
    if (!server || server.role === "auxiliary") continue;
    const exts = server.extensions.map((e) => e.toLowerCase());
    if (exts.some((e) => aliveLangExts.has(e))) continue;
    const kinds = new Set<string>();
    for (const e of exts) for (const k of getFileKindsForExtension(e)) kinds.add(k);
    if (![...kinds].some((k) => sessionKindSet.has(k))) continue;
    failedIds.push(id);
  }

  return { activeIds: [...aliveServerIds], failedIds };
}
