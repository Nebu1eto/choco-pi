import { tmpdir } from "node:os";
import { join } from "node:path";

export const E2E_HOME = join(tmpdir(), `choco-usage-limit-e2e-home-${process.pid}`);
process.env.HOME = E2E_HOME;
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.CHOCO_PI_HOME;
delete process.env.CHOCO_PI_STANDALONE;
