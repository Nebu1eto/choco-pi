import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * This package's `src/tools` directory. The imagegen and web_run binaries ship
 * here; @choco-pi/code-mode's resolver defaults to its own tree.
 */
export const CODEX_TOOLS_ROOT_DIR = dirname(fileURLToPath(import.meta.url));
