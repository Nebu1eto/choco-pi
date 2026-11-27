export interface CancelledQueryDetail {
  query: string;
  provider: string | null;
  error: string | null;
  resultCount: number;
}

export interface SearchErrorDetails {
  error?: string;
  cancelled?: boolean;
  cancelReason?: string;
  browserConnected?: boolean;
  lastHeartbeatAgeMs?: number | null;
  queryCount?: number;
  cancelledQueries?: CancelledQueryDetail[];
  extraLines?: string[];
}

export interface SearchErrorPlan {
  expanded: string[];
  collapsed: string[];
  expandHint: string | null;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "\u2026" : text;
}

export function buildSearchErrorPlan(
  details: SearchErrorDetails | undefined | null,
): SearchErrorPlan | null {
  if (!details || (!details.error && !details.cancelled)) {
    return null;
  }

  const headline = details.error ?? "Search cancelled.";
  const queries = details.cancelledQueries ?? [];
  const queryCount =
    details.queryCount !== undefined && details.queryCount > 0
      ? details.queryCount
      : queries.length;
  const done = queries.length;
  const errored = queries.filter((q) => q.error).length;

  const extras = details.extraLines ?? [];
  const rich = details.cancelled === true || queries.length > 0 || extras.length > 0;
  if (!rich) {
    return { expanded: [headline], collapsed: [], expandHint: null };
  }

  const expanded: string[] = [headline, ""];

  if (details.cancelled === true || queries.length > 0) {
    const diag: string[] = [];
    if (details.cancelled) {
      diag.push(`cancel reason   : ${details.cancelReason ?? "unknown"}`);
    }
    const browserLabel =
      details.browserConnected === undefined
        ? "unknown"
        : details.browserConnected
          ? "connected"
          : "never connected";
    diag.push(`browser         : ${browserLabel}`);
    if (
      details.lastHeartbeatAgeMs !== undefined &&
      details.lastHeartbeatAgeMs !== null &&
      Number.isFinite(details.lastHeartbeatAgeMs)
    ) {
      diag.push(`last heartbeat  : ${Math.round(details.lastHeartbeatAgeMs / 1000)}s ago`);
    }
    if (queryCount > 0) {
      diag.push(`queries started : ${queryCount}`);
      diag.push(`queries done    : ${done}`);
      if (errored > 0) diag.push(`queries errored : ${errored}`);
    }
    expanded.push("Diagnostics:");
    for (const line of diag) expanded.push(`  ${line}`);
  }

  if (queries.length > 0) {
    expanded.push("");
    expanded.push("Per-query results (gathered before cancel):");
    for (const q of queries) {
      const dq = truncate(q.query, 52);
      const tag = q.error ? "[err] " : "[ok]  ";
      const provider = q.provider ? ` (${q.provider})` : "";
      const tail = q.error
        ? `\u2014 ${truncate(q.error, 60)}`
        : `\u2014 ${q.resultCount} source${q.resultCount === 1 ? "" : "s"}`;
      expanded.push(`  ${tag}"${dq}"${provider} ${tail}`);
    }
  }

  if (extras.length > 0) {
    expanded.push("");
    expanded.push("Details:");
    for (const e of extras) expanded.push(`  ${e}`);
  }

  const collapsed: string[] = [];
  const parts: string[] = [];
  if (queryCount > 0) {
    parts.push(`${done}/${queryCount} queries completed`);
  }
  if (errored > 0) {
    parts.push(`${errored} errored`);
  }
  if (details.browserConnected === false) {
    parts.push("browser never connected");
  } else if (details.cancelReason) {
    parts.push(`reason: ${details.cancelReason}`);
  }
  if (parts.length > 0) {
    collapsed.push(parts.join("; ") + ".");
  }
  if (collapsed.length === 0 && extras.length > 0) {
    for (const e of extras.slice(0, 2)) {
      collapsed.push(truncate(e, 100));
    }
  }

  const hiddenLines = Math.max(0, expanded.length - (1 + collapsed.length));
  const expandHint =
    hiddenLines > 0
      ? `... (${hiddenLines} more lines, ${expanded.length} total, ctrl+o to expand)`
      : null;

  return { expanded, collapsed, expandHint };
}
