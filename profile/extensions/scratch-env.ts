import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scratchEnv } from "./lib/scratch-path.ts";

export default function scratchEnvExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    pi.registerTool(
      createBashToolDefinition(ctx.cwd, {
        spawnHook: ({ command, cwd, env }) => {
          const sessionId = env["PI_SESSION_ID"];
          if (!sessionId) return { command, cwd, env };
          return { command, cwd, env: { ...env, ...scratchEnv(sessionId, env) } };
        },
      }),
    );
  });
}
