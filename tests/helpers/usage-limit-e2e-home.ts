/**
 * Import first. `provider-usage.ts` fixes its quota cache path from
 * `os.homedir()` when it is first evaluated, and a failed quota request records
 * a backoff entry there. Pointing HOME at a per-process temp directory before
 * that module loads keeps the real controller's corroboration from reading or
 * writing the user's `~/.pi/agent/choco-pi/usage-cache.json`.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

export const E2E_HOME = join(tmpdir(), `choco-usage-limit-e2e-home-${process.pid}`);
process.env.HOME = E2E_HOME;
