import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveMemoryDir } from "../src/memory.ts";
import { preloadSkills, skillRoots } from "../src/skill-loader.ts";

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "CHOCO_PI_STANDALONE", "CHOCO_PI_HOME"] as const;

type Scratch = { home: string; chocoHome: string; cwd: string };

async function withScratch(run: (scratch: Scratch) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "subagents-standalone-"));
  const previous = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of ENV_KEYS) delete process.env[key];
  const scratch = {
    home: path.join(root, "home"),
    chocoHome: path.join(root, "choco"),
    cwd: path.join(root, "work"),
  };
  process.env.HOME = scratch.home;
  const skill = async (dir: string, name: string) => {
    await mkdir(path.join(dir, name), { recursive: true });
    await writeFile(path.join(dir, name, "SKILL.md"), `# ${name}\n`);
  };
  try {
    await mkdir(scratch.cwd, { recursive: true });
    await skill(path.join(scratch.home, ".agents", "skills"), "agents-skill");
    await skill(path.join(scratch.home, ".pi", "skills"), "legacy-skill");
    await mkdir(path.join(scratch.home, ".pi", "agent-memory", "worker"), { recursive: true });
    await run(scratch);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

function enterStandalone({ chocoHome }: Scratch): void {
  process.env.CHOCO_PI_STANDALONE = "1";
  process.env.CHOCO_PI_HOME = chocoHome;
  process.env.PI_CODING_AGENT_DIR = path.join(chocoHome, "agent");
}

test("standalone skill roots keep ~/.agents/skills and drop ~/.pi/skills", async () => {
  await withScratch(async (scratch) => {
    enterStandalone(scratch);
    const roots = skillRoots(scratch.cwd);
    assert.ok(roots.includes(path.join(scratch.home, ".agents", "skills")));
    assert.ok(roots.includes(path.join(scratch.chocoHome, "agent", "skills")));
    assert.ok(
      roots.every((root) => !root.startsWith(path.join(scratch.home, ".pi"))),
      roots.join(),
    );
    const [agents, legacy] = await preloadSkills(["agents-skill", "legacy-skill"], scratch.cwd);
    assert.equal(agents?.content, "# agents-skill");
    assert.match(legacy?.content ?? "", /not found/);
  });
});

test("legacy skill roots still include ~/.pi/skills after ~/.agents/skills", async () => {
  await withScratch(async (scratch) => {
    const roots = skillRoots(scratch.cwd);
    assert.deepEqual(roots.slice(-2), [
      path.join(scratch.home, ".agents", "skills"),
      path.join(scratch.home, ".pi", "skills"),
    ]);
    const [legacy] = await preloadSkills(["legacy-skill"], scratch.cwd);
    assert.equal(legacy?.content, "# legacy-skill");
  });
});

test("standalone user memory never falls back to ~/.pi/agent-memory", async () => {
  await withScratch(async (scratch) => {
    enterStandalone(scratch);
    assert.equal(
      await resolveMemoryDir("worker", "user", scratch.cwd),
      path.join(scratch.chocoHome, "agent", "agent-memory", "worker"),
    );
  });
});

test("legacy user memory keeps the ~/.pi/agent-memory fallback", async () => {
  await withScratch(async (scratch) => {
    assert.equal(
      await resolveMemoryDir("worker", "user", scratch.cwd),
      path.join(scratch.home, ".pi", "agent-memory", "worker"),
    );
    await mkdir(path.join(scratch.home, ".pi", "agent", "agent-memory", "worker"), {
      recursive: true,
    });
    assert.equal(
      await resolveMemoryDir("worker", "user", scratch.cwd),
      path.join(scratch.home, ".pi", "agent", "agent-memory", "worker"),
    );
  });
});
