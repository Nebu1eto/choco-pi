import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const CODEX_TOOLS_ROOT_DIR = dirname(fileURLToPath(import.meta.url));
