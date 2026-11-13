import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const [tracePath, sessionDir] = process.argv.slice(2);
if (!tracePath || !sessionDir) {
  throw new Error("usage: node hardening-host-check.ts <trace.jsonl> <session-dir>");
}

interface TraceEntry {
  event?: string;
  mode?: string;
  child?: boolean;
  signalAborted?: boolean;
  resultConsumed?: boolean;
  terminalResultGeneration?: number;
  toolName?: string;
  customType?: string;
  content?: string;
  result?: string;
  args?: string;
  id?: string;
  generation?: string;
  status?: string;
  pendingSteers?: number;
  sessionHasQueuedMessages?: boolean;
}

interface SessionEntry {
  type?: string;
  customType?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  message?: {
    role?: string;
    toolName?: string;
    content?: string | Array<{ type?: string; text?: string }>;
  };
}

function parseLine<T>(line: string): T {
  const parsed: unknown = JSON.parse(line);
  // SAFETY: Callers consume only optional fields and strictly validate every required value.
  return parsed as T;
}

function contentText(content: SessionEntry["content"]): string {
  if (!content) return "";
  if (Array.isArray(content)) {
    return content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
  }
  return content;
}

function xmlValue(xml: string, element: string): string | undefined {
  return new RegExp(`<${element}>([^<]+)</${element}>`).exec(xml)?.[1];
}

const entries = (await readFile(tracePath, "utf8"))
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => parseLine<TraceEntry>(line));
const requireEvidence = (condition: boolean, message: string) => {
  if (!condition) throw new Error(`hardening host check failed: ${message}`);
};
const one = (predicate: (entry: TraceEntry) => boolean, message: string) => {
  const matches = entries.filter(predicate);
  requireEvidence(matches.length === 1, message);
  return matches[0]!;
};
const position = (entry: TraceEntry) => entries.indexOf(entry);

const mode = one((entry) => entry.event === "fixture_mode", "missing unique mode").mode;
requireEvidence(mode === "budget" || mode === "manual-stop", "invalid trace mode");
requireEvidence(
  process.env.CHOCO_PI_HARDENING_MODE === undefined || process.env.CHOCO_PI_HARDENING_MODE === mode,
  "environment and trace mode differ",
);
const expectedStatus = mode === "manual-stop" ? "stopped" : "budget_exceeded";
const expectedXmlStatus = mode === "manual-stop" ? "Stopped" : "Budget exceeded";
one(
  (entry) => entry.event === "provider_request" && entry.child === true,
  "child request is not unique",
);

const childIdEntry = one((entry) => entry.event === "child_id_captured", "missing unique child ID");
const started = one(
  (entry) => entry.event === "child_provider_started",
  "child provider did not start exactly once",
);
const steer = one(
  (entry) => entry.event === "tool_start" && entry.toolName === "steer_subagent",
  "native steer did not start exactly once",
);
const aborted = one(
  (entry) => entry.event === "child_provider_aborted",
  "child provider abort was not observed exactly once",
);
const settled = one(
  (entry) => entry.event === "parent_barrier_child_settled",
  "manager settlement was not observed exactly once",
);
const sent = one(
  (entry) => entry.event === "send_message" && entry.customType === "subagent-notification",
  "terminal notification send was not observed exactly once",
);
const seen = one(
  (entry) => entry.event === "notification_observed_by_parent",
  "parent did not observe exactly one terminal notification",
);
const consumed = one(
  (entry) => entry.event === "tool_end" && entry.toolName === "get_subagent_result",
  "get_subagent_result did not complete exactly once",
);
const continued = one(
  (entry) => entry.event === "parent_continuation",
  "parent continuation was not observed exactly once",
);
one((entry) => entry.event === "assertions_passed", "fixture assertions did not pass exactly once");
requireEvidence(
  !entries.some((entry) => entry.event === "child_request_after_first"),
  "provider received a post-abort child request",
);
requireEvidence(settled.pendingSteers === 0, "production pending steer queue was not empty");
requireEvidence(settled.sessionHasQueuedMessages === false, "host queued messages were not empty");
requireEvidence(
  [started, steer, aborted, settled, sent, seen, consumed, continued].every(
    (entry, index, ordered) => index === 0 || position(ordered[index - 1]!) < position(entry),
  ),
  "required start/steer/abort/settle/send/seen/consume/continue ordering was violated",
);

