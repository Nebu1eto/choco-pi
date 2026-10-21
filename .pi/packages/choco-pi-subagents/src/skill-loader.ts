/**
 * skill-loader.ts — Preload named skills.
 *
 * Roots, in precedence order:
 *   - <cwd>/.pi/skills           (project, Pi's standard)
 *   - <cwd>/.agents/skills       (project, cross-tool Agent Skills spec — https://agentskills.io)
 *   - getAgentDir()/skills       (user, default ~/.pi/agent/skills — Pi's standard)
 *   - ~/.agents/skills           (user, cross-tool Agent Skills spec)
 *   - ~/.pi/skills               (legacy global, pre-Pi)
 *
 * Layout per root:
 *   - <root>/<name>.md            (flat file at the top level)
 *   - <root>/.../<name>/SKILL.md  (directory skill, may be nested — Pi's standard)
 *
 * Recursion skips dotfile entries and node_modules. A directory that itself contains
 * SKILL.md is a skill — we don't descend into it (Pi: skills don't nest).
 *
 * Symlinks are rejected for security (deviation from Pi, which follows them).
 */

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { pathExists } from "./fs-async.ts";
import { isSymlink, isUnsafeName, safeReadFile } from "./memory.ts";

export interface PreloadedSkill {
  name: string;
  content: string;
}

/** Load every named skill concurrently; the result keeps `skillNames` order. */
export function preloadSkills(skillNames: string[], cwd: string): Promise<PreloadedSkill[]> {
  return Promise.all(
    skillNames.map(async (name) => ({ name, content: await loadSkillContent(name, cwd) })),
  );
}

async function loadSkillContent(name: string, cwd: string): Promise<string> {
  if (isUnsafeName(name)) {
    return `(Skill "${name}" skipped: name contains path traversal characters)`;
  }
  const roots = [
    join(cwd, ".pi", "skills"), // project — Pi standard
    join(cwd, ".agents", "skills"), // project — Agent Skills spec
    join(getAgentDir(), "skills"), // user — Pi standard
    join(homedir(), ".agents", "skills"), // user — Agent Skills spec
    join(homedir(), ".pi", "skills"), // legacy global, pre-Pi
  ];
  // Sequential on purpose: roots are in precedence order and the first hit wins.
  for (const root of roots) {
    const content = await findInRoot(root, name);
    if (content !== undefined) return content;
  }
  return `(Skill "${name}" not found in .pi/skills/, .agents/skills/, or global skill locations)`;
}

async function findInRoot(root: string, name: string): Promise<string | undefined> {
  if (await isSymlink(root)) return undefined; // reject symlinked roots entirely
  const flat = (await safeReadFile(join(root, `${name}.md`)))?.trim();
  if (flat !== undefined) return flat;
  return findSkillDirectory(root, name);
}

/** BFS under `root` for a directory named `name` containing `SKILL.md`. Pi-conforming filters. */
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

    // Deterministic byte-order traversal — locale-independent.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    // Symlinked dirs already filtered by entry.isDirectory() — Dirent uses lstat semantics.
    const directories = entries.filter(
      (entry) =>
        entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules",
    );
    // Probe every child's SKILL.md concurrently, then walk the results in the
    // same byte order as before so the first match and queue order are unchanged.
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
        continue; // Pi rule: skills don't nest — don't descend into a skill dir
      }

      queue.push(path);
    }
  }
  return undefined;
}
