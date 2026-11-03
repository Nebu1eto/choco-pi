// Gives the stock host bash tool the scratch variables exec_command and shells already receive:
// PI_ROOT_SESSION_ID, PI_SCRATCH_DIR and (after a fork or resume) PI_PREVIOUS_SCRATCH_DIR.
// The tool is the built-in one with a spawn hook, so description, schema and renderer stay Pi's.
import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scratchEnv } from "./lib/scratch-path.ts";

export default function scratchEnvExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    pi.registerTool(
      createBashToolDefinition(ctx.cwd, {
        spawnHook: ({ command, cwd, env }) => {
          // The host injects PI_SESSION_ID before this hook runs; resolve lineage per spawn so a
          // fork, resume or subagent child is reflected, and keep any value already inherited.
          const sessionId = env["PI_SESSION_ID"];
          if (!sessionId) return { command, cwd, env };
          return { command, cwd, env: { ...env, ...scratchEnv(sessionId, env) } };
        },
      }),
    );
  });
}
