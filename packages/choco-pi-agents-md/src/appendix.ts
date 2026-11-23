import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export type AgentsFileSource = "project" | "trusted-root";

export interface AgentsFileEntry {
  path: string;
  content: string;
  source: AgentsFileSource;
}

export interface ForeignAgentsFile {
  path: string;
  bytes: number;
}

export const MAX_FILE_CHARS = 12_000;
export const MAX_TOTAL_APPENDIX_CHARS = 40_000;

const TRUNCATION_MARKER = "\n...[truncated by choco-pi-agents-md size cap]";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function capFileContent(content: string): string {
  if (content.length <= MAX_FILE_CHARS) return content;
  return `${content.slice(0, MAX_FILE_CHARS)}${TRUNCATION_MARKER}`;
}

export function capTotalAppendixSize(files: AgentsFileEntry[]): AgentsFileEntry[] {
  const kept = [...files];
  let total = kept.reduce((sum, file) => sum + file.content.length, 0);
  while (total > MAX_TOTAL_APPENDIX_CHARS && kept.length > 1) {
    const dropped = kept.shift();
    if (!dropped) break;
    total -= dropped.content.length;
  }
  return kept;
}

export function appendAgentsContext(
  content: (TextContent | ImageContent)[],
  files: AgentsFileEntry[],
  foreignFiles: ForeignAgentsFile[] = [],
): (TextContent | ImageContent)[] {
  const appended: TextContent[] = [];
  if (files.length) {
    const appendix = [
      "<subdirectory_agents_context>",
      "AGENTS.md context relevant to this tool result.",
      ...files.map(
        (file) =>
          `<agents_file path="${escapeXml(file.path)}" source="${file.source}">\n${escapeXml(file.content)}\n</agents_file>`,
      ),
      "</subdirectory_agents_context>",
    ].join("\n");
    appended.push({ type: "text", text: appendix });
  }
  if (foreignFiles.length) {
    const pointers = foreignFiles.map(
      (file) =>
        `<foreign_agents_file path="${escapeXml(file.path)}" bytes="${file.bytes}" note="outside the project root; read it as evidence if needed"/>`,
    );
    appended.push({ type: "text", text: pointers.join("\n") });
  }
  return appended.length ? [...content, ...appended] : content;
}
