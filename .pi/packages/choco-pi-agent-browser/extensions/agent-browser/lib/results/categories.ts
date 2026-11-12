import type {
  AgentBrowserDiagnostic,
  AgentBrowserFailureCategory,
  AgentBrowserResultCategoryDetails,
  AgentBrowserSuccessCategory,
  FileArtifactMetadata,
  SavedFilePresentationDetails,
} from "./contracts.ts";
import { isPendingRecordingArtifact } from "./artifact-manifest.ts";
import { isOpenNavigationCommand } from "../command-taxonomy.ts";

function hasUnverifiedFileArtifact(artifacts: FileArtifactMetadata[] | undefined): boolean {
  return (artifacts ?? []).some(
    (artifact) => !isPendingRecordingArtifact(artifact) && artifact.exists !== true,
  );
}

export function classifyAgentBrowserSuccessCategory(options: {
  artifacts?: FileArtifactMetadata[];
  inspection?: boolean;
  savedFile?: SavedFilePresentationDetails;
}): AgentBrowserSuccessCategory {
  if (options.inspection) return "inspection";
  if ((options.artifacts ?? []).some(isPendingRecordingArtifact)) return "artifact-pending";
  if ((options.artifacts ?? []).length > 0)
    return hasUnverifiedFileArtifact(options.artifacts) ? "artifact-unverified" : "artifact-saved";
  if (options.savedFile) return "artifact-saved";
  return "completed";
}

