import { CHOCO_PI_LSP_EVAL_STARTED_MS } from "./eval-timestamp.ts";

import { installConsoleGuard, openModuleLoadConsoleWindow } from "./extension-log.ts";

installConsoleGuard();
openModuleLoadConsoleWindow();

void CHOCO_PI_LSP_EVAL_STARTED_MS;
