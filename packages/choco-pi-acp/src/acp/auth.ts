import type { AuthMethod } from "@agentclientprotocol/sdk";
import { isAbsolute } from "node:path";
import { standaloneHome } from "@choco-pi/shared/pi-paths";

export const PI_SETUP_METHOD_ID = "pi_terminal_login";

type TerminalAuthLaunchSpec = {
  command: string;
  args: string[];
};

export type AuthMethodOptions = {
  supportsTerminalAuthMeta?: boolean;
  env?: NodeJS.ProcessEnv;
};

export function getAuthMethods(opts?: AuthMethodOptions): AuthMethod[] {
  const supportsTerminalAuthMeta = opts?.supportsTerminalAuthMeta ?? true;

  const method: AuthMethod = {
    id: PI_SETUP_METHOD_ID,
    name: "Launch pi in the terminal",
    description: "Start pi in an interactive terminal to configure API keys or login",

    type: "terminal",
    args: ["--terminal-login"],
    env: {},
  };

  if (supportsTerminalAuthMeta) {
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
  const launcher = env.CHOCO_PI_LAUNCHER;
  if (standaloneHome(env) !== undefined && launcher !== undefined && isAbsolute(launcher)) {
    return { command: launcher, args: ["self", "acp", "--terminal-login"] };
  }

  const argv0 = process.argv[0] || "node";
  const argv1 = process.argv[1];
  if (argv1 && argv0) {
    const isNode = argv0.includes("node");
    const isJs = argv1.endsWith(".js");
    if (isNode && isJs) {
      return { command: argv0, args: [argv1, "--terminal-login"] };
    }
  }

  return { command: "pi-acp", args: ["--terminal-login"] };
}
