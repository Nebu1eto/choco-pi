export const ROOT_AGENT_PATH = "/root";

export const AGENT_MESSAGE_TYPES = ["MESSAGE", "TASK", "FINAL"] as const;
export type AgentMessageType = (typeof AGENT_MESSAGE_TYPES)[number];

export type ParsedAgentMessage = {
  from: string;
  type: AgentMessageType;
  body: string;
};

export interface MessagingRecord {
  id: string;
  handle?: string;
  alias?: string;
  parentAgentId?: string;
  status: string;
  session?: unknown;
  resultGeneration?: number;
  terminalResultGeneration?: number;
  cancellation?: { generation: number };
}

export type RecipientResolution<T extends MessagingRecord = MessagingRecord> =
  | { ok: true; kind: "root"; address: typeof ROOT_AGENT_PATH }
  | { ok: true; kind: "agent"; address: string; record: T }
  | { ok: false; error: string; candidates: string[] };

export function getAgentIdentity(record: MessagingRecord): string {
  const identity = record.alias ?? record.handle;
  if (!identity)
    throw new Error(`Cannot compute agent identity: agent "${record.id}" has no handle.`);
  return identity;
}

function editDistance(left: string, right: string): number {
  const prior = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    let diagonal = prior[0];
    prior[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const above = prior[rightIndex];
      prior[rightIndex] = Math.min(
        prior[rightIndex] + 1,
        prior[rightIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return prior[right.length];
}

function nearMatches(
  target: string,
  candidates: Array<{ address: string; record: MessagingRecord }>,
): string[] {
  const wanted = target.toLowerCase();
  return candidates
    .map(({ address, record }) => {
      const names = [address, record.handle, record.alias, record.id]
        .filter((name): name is string => name !== undefined)
        .map((name) => name.toLowerCase());
      return {
        address,
        score: Math.min(...names.map((name) => editDistance(wanted, name))),
      };
    })
    .sort((left, right) => left.score - right.score || left.address.localeCompare(right.address))
    .slice(0, 5)
    .map(({ address }) => address);
}

export function resolveMessageRecipient<T extends MessagingRecord>(
  to: string,
  records: readonly T[],
): RecipientResolution<T> {
  if (to === ROOT_AGENT_PATH) return { ok: true, kind: "root", address: ROOT_AGENT_PATH };

  const candidates: Array<{ record: T; address: string }> = [];
  for (const record of records) {
    try {
      candidates.push({ record, address: getAgentIdentity(record) });
    } catch {}
  }
  const target = to.split("/").filter(Boolean).at(-1) ?? to;
  const byId = candidates.find(({ record }) => record.id === target);
  if (byId) return { ok: true, kind: "agent", ...byId };

  const wanted = target.toLowerCase();
  const byIdentity = candidates.filter(
    ({ record }) =>
      record.handle?.toLowerCase() === wanted || record.alias?.toLowerCase() === wanted,
  );
  if (byIdentity.length === 1) return { ok: true, kind: "agent", ...byIdentity[0] };
  if (byIdentity.length > 1) {
    const addresses = byIdentity.map(({ address }) => address).sort();
    return {
      ok: false,
      candidates: addresses,
      error: `Ambiguous agent identity "${to}". Candidates: ${addresses.join(", ")}.`,
    };
  }

  const nearby = nearMatches(target, candidates);
  return {
    ok: false,
    candidates: nearby,
    error:
      nearby.length > 0
        ? `Unknown agent recipient "${to}". Near matches: ${nearby.join(", ")}.`
        : `Unknown agent recipient "${to}". No agents are currently available.`,
  };
}

export function formatAgentMessage(
  senderIdentity: string,
  text: string,
  type: AgentMessageType = "MESSAGE",
): string {
  const neutralizedText = text.replace(/<(\/?agent-message)/gi, "<\u200B$1");
  return `<agent-message from="${senderIdentity}" type="${type}">\n${neutralizedText}\n</agent-message>`;
}

export function parseAgentMessage(text: string): ParsedAgentMessage | undefined {
  const match =
    /^<agent-message from="([^"\r\n]+)" type="(MESSAGE|TASK|FINAL)">\r?\n([\s\S]*)\r?\n<\/agent-message>$/.exec(
      text,
    );
  if (!match) return undefined;
  const type = match[2];
  if (type !== "MESSAGE" && type !== "TASK" && type !== "FINAL") return undefined;
  return {
    from: match[1],
    type,
    body: match[3],
  };
}

export function formatSteerMessage(senderIdentity: string, text: string): string {
  return formatAgentMessage(senderIdentity, text, "MESSAGE");
}

export type MessageDeliveryClass = "running" | "queued" | "closing" | "finished";

export function classifyMessageDelivery(record: MessagingRecord): MessageDeliveryClass {
  const generation = record.resultGeneration ?? 1;
  const active =
    record.status === "running" ||
    record.status === "queued" ||
    record.status === "waiting_for_reset";
  if (
    active &&
    record.cancellation?.generation === generation &&
    record.terminalResultGeneration !== generation
  ) {
    return "closing";
  }
  if (record.status === "running" && record.session !== undefined) return "running";
  if (active) return "queued";
  return "finished";
}
