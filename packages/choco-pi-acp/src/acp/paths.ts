import { join } from "node:path";
import { piStateRoot } from "@choco-pi/shared/pi-paths";

/**
 * Storage owned by the ACP adapter.
 *
 * We intentionally keep this separate from pi's own agent directory. Legacy mode keeps
 * `~/.pi/pi-acp`; under the standalone `choco-pi` launcher it is `$CHOCO_PI_HOME/pi-acp`.
 */
export function getPiAcpDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(piStateRoot(env), "pi-acp");
}

export function getPiAcpSessionMapPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getPiAcpDir(env), "session-map.json");
}
