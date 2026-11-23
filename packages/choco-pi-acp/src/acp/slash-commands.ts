import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { piAgentDir } from "@choco-pi/shared/pi-paths";

export type FileSlashCommand = {
  name: string;
  description: string;
  content: string;
  source: string;
};

type ParsedPromptFile = {
  frontmatter: Record<string, string>;
  content: string;
};

function parseFrontmatter(content: string): ParsedPromptFile {
  const frontmatter: Record<string, string> = {};

  if (!content.startsWith("---")) return { frontmatter, content };

  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) return { frontmatter, content };

  const frontmatterBlock = content.slice(4, endIndex);
  const remaining = content.slice(endIndex + 4).trim();

  for (const line of frontmatterBlock.split("\n")) {
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (match) frontmatter[match[1]] = match[2].trim();
  }

  return { frontmatter, content: remaining };
}

function loadCommandsFromDir(
  dir: string,
  source: "user" | "project",
  subdir = "",
): FileSlashCommand[] {
  const commands: FileSlashCommand[] = [];
  if (!existsSync(dir)) return commands;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        const newSubdir = subdir ? `${subdir}:${entry.name}` : entry.name;
        commands.push(...loadCommandsFromDir(fullPath, source, newSubdir));
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

      try {
        const rawContent = readFileSync(fullPath, "utf-8");
        const { frontmatter, content } = parseFrontmatter(rawContent);

        const name = entry.name.slice(0, -3);

        const sourceStr =
          source === "user"
            ? subdir
              ? `(user:${subdir})`
              : "(user)"
            : subdir
              ? `(project:${subdir})`
              : "(project)";

        let description = frontmatter.description || "";
        if (!description) {
          const firstLine = content.split("\n").find((l) => l.trim());
          if (firstLine) {
            description = firstLine.slice(0, 60);
            if (firstLine.length > 60) description += "...";
          }
        }

        description = description ? `${description} ${sourceStr}` : sourceStr;

        commands.push({
          name,
          description,
          content,
          source: sourceStr,
        });
      } catch {}
    }
  } catch {}

  return commands;
}

export function loadSlashCommands(cwd: string): FileSlashCommand[] {
  const commands: FileSlashCommand[] = [];

  const userDir = join(piAgentDir(process.env), "prompts");
  const projectDir = resolve(cwd, ".pi", "prompts");

  commands.push(...loadCommandsFromDir(userDir, "user"));
  commands.push(...loadCommandsFromDir(projectDir, "project"));

  return commands;
}

export function toAvailableCommands(fileCommands: FileSlashCommand[]): AvailableCommand[] {
  const seen = new Set<string>();
  const out: AvailableCommand[] = [];

  for (const c of fileCommands) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);

    out.push({
      name: c.name,
      description: c.description,
    });
  }

  return out;
}

export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (let i = 0; i < argsString.length; i++) {
    const ch = argsString[i];

    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      else current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }

  if (current) args.push(current);
  return args;
}

export function substituteArgs(content: string, args: string[]): string {
  let result = content;

  result = result.replace(/\$@/g, args.join(" "));
  result = result.replace(/\$(\d+)/g, (_m, num) => {
    const idx = Number.parseInt(String(num), 10) - 1;
    return args[idx] ?? "";
  });

  return result;
}

export function expandSlashCommand(text: string, fileCommands: FileSlashCommand[]): string {
  if (!text.startsWith("/")) return text;

  const spaceIndex = text.indexOf(" ");
  const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
  const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

  const cmd = fileCommands.find((c) => c.name === commandName);
  if (!cmd) return text;

  const args = parseCommandArgs(argsString);
  return substituteArgs(cmd.content, args);
}