const notificationXml = sent.content ?? "";
const childId = childIdEntry.id;
const notificationId = xmlValue(notificationXml, "task-id");
const generation = xmlValue(notificationXml, "generation");
if (!childId) throw new Error("hardening host check failed: captured child ID is absent");
requireEvidence(notificationId === childId, "notification child ID mismatch");
requireEvidence(
  generation !== undefined && seen.generation === generation,
  "notification generation mismatch",
);
requireEvidence(seen.id === childId, "observed notification child ID mismatch");
requireEvidence(seen.status === expectedXmlStatus, "observed notification status mismatch");
requireEvidence(
  xmlValue(notificationXml, "status") === expectedXmlStatus &&
    !notificationXml.includes("<status>Done</status>"),
  "sent notification XML has an incorrect terminal status",
);
requireEvidence(
  steer.args?.includes(childId) === true,
  "steer was not addressed to the same child",
);
requireEvidence(
  contentText(parseLine<SessionEntry>(consumed.result ?? "{}").content).includes(
    `Status: ${expectedStatus}`,
  ),
  "actual get_subagent_result output lacks expected status",
);

async function sessionFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    if ((await stat(path)).isDirectory()) files.push(...(await sessionFiles(path)));
    else if (path.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

const sessionEntries: SessionEntry[] = [];
for (const path of await sessionFiles(sessionDir)) {
  sessionEntries.push(
    ...(await readFile(path, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => parseLine<SessionEntry>(line)),
  );
}
const persistedNotifications = sessionEntries.filter(
  (entry) => entry.type === "custom_message" && entry.customType === "subagent-notification",
);
requireEvidence(
  persistedNotifications.length === 1,
  "persisted terminal notification is not unique",
);
const persistedXml = contentText(persistedNotifications[0]!.content);
requireEvidence(
  xmlValue(persistedXml, "task-id") === childId,
  "persisted notification child ID mismatch",
);
requireEvidence(
  xmlValue(persistedXml, "generation") === generation,
  "persisted generation mismatch",
);
requireEvidence(
  xmlValue(persistedXml, "status") === expectedXmlStatus &&
    !persistedXml.includes("<status>Done</status>"),
  "persisted notification has an incorrect terminal status",
);
const persistedResults = sessionEntries.filter(
  (entry) =>
    entry.type === "message" &&
    entry.message?.role === "toolResult" &&
    entry.message.toolName === "get_subagent_result",
);
requireEvidence(
  persistedResults.length === 1,
  "persisted get_subagent_result result is not unique",
);
requireEvidence(
  contentText(persistedResults[0]!.message?.content).includes(`Status: ${expectedStatus}`) &&
    contentText(persistedResults[0]!.message?.content).includes(`Agent: ${childId}\n`),
  "persisted get_subagent_result output lacks expected status or child ID",
);

const stopStarts = entries.filter(
  (entry) => entry.event === "tool_start" && entry.toolName === "stop_subagent",
);
const stopEnds = entries.filter(
  (entry) => entry.event === "tool_end" && entry.toolName === "stop_subagent",
);
const persistedStops = sessionEntries.filter(
  (entry) =>
    entry.type === "message" &&
    entry.message?.role === "toolResult" &&
    entry.message.toolName === "stop_subagent",
);
requireEvidence(
  stopStarts.length === (mode === "manual-stop" ? 2 : 0) &&
    stopEnds.length === stopStarts.length &&
    persistedStops.length === stopStarts.length,
  "incorrect stop call/result count",
);
if (mode === "manual-stop") {
  const cancellation = one(
    (entry) => entry.event === "child_cancellation_observed",
    "cancellation was not unique",
  );
  requireEvidence(cancellation.signalAborted === true, "provider signal was not aborted");
  const stoppedEvent = one(
    (entry) => entry.event === "production_stopped_event",
    "production stop was not unique",
  );
  const pending = one(
    (entry) => entry.event === "manual_stop_pending",
    "missing pending state observation",
  );
  requireEvidence(
    pending.resultConsumed === false &&
      pending.terminalResultGeneration === undefined &&
      pending.id === childId &&
      String(pending.generation) === generation,
    "manual stop prematurely consumed/settled or generation mismatch",
  );
  const released = one(
    (entry) => entry.event === "child_unwind_released",
    "missing unwind release",
  );
  const ordered = [
    steer,
    stopStarts[0]!,
    cancellation,
    stoppedEvent,
    stopEnds[0]!,
    stopStarts[1]!,
    stopEnds[1]!,
    pending,
    released,
    aborted,
  ];
  requireEvidence(
    ordered.every((entry, index) => index === 0 || position(ordered[index - 1]!) < position(entry)),
    "manual stop handshake ordering violated",
  );
  for (const start of stopStarts)
    requireEvidence(
      parseLine<{ agent_id?: string }>(start.args ?? "{}").agent_id === childId,
      "stop child ID mismatch",
    );
  for (const content of [
    ...stopEnds.map((entry) => parseLine<SessionEntry>(entry.result ?? "{}").content),
    ...persistedStops.map((entry) => entry.message?.content),
  ]) {
    const text = contentText(content);
    requireEvidence(
      text.startsWith(
        `Cancellation requested for agent ${childId}; terminal result is still pending.`,
      ) && !text.includes("already settled"),
      "stop result was not pending",
    );
  }
}

process.stdout.write(`hardening host evidence verified (${mode})\n`);
