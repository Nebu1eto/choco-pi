/** Human-readable terminal status for structured completion notifications. */
export function formatTaskNotificationStatus(status: string, error?: string): string {
  switch (status) {
    case "completed":
      return "Done";
    case "error":
      return `Error: ${error ?? "unknown"}`;
    case "aborted":
      return "Aborted (max turns exceeded)";
    case "steered":
      return "Wrapped up (turn limit)";
    case "stopped":
      return "Stopped";
    case "budget_exceeded":
      return "Budget exceeded";
    case "watchdog_stopped":
      return "Watchdog stopped";
    default:
      return `Unknown status: ${status || "(empty)"}`;
  }
}
