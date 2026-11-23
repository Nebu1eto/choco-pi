import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { isJsonObject, isString, type JsonObject, type JsonValue } from "../src/json.ts";

const fullReplies = new Set(["act", "actBatch", "cancel", "claim", "release"]);

interface Options {
  listen: string;
  upstream: string;
  log: string;
  cancelAfterMs?: number;
}

function parse(argv: string[]): Options {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const listen = value("--listen");
  const upstream = value("--upstream");
  const log = value("--log");
  const cancel = value("--cancel-typetext-after-ms");
  if (!listen || !upstream || !log) throw new Error("usage: --listen --upstream --log required");
  const cancelAfterMs = cancel === undefined ? undefined : Number(cancel);
  if (cancelAfterMs !== undefined && !(Number.isSafeInteger(cancelAfterMs) && cancelAfterMs > 0))
    throw new Error("--cancel-typetext-after-ms must be a positive integer");
  return { listen, upstream, log, cancelAfterMs };
}

function recorded(cmd: string, reply: JsonObject): JsonObject {
  const { id: _id, ...rest } = reply;
  if (fullReplies.has(cmd)) return rest;
  const summary: JsonObject = { ok: rest.ok ?? null };
  if (rest.error !== undefined) summary.error = rest.error;
  const result = rest.result;
  if (isJsonObject(result) && isString(result.lookId)) summary.result = { lookId: result.lookId };
  return summary;
}

function lineOf(buffer: string): { line: string; rest: string } | undefined {
  const end = buffer.indexOf("\n");
  return end < 0 ? undefined : { line: buffer.slice(0, end), rest: buffer.slice(end + 1) };
}

function objectOf(line: string): JsonObject | undefined {
  try {
    const value: JsonValue = JSON.parse(line);
    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  const rows: JsonObject[] = [];
  let seq = 0;
  let writing: Promise<void> = Promise.resolve();
  const flush = (): Promise<void> => {
    const snapshot = rows.map((row) => JSON.stringify(row)).join("\n");
    writing = writing
      .then(() => writeFile(options.log, snapshot ? `${snapshot}\n` : ""))
      .catch((error: Error) => console.error(`proxy log write failed: ${error.message}`));
    return writing;
  };
  const pending = new Map<string, JsonObject>();

  const harnessCancel = (requestId: string): void => {
    const row: JsonObject = {
      id: `harness_cancel_${randomUUID()}`,
      cmd: "cancel",
      target: requestId,
      origin: "harness",
      seq: ++seq,
      at: Date.now(),
    };
    rows.push(row);
    void flush();
    const upstream = connect(options.upstream);
    let buffer = "";
    upstream.setEncoding("utf8");
    upstream.on("connect", () => {
      const { origin: _o, seq: _s, at: _a, ...wire } = row;
      upstream.write(`${JSON.stringify(wire)}\n`);
    });
    upstream.on("data", (chunk: string) => {
      buffer += chunk;
      const next = lineOf(buffer);
      if (!next) return;
      const reply = objectOf(next.line);
      row.respondedAt = Date.now();
      if (reply) {
        row.response = recorded("cancel", reply);
        if (reply.ok === true && reply.result !== undefined) row.ack = reply.result;
      }
      upstream.end();
      void flush();
    });
    upstream.on("error", (error) => {
      row.error = error.message;
      void flush();
    });
  };

  const server = createServer((client: Socket) => {
    const upstream = connect(options.upstream);
    const open: JsonObject[] = [];
    let fromClient = "";
    let fromUpstream = "";
    client.on("data", (chunk: Buffer) => {
      upstream.write(chunk);
      fromClient += chunk.toString("utf8");
      for (let next = lineOf(fromClient); next; next = lineOf(fromClient)) {
        fromClient = next.rest;
        const request = objectOf(next.line);
        if (!request) continue;
        const row: JsonObject = { ...request, origin: "pi", seq: ++seq, at: Date.now() };
        rows.push(row);
        open.push(row);
        const requestId = request.requestId;
        if (
          options.cancelAfterMs !== undefined &&
          request.cmd === "act" &&
          request.action === "typeText" &&
          isString(requestId)
        ) {
          pending.set(requestId, row);
          setTimeout(() => {
            if (pending.get(requestId) === row && row.response === undefined)
              harnessCancel(requestId);
          }, options.cancelAfterMs);
        }
      }
      void flush();
    });
    upstream.on("data", (chunk: Buffer) => {
      if (!client.destroyed) client.write(chunk);
      fromUpstream += chunk.toString("utf8");
      for (let next = lineOf(fromUpstream); next; next = lineOf(fromUpstream)) {
        fromUpstream = next.rest;
        const reply = objectOf(next.line);
        const row = open.find((candidate) => candidate.id === reply?.id) ?? open[0];
        if (!row || !reply) continue;
        open.splice(open.indexOf(row), 1);
        row.respondedAt = Date.now();
        row.response = recorded(isString(row.cmd) ? row.cmd : "", reply);
        if (row.cmd === "cancel" && reply.ok === true && reply.result !== undefined)
          row.ack = reply.result;
        if (isString(row.requestId)) pending.delete(row.requestId);
      }
      void flush();
    });
    client.on("end", () => upstream.end());
    client.on("close", () => {
      const timer = setTimeout(() => upstream.destroy(), 120_000);
      upstream.once("close", () => clearTimeout(timer));
    });
    client.on("error", () => undefined);
    upstream.on("end", () => client.end());
    upstream.on("error", (error) => {
      for (const row of open) row.proxyError = error.message;
      client.destroy();
      void flush();
    });
  });

  await rm(options.listen, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.listen, () => resolve());
  });
  console.log(`proxy listening ${options.listen} -> ${options.upstream}`);
  const stop = (): void => {
    server.close();
    void flush().then(async () => {
      await rm(options.listen, { force: true });
      process.exit(0);
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

await main();
