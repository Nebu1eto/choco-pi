import type { AuthMethod } from "@agentclientprotocol/sdk";
import { isAbsolute } from "node:path";
import { standaloneHome } from "../../../../profile/extensions/lib/pi-paths.ts";

export const PI_SETUP_METHOD_ID = "pi_terminal_login";

/** Command line a client should run to launch pi's interactive terminal login. */
type TerminalAuthLaunchSpec = {
  command: string;
  args: string[];
};

/** Options accepted by {@link getAuthMethods}. */
export type AuthMethodOptions = {
  supportsTerminalAuthMeta?: boolean;
  /** Environment that selects the launch spec; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
};

/**
 * Zed (and some other clients) currently support "Terminal Auth" via an extension field
 * in AuthMethod._meta, rather than the RFD "type/args/env" shape.
 *
 * We include BOTH for maximum compatibility:
 *  - `_meta["terminal-auth"]`: used by Zed to render the "Authenticate" banner + button.
 *  - `type/args/env`: registry-required shape.
 */
export function getAuthMethods(opts?: AuthMethodOptions): AuthMethod[] {
  const supportsTerminalAuthMeta = opts?.supportsTerminalAuthMeta ?? true;

  const method: AuthMethod = {
    id: PI_SETUP_METHOD_ID,
    name: "Launch pi in the terminal",
    description: "Start pi in an interactive terminal to configure API keys or login",

    // Registry-required fields
    type: "terminal",
    args: ["--terminal-login"],
    env: {},
  };

  if (supportsTerminalAuthMeta) {
    // Best-effort launch spec for Zed's terminal-auth banner.
    // Zed expects a full command+args (see mistral-vibe implementation).
    const launch = terminalAuthLaunchSpec(opts?.env);

    method._meta = {
      ...method._meta,
      "terminal-auth": {
        ...launch,
        label: "Launch pi",
      },
    };
  }

  return [method];
}

function terminalAuthLaunchSpec(env: NodeJS.ProcessEnv = process.env): TerminalAuthLaunchSpec {
  // Under the standalone `choco-pi` launcher, re-enter the adapter through the launcher so the
  // login runs with the same env contract (state under CHOCO_PI_HOME, pinned Pi).
  const launcher = env.CHOCO_PI_LAUNCHER;
  if (standaloneHome(env) !== undefined && launcher !== undefined && isAbsolute(launcher)) {
    return { command: launcher, args: ["self", "acp", "--terminal-login"] };
  }

  // If we were launched as `node /path/to/dist/index.js`, reuse that.
  // This is the most reliable in local dev and custom Zed configurations.
  const argv0 = process.argv[0] || "node";
  const argv1 = process.argv[1];
  if (argv1 && argv0) {
    const isNode = argv0.includes("node");
    const isJs = argv1.endsWith(".js");
    if (isNode && isJs) {
      return { command: argv0, args: [argv1, "--terminal-login"] };
    }
  }

  // Fallback: assume `pi-acp` is on PATH.
  return { command: "pi-acp", args: ["--terminal-login"] };
}