export function classifyAgentBrowserFailureCategory(options: {
  args?: string[];
  command?: string;
  confirmationRequired?: boolean;
  errorText?: string;
  parseError?: string;
  spawnError?: string;
  stderr?: string;
  tabDrift?: boolean;
  timedOut?: boolean;
  validationError?: string;
}): AgentBrowserFailureCategory {
  const text = [
    options.errorText,
    options.validationError,
    options.parseError,
    options.spawnError,
    options.stderr,
  ]
    .filter(Boolean)
    .join("\n");
  const command = options.command ?? "";
  const usedRef = options.args?.some((arg) => /^@e\d+\b/.test(arg)) ?? false;
  // Explicit confirmation flag wins. Text-derived confirmation phrases come after locator-miss detection so a
  // missed control named "Confirmation required" still gets selector recovery.
  if (options.confirmationRequired) return "confirmation-required";
  // Canonical upstream prefix first: lastUrl can contain aborted / policy-blocked / about:blank.
  if (/\btab_gone:/i.test(text)) return "tab-gone";
  // Upstream 0.32.4+ locator misses keep detail and may echo getByRole/getByText or Names seen lists.
  // Evaluate before text-derived timeout/confirmation so accessible-name substrings cannot suppress recovery.
  const isUpstreamLocatorMiss =
    /\bNo element found:\s*(?:getBy[A-Za-z]+|role=|text=|label=|placeholder=|alt=|title=|testid=)/i.test(
      text,
    ) ||
    // No trailing \b after ":" — colon is non-word, so "Element not found: text=…" would not match.
    (/\bElement not found:/i.test(text) && /\bVerify the selector, role, or name\b/i.test(text)) ||
    /\bnone match name\b/i.test(text) ||
    // Scope Names seen to role/name miss context (or find) so unrelated prose cannot trip selector-not-found.
    (/\bNames seen:/i.test(text) &&
      (command === "find" ||
        /\belement has role\b|\bnone match name\b|\bgetByRole\b/i.test(text))) ||
    /\belement has role\b[\s\S]*\bnone match\b/i.test(text);
  if (isUpstreamLocatorMiss) return "selector-not-found";
  if (/confirmation required|pending confirmation|requires confirmation/i.test(text))
    return "confirmation-required";
  // Match real timeout phrasing only. Do not treat bare "timeout" as a hit — accessible names can include that word,
  // and `timed?\s*out` would also match the substring "timeout" as time+out.
  if (
    options.timedOut ||
    /\b(?:timed\s+out|timeout exceeded|watchdog|IPC read timeout)\b|must stay under its 30s IPC read timeout|Operation timed out/i.test(
      text,
    )
  ) {
    return "timeout";
  }
  if (
    /ENOENT|not found on PATH|could not find.*agent-browser|agent-browser is required but was not found/i.test(
      text,
    )
  )
    return "missing-binary";
  if (
    options.parseError ||
    /invalid JSON|missing boolean success|success field must be boolean|returned no JSON output/i.test(
      text,
    )
  )
    return "parse-failure";
  if (/aborted/i.test(text)) return "aborted";
  if (
    /policy[- ]blocked|blocked by caller policy|caller deny policy|caller allow policy/i.test(text)
  )
    return "policy-blocked";
  if (/cleanup failed|cleanup.*partial|partial cleanup|remaining resources/i.test(text))
    return "cleanup-failed";
  if (
    options.validationError ||
    /Agent-browser Unix socket path would be|Agent-browser socket storage .* is unusable/i.test(
      text,
    )
  )
    return "validation-error";
  if (
    options.tabDrift ||
    /could not re-select the intended tab|about:blank|selected tab looks wrong|tab drift|tab.*wrong/i.test(
      text,
    )
  )
    return "tab-drift";
  if (
    /\bUnknown ref\b|\bstale ref\b|@ref may be stale|\bref\b.*\b(?:not found|missing|expired)\b/i.test(
      text,
    )
  )
    return "stale-ref";
  if (usedRef && /could not locate element|element not found|no element/i.test(text))
    return "stale-ref";
  const mentionsPlaywrightSelectorDialect =
    /(?:\btext=|:has-text\(|\bgetByRole\b|\bgetByText\b)/i.test(text);
  const reportsSelectorMatchFailure =
    /\b(?:no elements? found|failed to find|could not find|unable to find)\b.*\b(?:selector|locator)\b/i.test(
      text,
    ) ||
    /\b(?:selector|locator)\b.*\b(?:no elements? found|not found|missing|failed to find|could not find|unable to find)\b/i.test(
      text,
    );
  if (
    /\b(?:unsupported|unknown|invalid)\s+(?:selector|locator)\b/i.test(text) ||
    /\bfailed to parse selector\b/i.test(text) ||
    /\bselector\b.*\b(?:parse|syntax|unsupported|invalid)\b/i.test(text) ||
    (mentionsPlaywrightSelectorDialect && reportsSelectorMatchFailure)
  ) {
    return "selector-unsupported";
  }
  if (
    command === "find" &&
    /could not locate element|element not found|no elements? found|unable to find/i.test(text)
  )
    return "selector-not-found";
  if (reportsSelectorMatchFailure) return "selector-not-found";
  if (
    (command === "download" || text.includes("wait --download") || /\bdownload\b/i.test(text)) &&
    /missing|not verified|not found|failed|timeout|timed out/i.test(text)
  ) {
    return "download-not-verified";
  }
  return "upstream-error";
}

export function buildAgentBrowserResultCategoryDetails(options: {
  artifacts?: FileArtifactMetadata[];
  args?: string[];
  command?: string;
  confirmationRequired?: boolean;
  errorText?: string;
  failureCategory?: AgentBrowserFailureCategory;
  inspection?: boolean;
  parseError?: string;
  savedFile?: SavedFilePresentationDetails;
  spawnError?: string;
  succeeded: boolean;
  tabDrift?: boolean;
  timedOut?: boolean;
  upstreamErrorCode?: string;
  validationError?: string;
}): AgentBrowserResultCategoryDetails {
  if (options.succeeded) {
    return {
      resultCategory: "success",
      successCategory: classifyAgentBrowserSuccessCategory(options),
    };
  }
  const failureCategory = options.failureCategory ?? classifyAgentBrowserFailureCategory(options);
  return {
    diagnostic: classifyAgentBrowserDiagnostic({ ...options, failureCategory }),
    failureCategory,
    resultCategory: "failure",
  };
}

const UPSTREAM_ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const MAX_RETRY_AFTER_MS = 60_000;

/** Returns the code only when it is a short identifier; anything else (prose, paths, secrets) is dropped. */
export function validateUpstreamErrorCode(value: string | undefined): string | undefined {
  return value !== undefined && UPSTREAM_ERROR_CODE_PATTERN.test(value) ? value : undefined;
}

// Commands that observe state only. Everything else, including unknown commands, is treated as possibly mutating.
const READ_ONLY_DIAGNOSTIC_COMMANDS = new Set([
  "a11y",
  "console",
  "diff",
  "doctor",
  "errors",
  "get",
  "is",
  "profiles",
  "read",
  "screenshot",
  "skills",
  "snapshot",
  "vitals",
  "wait",
]);

const IPC_READ_TIMEOUT_PATTERN =
  /\bIPC read timeout\b|Failed to read: Resource temporarily unavailable.*daemon may be busy or unresponsive/i;
const DAEMON_UNAVAILABLE_PATTERN =
  /\bdaemon (?:is )?(?:not running|unavailable|failed to start|exited|crashed|not responding)\b|failed to (?:start|connect to) (?:the )?daemon|ECONNREFUSED|connection refused|(?:socket|daemon).*(?:No such file or directory|not found)/i;
const SESSION_DEAD_PATTERN =
  /\bsession\b.*\b(?:not found|closed|dead|terminated|no longer exists)\b|browser has been closed|target (?:page, context or browser )?(?:has been )?closed|browser (?:process )?(?:exited|crashed|disconnected)/i;

interface DiagnosticBase {
  code: string;
  hint: string;
  origin: AgentBrowserDiagnostic["origin"];
  outcome: AgentBrowserDiagnostic["outcome"];
  retryable: boolean;
}

function diagnosticBaseFor(options: {
  command: string;
  failureCategory: AgentBrowserFailureCategory;
  text: string;
  timedOut: boolean;
}): DiagnosticBase {
  const { command, failureCategory, text } = options;
  if (options.timedOut) {
    return {
      code: "wrapper_timeout",
      hint: "The wrapper watchdog stopped the call before it reported a result. Shorten the call, use a bounded condition wait, or pass a higher bounded timeout_ms.",
      origin: "wrapper",
      outcome: "unknown",
      retryable: true,
    };
  }
  if (IPC_READ_TIMEOUT_PATTERN.test(text)) {
    return {
      code: "ipc_timeout",
      hint: "The CLI timed out reading the daemon response; the daemon may still be busy or alive. Check state with a snapshot or tab list, split long work, or start a fresh session.",
      origin: "daemon",
      outcome: "unknown",
      retryable: true,
    };
  }
  switch (failureCategory) {
    case "timeout":
      if (command === "wait") {
        return {
          code: "condition_timeout",
          hint: "The bounded wait elapsed before its condition held. Inspect page state with a snapshot, then change the condition or timeout instead of repeating the same wait.",
          origin: "cli",
          outcome: "completed",
          retryable: true,
        };
      }
      if (isOpenNavigationCommand(command) && /navigat/i.test(text)) {
        return {
          code: "navigation_timeout",
          hint: "Navigation did not finish in time; the page may be partially loaded or the navigation may still be in flight. Check get url and snapshot before changing the URL or timeout.",
          origin: "cli",
          outcome: "unknown",
          retryable: true,
        };
      }
      break;
    case "missing-binary":
      return {
        code: "cli_unavailable",
        hint: "The agent-browser executable could not be started. Install it on PATH or run doctor; repeating the call cannot succeed until then.",
        origin: "cli",
        outcome: "not-executed",
        retryable: false,
      };
    case "tab-gone":
    case "tab-drift":
      return {
        code: "session_dead",
        hint: "The bound tab or browser session is gone or drifted. Recover with tab list, tab new, or a fresh session before continuing.",
        origin: "session",
        outcome: "unknown",
        retryable: false,
      };
    case "selector-not-found":
    case "stale-ref":
      return {
        code: "target_missing",
        hint: "The target element or ref was not found, so the action did not run. Take a fresh snapshot -i and use a current ref or locator.",
        origin: "cli",
        outcome: "not-executed",
        retryable: false,
      };
    case "validation-error":
      return {
        code: "invalid_arguments",
        hint: "The input was rejected before any browser action ran. Fix the arguments; repeating them unchanged fails again.",
        origin: "validation",
        outcome: "not-executed",
        retryable: false,
      };
    case "selector-unsupported":
      return {
        code: "invalid_arguments",
        hint: "The selector or locator syntax is unsupported, so the action did not run. Use a snapshot ref or a supported find locator.",
        origin: "cli",
        outcome: "not-executed",
        retryable: false,
      };
    case "policy-blocked":
      return {
        code: "policy_blocked",
        hint: "Caller policy blocked this call before it ran. Change the request to comply; repeating it unchanged is blocked again.",
        origin: "validation",
        outcome: "not-executed",
        retryable: false,
      };
    case "cleanup-failed":
      return {
        code: "cleanup_failed",
        hint: "The work finished but cleanup of its browser resources failed. Use the cleanup next action; do not rerun the work.",
        origin: "wrapper",
        outcome: "completed",
        retryable: false,
      };
    case "script-error":
      return {
        code: "script_error",
        hint: "The script failed inside the sandbox; inner browser calls may already have run. Inspect page state and fix the script before rerunning it.",
        origin: "wrapper",
        outcome: "unknown",
        retryable: false,
      };
    case "aborted":
      return {
        code: "aborted",
        hint: "The call was aborted before completing. Verify state before deciding whether to run it again.",
        origin: "wrapper",
        outcome: "unknown",
        retryable: false,
      };
    case "parse-failure":
      return {
        code: "unparseable_output",
        hint: "The CLI output could not be parsed, so the result is unknown. Inspect state before any retry.",
        origin: "cli",
        outcome: "unknown",
        retryable: false,
      };
    default:
      break;
  }
  if (SESSION_DEAD_PATTERN.test(text)) {
    return {
      code: "session_dead",
      hint: "The browser session or page appears closed. Start a fresh session or recover with tab list before continuing.",
      origin: "session",
      outcome: "unknown",
      retryable: false,
    };
  }
  if (DAEMON_UNAVAILABLE_PATTERN.test(text)) {
    return {
      code: "daemon_unavailable",
      hint: "The agent-browser daemon is not reachable. Check status or retry with session_mode fresh after verifying the earlier call's effect.",
      origin: "daemon",
      outcome: "unknown",
      retryable: true,
    };
  }
  return {
    code: "upstream_unknown",
    hint: "The failure cause is unknown. Read details.error and nextActions, then change the input or verify state; do not repeat the same call unchanged.",
    origin: "unknown",
    outcome: "unknown",
    retryable: false,
  };
}

/**
 * Builds the normalized diagnostic for a failed call. Never infers a precise code from exit status alone:
 * a validated upstream code is preserved, otherwise only explicit text or flags select a specific code.
 */
export function classifyAgentBrowserDiagnostic(options: {
  command?: string;
  errorText?: string;
  failureCategory: AgentBrowserFailureCategory;
  parseError?: string;
  retryAfterMs?: number;
  spawnError?: string;
  timedOut?: boolean;
  upstreamErrorCode?: string;
  validationError?: string;
}): AgentBrowserDiagnostic {
  const command = options.command ?? "";
  const text = [options.errorText, options.validationError, options.parseError, options.spawnError]
    .filter(Boolean)
    .join("\n");
  const base = diagnosticBaseFor({
    command,
    failureCategory: options.failureCategory,
    text,
    timedOut: options.timedOut === true,
  });
  const upstreamCode = validateUpstreamErrorCode(options.upstreamErrorCode);
  const preserved = upstreamCode !== undefined && !options.timedOut;
  const origin = preserved && base.origin === "unknown" ? "cli" : base.origin;
  const retryAfterMs =
    options.retryAfterMs !== undefined &&
    Number.isFinite(options.retryAfterMs) &&
    options.retryAfterMs >= 0 &&
    options.retryAfterMs <= MAX_RETRY_AFTER_MS
      ? Math.trunc(options.retryAfterMs)
      : undefined;
  const mutationWarning =
    base.outcome === "unknown" && !READ_ONLY_DIAGNOSTIC_COMMANDS.has(command)
      ? " This command may already have taken effect; verify page state before replaying it, because retryable does not authorize replaying a mutation."
      : "";
  const diagnostic: AgentBrowserDiagnostic = {
    code: preserved ? upstreamCode : base.code,
    hint: `${base.hint}${mutationWarning}`,
    origin,
    outcome: base.outcome,
    retryable: base.retryable,
  };
  if (retryAfterMs !== undefined) diagnostic.retryAfterMs = retryAfterMs;
  return diagnostic;
}
