import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { legacyPiFallbacks } from "@choco-pi/shared/pi-paths";
import { pathExists } from "./fs-async.ts";
import { isSymlink, isUnsafeName, safeReadFile } from "./memory.ts";

export interface PreloadedSkill {
  name: string;
  content: string;
}

export function preloadSkills(skillNames: string[], cwd: string): Promise<PreloadedSkill[]> {
  return Promise.all(
    skillNames.map(async (name) => ({ name, content: await loadSkillContent(name, cwd) })),
  );
}

async function loadSkillContent(name: string, cwd: string): Promise<string> {
  if (isUnsafeName(name)) {
    return `(Skill "${name}" skipped: name contains path traversal characters)`;
  }
  const roots = skillRoots(cwd);
  for (const root of roots) {
    const content = await findInRoot(root, name);
    if (content !== undefined) return content;
  }
  return `(Skill "${name}" not found in .pi/skills/, .agents/skills/, or global skill locations)`;
}

export function skillRoots(cwd: string): string[] {
  return [
    join(cwd, ".pi", "skills"),
    join(cwd, ".agents", "skills"),
    join(getAgentDir(), "skills"),
    join(homedir(), ".agents", "skills"),
    ...legacyPiFallbacks(process.env, homedir()).map((root) => join(root, "skills")),
  ];
}

async function findInRoot(root: string, name: string): Promise<string | undefined> {
  if (await isSymlink(root)) return undefined;
  const flat = (await safeReadFile(join(root, `${name}.md`)))?.trim();
  if (flat !== undefined) return flat;
  return findSkillDirectory(root, name);
}

async function findSkillDirectory(root: string, name: string): Promise<string | undefined> {
  if (!(await pathExists(root))) return undefined;
  const queue: string[] = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;

    let entries: Dirent<string>[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const directories = entries.filter(
      (entry) =>
        entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules",
    );
    const probed = await Promise.all(
      directories.map(async (entry) => {
        const path = join(current, entry.name);
        const skillMd = join(path, "SKILL.md");
        return { entry, path, skillMd, isSkillDir: await pathExists(skillMd) };
      }),
    );
    for (const { entry, path, skillMd, isSkillDir } of probed) {
      if (isSkillDir) {
        if (entry.name === name) {
          const content = (await safeReadFile(skillMd))?.trim();
          if (content !== undefined) return content;
        }
        continue;
      }

      queue.push(path);
    }
  }
  return undefined;
}
