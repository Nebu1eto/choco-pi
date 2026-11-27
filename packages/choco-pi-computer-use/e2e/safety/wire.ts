import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { isJsonObject, isString, type JsonObject, type JsonValue } from "../../src/json.ts";

/** Commands the safety harness never sends and never lets the TS layer send. */
export const FORBIDDEN_COMMANDS = new Set([
  "shutdown",
  "registerPermissions",
  "openPermissionPane",
]);

export function reduceReply(cmd: string, reply: JsonObject): JsonObject {
  const { id: _id, ...rest } = reply;
  if (cmd === "look") {
    const summary: JsonObject = { ok: rest.ok ?? null };
    if (rest.error !== undefined) summary.error = rest.error;
    const result = rest.result;
    if (isJsonObject(result)) {
      const reduced: JsonObject = {};
      if (isString(result.lookId)) reduced.lookId = result.lookId;
      if (isJsonObject(result.window)) {
        const window = result.window;
        reduced.window = {
          windowId: window.windowId ?? null,
          framePoints: window.framePoints ?? null,
        };
      }
      summary.result = reduced;
    }
    return summary;
  }
  if (cmd === "diagnostics" && isJsonObject(rest.result)) {
    const { recentCompletedRequestIds: _ids, ...result } = rest.result;
    return { ...rest, result };
  }
  if (["axReadText", "focusedElement", "hitTest", "getUserContext"].includes(cmd)) {
    const summary: JsonObject = { ok: rest.ok ?? null };
    if (rest.error !== undefined) summary.error = rest.error;
    return summary;
  }
  return rest;
}

export class RequestLog {
  readonly path: string;
  readonly rows: JsonObject[] = [];
  private seq = 0;
  private writing: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  add(request: JsonObject, origin: string): JsonObject {
    const row: JsonObject = { ...request, origin, seq: ++this.seq, at: Date.now() };
    this.rows.push(row);
    void this.flush();
    return row;
  }

  answer(row: JsonObject, reply: JsonObject | undefined, error?: string): void {
    row.respondedAt = Date.now();
    const cmd = isString(row.cmd) ? row.cmd : "";
    if (reply) {
      row.response = reduceReply(cmd, reply);
      if (cmd === "cancel" && reply.ok === true && reply.result !== undefined)
        row.ack = reply.result;
    }
    if (error) row.transportError = error;
    void this.flush();
  }

  flush(): Promise<void> {
    const snapshot = this.rows.map((row) => JSON.stringify(row)).join("\n");
    this.writing = this.writing
      .then(() => writeFile(this.path, snapshot ? `${snapshot}\n` : ""))
      .catch((error: Error) => console.error(`request log write failed: ${error.message}`));
    return this.writing;
  }
}

export class WireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireError";
  }
}

export interface WireSession {
  id: string;
  generation: number;
}

export interface Sent {
  reply: JsonObject;
  row: JsonObject;
}

export class Wire {
  readonly socket: string;
  readonly log: RequestLog;
  readonly session: WireSession = { id: `u0-safety-${randomUUID()}`, generation: 0 };
  private counter = 0;

  constructor(socket: string, log: RequestLog) {
    this.socket = socket;
    this.log = log;
  }

  async send(
    cmd: string,
    args: JsonObject = {},
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Sent> {
    if (FORBIDDEN_COMMANDS.has(cmd)) throw new WireError(`harness refuses to send ${cmd}`);
    if (options.signal?.aborted) throw new WireError(`aborted before ${cmd}`);
    const request: JsonObject = { id: `safety_${++this.counter}`, cmd, ...args };
    const row = this.log.add(request, "harness");
    const timeoutMs = options.timeoutMs ?? 15_000;
    return await new Promise<Sent>((resolve, reject) => {
      const client = connect(this.socket);
      let buffer = "";
      let done = false;
      const finish = (reply: JsonObject | undefined, error?: string): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        client.destroy();
        this.log.answer(row, reply, error);
        if (reply) resolve({ reply, row });
        else reject(new WireError(`${cmd}: ${error ?? "no reply"}`));
      };
      const timer = setTimeout(
        () => finish(undefined, `timed out after ${timeoutMs} ms`),
        timeoutMs,
      );
      client.setEncoding("utf8");
      client.on("connect", () => client.write(`${JSON.stringify(request)}\n`));
      client.on("data", (chunk: string) => {
        buffer += chunk;
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        try {
          const value: JsonValue = JSON.parse(buffer.slice(0, end));
          finish(
            isJsonObject(value) ? value : undefined,
            isJsonObject(value) ? undefined : "non-object reply",
          );
        } catch (error) {
          finish(undefined, error instanceof Error ? error.message : String(error));
        }
      });
      client.on("error", (error) => finish(undefined, error.message));
      client.on("close", () => finish(undefined, "connection closed without a reply"));
    });
  }

  actEnvelope(budgetMs = 60_000): JsonObject {
    return {
      requestId: `u0-act-${randomUUID()}`,
      session: { ...this.session },
      budgetMs,
    };
  }
}
