import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

const PROFILE = path.resolve(import.meta.dirname, "..", "..", "profile");

export async function useProfileAgents(context: TestContext): Promise<string> {
  const agentDir = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-agents-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  context.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(agentDir, { recursive: true, force: true });
  });
  await symlink(path.join(PROFILE, "agents"), path.join(agentDir, "agents"));
  await symlink(path.join(PROFILE, "subagents.json"), path.join(agentDir, "subagents.json"));
  return agentDir;
}
