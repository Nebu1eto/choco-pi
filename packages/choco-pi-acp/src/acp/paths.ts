import { join } from "node:path";
import { piStateRoot } from "@choco-pi/shared/pi-paths";

export function getPiAcpDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(piStateRoot(env), "pi-acp");
}

export function getPiAcpSessionMapPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getPiAcpDir(env), "session-map.json");
}
