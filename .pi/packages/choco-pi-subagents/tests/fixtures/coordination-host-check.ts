import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const [tracePath, sessionDir] = process.argv.slice(2);
if (!tracePath || !sessionDir) {
  throw new Error("usage: node coordination-host-check.ts <trace.jsonl> <session-dir>");
}

interface TraceEntry {
  sequence?: number;
  event?: string;
  marker?: string;
  childAlias?: string;
  model?: string;
  id?: string;
  alias?: string;
  generation?: number;
  status?: string;
  sessionFile?: string;
  customType?: string;
  content?: string;
  deliverAs?: string;
  triggerTurn?: boolean;
  toolName?: string;
  args?: string;
  result?: string;
  eventData?: string;
  isError?: boolean;
  coordination?: number;
  terminal?: number;
  complete?: boolean;
  count?: number;
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  arguments?: ToolArguments;
}

interface ToolArguments {
  agent_id?: string;
  prompt?: string;
  description?: string;
  name?: string;
  subagent_type?: string;
  model?: string;
  thinking?: string;
  max_turns?: number;
  timeout_ms?: number;
  max_tool_calls?: number;
  run_in_background?: boolean;
  isolated?: boolean;
  to?: string;
  message?: string;
  type?: string;
}

interface CompletedEventData {
  id?: string;
  status?: string;
}

interface SessionEntry {
  type?: string;
  customType?: string;
  content?: string | ContentBlock[];
  message?: {
    role?: string;
    toolName?: string;
    content?: string | ContentBlock[];
  };
}

function parseLine<T>(line: string): T {
  // SAFETY: Every consumed optional field is checked against exact acceptance values below.
  return JSON.parse(line) as T;
}

function requireEvidence(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`coordination host check failed: ${message}`);
}

