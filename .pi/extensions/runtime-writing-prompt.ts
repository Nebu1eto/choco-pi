import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const WRITING_POLICY_MARKER = "<choco_pi_writing_policy>";
const PROFILE_POLICY_PATH = fileURLToPath(new URL("../writing-policy.md", import.meta.url));

export function composeWritingPolicyPrompt(systemPrompt: string, policy: string): string {
  if (systemPrompt.includes(WRITING_POLICY_MARKER)) return systemPrompt;
  const policyBlock = `${WRITING_POLICY_MARKER}\n${policy.trim()}\n</choco_pi_writing_policy>`;
  return `${systemPrompt}\n\n${policyBlock}`;
}

async function readPolicy(): Promise<string> {
  const paths = [
    path.join(process.cwd(), ".pi", "writing-policy.md"),
    path.join(getAgentDir(), "writing-policy.md"),
    PROFILE_POLICY_PATH,
  ];
  for (const policyPath of paths) {
    try {
      return (await readFile(policyPath, "utf8")).trim();
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
  throw new Error("choco-pi writing-policy.md was not found");
}

export default async function runtimeWritingPrompt(pi: ExtensionAPI): Promise<void> {
  const policy = await readPolicy();

  pi.on("before_agent_start", (event) => {
    if (event.systemPrompt.includes(WRITING_POLICY_MARKER)) return;
    return { systemPrompt: composeWritingPolicyPrompt(event.systemPrompt, policy) };
  });
}
