import { lstat, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { legacyPiFallbacks } from "@choco-pi/shared/pi-paths";
import { pathExists } from "./fs-async.ts";
import type { MemoryScope } from "./types.ts";

const MAX_MEMORY_LINES = 200;

export function isUnsafeName(name: string): boolean {
  if (!name || name.length > 128) return true;
  return !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

export async function isSymlink(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isSymbolicLink();
  } catch {
    return false;
  }
}

export async function safeReadFile(filePath: string): Promise<string | undefined> {
  if (!(await pathExists(filePath))) return undefined;
  if (await isSymlink(filePath)) return undefined;
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

export async function resolveMemoryDir(
  agentName: string,
  scope: MemoryScope,
  cwd: string,
): Promise<string> {
  if (isUnsafeName(agentName)) {
    throw new Error(`Unsafe agent name for memory directory: "${agentName}"`);
  }
  switch (scope) {
    case "user": {
      const current = join(getAgentDir(), "agent-memory", agentName);
      if (await pathExists(current)) return current;
      for (const root of legacyPiFallbacks(process.env, homedir())) {
        const legacy = join(root, "agent-memory", agentName);
        if ((await pathExists(legacy)) && !(await isSymlink(legacy))) return legacy;
      }
      return current;
    }
    case "project":
      return join(cwd, ".pi", "agent-memory", agentName);
    case "local":
      return join(cwd, ".pi", "agent-memory-local", agentName);
  }
}

export async function ensureMemoryDir(memoryDir: string): Promise<void> {
  if (await pathExists(memoryDir)) {
    if (await isSymlink(memoryDir)) {
      throw new Error(`Refusing to use symlinked memory directory: ${memoryDir}`);
    }
    return;
  }
  await mkdir(memoryDir, { recursive: true });
}

export async function readMemoryIndex(memoryDir: string): Promise<string | undefined> {
  if (await isSymlink(memoryDir)) return undefined;

  const memoryFile = join(memoryDir, "MEMORY.md");
  const content = await safeReadFile(memoryFile);
  if (content === undefined) return undefined;

  const lines = content.split("\n");
  if (lines.length > MAX_MEMORY_LINES) {
    return lines.slice(0, MAX_MEMORY_LINES).join("\n") + "\n... (truncated at 200 lines)";
  }
  return content;
}

export async function buildMemoryBlock(
  agentName: string,
  scope: MemoryScope,
  cwd: string,
): Promise<string> {
  const memoryDir = await resolveMemoryDir(agentName, scope, cwd);
  await ensureMemoryDir(memoryDir);

  const existingMemory = await readMemoryIndex(memoryDir);

  const header = `# Agent Memory

You have a persistent memory directory at: ${memoryDir}/
Memory scope: ${scope}

This memory persists across sessions. Use it to build up knowledge over time.`;

  const memoryContent = existingMemory
    ? `\n\n## Current MEMORY.md\n${existingMemory}`
    : `\n\nNo MEMORY.md exists yet. Create one at ${join(memoryDir, "MEMORY.md")} to start building persistent memory.`;

  const instructions = `

## Memory Instructions
- MEMORY.md is an index file — keep it concise (under 200 lines). Lines after 200 are truncated.
- Store detailed memories in separate files within ${memoryDir}/ and link to them from MEMORY.md.
- Each memory file should use this frontmatter format:
  \`\`\`markdown
  ---
  name: <memory name>
  description: <one-line description>
  type: <user|feedback|project|reference>
  ---
  <memory content>
  \`\`\`
- Update or remove memories that become outdated. Check for existing memories before creating duplicates.
- You have Read, Write, and Edit tools available for managing memory files.`;

  return header + memoryContent + instructions;
}

export async function buildReadOnlyMemoryBlock(
  agentName: string,
  scope: MemoryScope,
  cwd: string,
): Promise<string> {
  const memoryDir = await resolveMemoryDir(agentName, scope, cwd);
  const existingMemory = await readMemoryIndex(memoryDir);

  const header = `# Agent Memory (read-only)

Memory scope: ${scope}
You have read-only access to memory. You can reference existing memories but cannot create or modify them.`;

  const memoryContent = existingMemory
    ? `\n\n## Current MEMORY.md\n${existingMemory}`
    : `\n\nNo memory is available yet. Other agents or sessions with write access can create memories for you to consume.`;

  return header + memoryContent;
}
