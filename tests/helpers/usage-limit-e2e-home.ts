import { tmpdir } from "node:os";
import { join } from "node:path";

export const E2E_HOME = join(tmpdir(), `choco-usage-limit-e2e-home-${process.pid}`);
process.env.HOME = E2E_HOME;