function contentText(content: string | ContentBlock[] | undefined): string {
  if (!content) return "";
  if (!Array.isArray(content)) return content;
  return content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

function xmlValue(xml: string, element: string): string | undefined {
  return new RegExp(`<${element}>([^<]+)</${element}>`).exec(xml)?.[1];
}

const traceLines = (await readFile(tracePath, "utf8")).split("\n").filter(Boolean);
const entries = traceLines.map((line) => parseLine<TraceEntry>(line));
requireEvidence(entries.length > 0, "trace is empty");
requireEvidence(
  entries.every((entry, index) => entry.sequence === index + 1),
  "trace sequence is missing, duplicated, or reordered",
);

function matches(predicate: (entry: TraceEntry) => boolean): TraceEntry[] {
  return entries.filter(predicate);
}

function one(predicate: (entry: TraceEntry) => boolean, message: string): TraceEntry {
  const found = matches(predicate);
  requireEvidence(found.length === 1, message);
  return found[0]!;
}

function position(entry: TraceEntry): number {
  return entries.indexOf(entry);
}

const ready = one((entry) => entry.event === "fixture_ready", "fixture readiness is not unique");
const marker = ready.marker;
const childAlias = ready.childAlias;
requireEvidence(marker?.startsWith("coordination-") === true, "marker invalid");
requireEvidence(childAlias === "coordination-host-child", "fixture child alias invalid");

const childCallsMessage = one(
  (entry) => entry.event === "child_calls_agent_message",
  "child did not issue exactly one agent_message call",
);
one(
  (entry) => entry.event === "child_finishes_normally",
  "child did not finish normally exactly once",
);
requireEvidence(
  matches((entry) => entry.event === "provider_request" && entry.model === "child").length === 2,
  "child did not make exactly the expected two provider requests",
);

const captured = one((entry) => entry.event === "child_captured", "child capture is not unique");
const childId = captured.id;
const generation = captured.generation;
requireEvidence(childId !== undefined && childId.length > 0, "captured child ID missing");
requireEvidence(captured.alias === childAlias, "captured child alias mismatch");
requireEvidence(Number.isInteger(generation) && generation! > 0, "captured generation invalid");

const agentStart = one(
  (entry) => entry.event === "tool_start" && entry.toolName === "Agent",
  "native Agent tool did not start exactly once",
);
const agentArgs = parseLine<ToolArguments>(agentStart.args ?? "{}");
requireEvidence(
  agentArgs.model === "coordination-fixture/child",
  "Agent used the wrong child model",
);
requireEvidence(agentArgs.name === childAlias, "Agent used the wrong child alias");
requireEvidence(agentArgs.run_in_background === true, "Agent was not backgrounded");
requireEvidence(agentArgs.isolated === true, "Agent child was not isolated");
requireEvidence(
  !JSON.stringify(agentArgs).includes(marker),
  "fixture marker leaked into Agent arguments",
);

const messageSend = one(
  (entry) =>
    entry.event === "send_message" &&
    entry.customType === "subagent-message" &&
    entry.content?.includes(marker) === true,
  "actual child-to-root send is not unique",
);
requireEvidence(
  messageSend.content ===
    `<agent-message from="${childAlias}" type="MESSAGE">\n${marker}\n</agent-message>`,
  "child-to-root envelope is not the exact production envelope",
);
requireEvidence(
  messageSend.deliverAs === "steer" && messageSend.triggerTurn === true,
  "child-to-root send did not use steer with triggerTurn",
);

const deliveryStarted = one(
  (entry) => entry.event === "delivery_barrier_started",
  "delivery barrier did not start exactly once",
);
const deliveryReleased = one(
  (entry) => entry.event === "delivery_barrier_released",
  "delivery barrier did not release exactly once",
);
const settlementStarted = one(
  (entry) => entry.event === "settlement_barrier_started",
  "settlement barrier did not start exactly once",
);
const publication = one(
  (entry) => entry.event === "production_publication",
  "production publication event is not unique",
);
const settled = one(
  (entry) => entry.event === "settlement_observed",
  "settled record observation is not unique",
);
const terminalSend = one(
  (entry) => entry.event === "send_message" && entry.customType === "subagent-notification",
  "terminal notification send is not unique",
);
const settlementReleased = one(
  (entry) => entry.event === "settlement_barrier_released",
  "settlement barrier did not release exactly once",
);
const publicationEvent = parseLine<CompletedEventData>(publication.eventData ?? "{}");

for (const entry of [
  deliveryStarted,
  deliveryReleased,
  settlementStarted,
  publication,
  settled,
  settlementReleased,
]) {
  requireEvidence(entry.id === childId, `${entry.event} child ID mismatch`);
}
for (const entry of [deliveryReleased, publication, settled, settlementReleased]) {
  requireEvidence(entry.generation === generation, `${entry.event} generation mismatch`);
}
requireEvidence(settled.status === "completed", "child did not settle as completed");
requireEvidence(publication.status === "completed", "publication status was not completed");
requireEvidence(
  publication.alias === childAlias && settled.alias === childAlias,
  "publication or settled-record alias mismatch",
);
requireEvidence(
  publicationEvent.id === childId && publicationEvent.status === "completed",
  "production completion event payload did not identify the completed child",
);
requireEvidence(
  terminalSend.deliverAs === "steer" && terminalSend.triggerTurn === true,
  "terminal send did not use steer with triggerTurn",
);
requireEvidence(
  xmlValue(terminalSend.content ?? "", "task-id") === childId &&
    Number(xmlValue(terminalSend.content ?? "", "generation")) === generation &&
    xmlValue(terminalSend.content ?? "", "status") === "Done",
  "terminal notification identity, generation, or status mismatch",
);

const deliveryToolEnd = one(
  (entry) => entry.event === "tool_end" && entry.toolName === "coordination_delivery_barrier",
  "delivery barrier tool result is not unique",
);
const settlementToolEnd = one(
  (entry) => entry.event === "tool_end" && entry.toolName === "coordination_settlement_barrier",
  "settlement barrier tool result is not unique",
);
const coordinationContext = entries.find(
  (entry) => position(entry) > position(deliveryToolEnd) && entry.event === "context",
);
requireEvidence(
  coordinationContext !== undefined && (coordinationContext.coordination ?? 0) > 0,
  "coordination envelope was absent from the first context after its barrier",
);
const terminalContext = entries.find(
  (entry) => position(entry) > position(settlementToolEnd) && entry.event === "context",
);
requireEvidence(
  terminalContext !== undefined && (terminalContext.terminal ?? 0) > 0,
  "terminal notification was absent from the first context after its barrier",
);
const resultStart = one(
  (entry) => entry.event === "tool_start" && entry.toolName === "get_subagent_result",
  "get_subagent_result did not start exactly once",
);
const resultEnd = one(
  (entry) => entry.event === "tool_end" && entry.toolName === "get_subagent_result",
  "get_subagent_result did not finish exactly once",
);
requireEvidence(resultStart.args !== undefined, "get_subagent_result arguments missing");
requireEvidence(
  parseLine<{ agent_id?: string }>(resultStart.args).agent_id === childId,
  "get_subagent_result child ID mismatch",
);
requireEvidence(resultEnd.isError === false, "get_subagent_result returned an error");
const resultPayload = parseLine<{ content?: ContentBlock[] }>(resultEnd.result ?? "{}");
requireEvidence(
  contentText(resultPayload.content).includes(`Agent: ${childId}\n`) &&
    contentText(resultPayload.content).includes("Status: completed"),
  "get_subagent_result lacked the completed child identity",
);

const firstAgentEnd = matches((entry) => entry.event === "outer_agent_end")[0];
requireEvidence(firstAgentEnd !== undefined, "outer agent_end was not observed");
requireEvidence(
  firstAgentEnd.count === 1 && firstAgentEnd.complete === true,
  "first agent_end was early",
);
requireEvidence(
  position(childCallsMessage) < position(messageSend) &&
    position(messageSend) < position(deliveryReleased) &&
    position(deliveryReleased) < position(deliveryToolEnd) &&
    position(deliveryToolEnd) < position(coordinationContext) &&
    position(coordinationContext) < position(settlementStarted) &&
    position(messageSend) < position(publication) &&
    position(publication) < position(terminalSend) &&
    position(settlementStarted) < position(settled) &&
    position(settled) < position(settlementReleased) &&
    position(settlementReleased) < position(settlementToolEnd) &&
    position(settlementToolEnd) < position(terminalContext) &&
    position(terminalContext) < position(resultStart) &&
    position(resultEnd) < position(firstAgentEnd),
  "send/barrier/context/settlement/consume/agent_end ordering was violated",
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

const sessions = new Map<string, SessionEntry[]>();
const discoveredSessionFiles = await sessionFiles(sessionDir);
if (settled.sessionFile && !discoveredSessionFiles.includes(settled.sessionFile)) {
  discoveredSessionFiles.push(settled.sessionFile);
}
for (const path of discoveredSessionFiles) {
  sessions.set(
    path,
    (await readFile(path, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => parseLine<SessionEntry>(line)),
  );
}
requireEvidence(sessions.size > 0, "no persisted session JSONL found");

function toolCalls(sessionEntries: SessionEntry[], toolName: string): ContentBlock[] {
  return sessionEntries.flatMap((entry) =>
    entry.type === "message" &&
    entry.message?.role === "assistant" &&
    Array.isArray(entry.message.content)
      ? entry.message.content.filter(
          (block) => block.type === "toolCall" && block.name === toolName,
        )
      : [],
  );
}

const rootSessions = [...sessions.entries()].filter(([, sessionEntries]) =>
  toolCalls(sessionEntries, "Agent").some((call) => call.arguments?.name === childAlias),
);
requireEvidence(
  rootSessions.length === 1,
  "could not identify one root session from its Agent call",
);
const rootEntries = rootSessions[0]![1];
const persistedAgentCalls = toolCalls(rootEntries, "Agent");
requireEvidence(persistedAgentCalls.length === 1, "persisted Agent call is not unique");
requireEvidence(
  !JSON.stringify(persistedAgentCalls[0]!.arguments).includes(marker),
  "marker leaked into persisted Agent arguments",
);

const initialUserMessages = rootEntries.filter(
  (entry) => entry.type === "message" && entry.message?.role === "user",
);
requireEvidence(initialUserMessages.length >= 1, "root user prompt missing");
requireEvidence(
  initialUserMessages.every((entry) => !contentText(entry.message?.content).includes(marker)),
  "marker leaked into the parent user prompt",
);

const persistedMessages = rootEntries.filter(
  (entry) => entry.type === "custom_message" && entry.customType === "subagent-message",
);
requireEvidence(persistedMessages.length === 1, "persisted coordination message is not unique");
requireEvidence(
  contentText(persistedMessages[0]!.content) === messageSend.content,
  "persisted coordination envelope differs from the actual send",
);
const persistedNotices = rootEntries.filter(
  (entry) => entry.type === "custom_message" && entry.customType === "subagent-notification",
);
requireEvidence(persistedNotices.length === 1, "persisted terminal notification is not unique");
requireEvidence(
  xmlValue(contentText(persistedNotices[0]!.content), "task-id") === childId &&
    Number(xmlValue(contentText(persistedNotices[0]!.content), "generation")) === generation,
  "persisted terminal notification identity or generation mismatch",
);

const persistedResults = rootEntries.filter(
  (entry) =>
    entry.type === "message" &&
    entry.message?.role === "toolResult" &&
    entry.message.toolName === "get_subagent_result",
);
requireEvidence(persistedResults.length === 1, "persisted result consumption is not unique");
requireEvidence(
  contentText(persistedResults[0]!.message?.content).includes(`Agent: ${childId}\n`) &&
    contentText(persistedResults[0]!.message?.content).includes("Status: completed"),
  "persisted terminal result lacks the completed child identity",
);

requireEvidence(settled.sessionFile !== undefined, "production child session file was not traced");
const childEntries = sessions.get(settled.sessionFile);
requireEvidence(childEntries !== undefined, "production child session JSONL was not loaded");
const childMessageCalls = toolCalls(childEntries, "agent_message").filter(
  (call) => call.arguments?.message === marker && call.arguments.to === "/root",
);
requireEvidence(
  childMessageCalls.length === 1,
  "actual child agent_message call is not persisted once",
);

process.stdout.write("coordination host evidence verified\n");
