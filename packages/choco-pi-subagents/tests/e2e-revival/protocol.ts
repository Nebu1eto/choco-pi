/**
 * Shared constants between the e2e revival runner (`run.ts`) and the extension
 * it loads into the Pi process under test (`faux-extension.ts`). Kept free of
 * Pi imports so the runner never loads host modules.
 */

export const FAUX_PROVIDER = "e2e-faux";
export const FAUX_MODEL = "scripted";
export const RELOAD_COMMAND = "e2e-reload";

/** Main-session prompt markers. The suffix selects the child script. */
export const MAIN_SPAWN_SLEEP = "E2E-MAIN-SPAWN:sleep";
export const MAIN_SPAWN_QUOTA = "E2E-MAIN-SPAWN:quota";
export const MAIN_NOOP = "E2E-MAIN-NOOP";

/** Child task markers carried in the Agent tool prompt. */
export const CHILD_SLEEP = "E2E-CHILD-SLEEP";
export const CHILD_QUOTA = "E2E-CHILD-QUOTA";

/** Fixed answers the scripted model returns. */
export const CHILD_DONE_TEXT = "E2E-CHILD-DONE";
export const CHILD_REVIVED_TEXT = "E2E-CHILD-REVIVED-MARKER";
export const CHILD_CONTINUED_TEXT = "E2E-CHILD-CONTINUED";
export const CHILD_QUOTA_RESUMED_TEXT = "E2E-CHILD-QUOTA-RESUMED";
export const MAIN_ACK_TEXT = "E2E-MAIN-ACK";

/** Error text the quota child fails with; the fake usage-limit policy keys on it. */
export const QUOTA_MARKER = "E2E-QUOTA-EXHAUSTED";

/** Environment the runner passes to the Pi process. */
export const ENV_LOG = "E2E_REVIVAL_LOG";
export const ENV_RESET_MS = "E2E_REVIVAL_RESET_MS";
export const ENV_SLEEP_S = "E2E_REVIVAL_SLEEP_S";
/**
 * Line shared by the clean and unclean revival prompts, derived by `run.ts`
 * from the real `buildInterruptionPrompt`; the faux child keys on it.
 */
export const ENV_REVIVAL_MARKER = "E2E_REVIVAL_MARKER";

export const DEFAULT_RESET_MS = 30_000;
export const DEFAULT_SLEEP_S = 25;
