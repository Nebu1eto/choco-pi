import { rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { isJsonObject, isString, type JsonObject, type JsonValue } from "../../src/json.ts";
import { FORBIDDEN_COMMANDS, type RequestLog } from "./wire.ts";

function objectOf(line: string): JsonObject | undefined {
  try {
    const value: JsonValue = JSON.parse(line);
    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export class GuardProxy {
  readonly listen: string;
  readonly upstream: string;
  log: RequestLog | undefined;
  readonly blocked: JsonObject[] = [];
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();

  constructor(listen: string, upstream: string) {
    this.listen = listen;
    this.upstream = upstream;
  }

  async start(): Promise<void> {
    await rm(this.listen, { force: true });
    this.server = createServer((client) => this.serve(client));
    const server = this.server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.listen, () => resolve());
    });
  }

  private serve(client: Socket): void {
    this.sockets.add(client);
    const upstream = connect(this.upstream);
    this.sockets.add(upstream);
    const open: JsonObject[] = [];
    let fromClient = "";
    let fromUpstream = "";
    client.setEncoding("utf8");
    upstream.setEncoding("utf8");
    client.on("data", (chunk: string) => {
      fromClient += chunk;
      for (let end = fromClient.indexOf("\n"); end >= 0; end = fromClient.indexOf("\n")) {
        const line = fromClient.slice(0, end);
        fromClient = fromClient.slice(end + 1);
        const request = objectOf(line);
        const cmd = request && isString(request.cmd) ? request.cmd : "";
        const row = request ? this.log?.add(request, "ts") : undefined;
        if (FORBIDDEN_COMMANDS.has(cmd)) {
          const reply: JsonObject = {
            id: request?.id ?? null,
            ok: false,
            error: { code: "harness_forbidden", message: `safety harness blocked ${cmd}` },
          };
          this.blocked.push({ cmd, at: Date.now() });
          if (row) {
            row.blocked = true;
            this.log?.answer(row, reply);
          }
          client.write(`${JSON.stringify(reply)}\n`);
          continue;
        }
        if (row) open.push(row);
        upstream.write(`${line}\n`);
      }
    });
    upstream.on("data", (chunk: string) => {
      if (!client.destroyed) client.write(chunk);
      fromUpstream += chunk;
      for (let end = fromUpstream.indexOf("\n"); end >= 0; end = fromUpstream.indexOf("\n")) {
        const reply = objectOf(fromUpstream.slice(0, end));
        fromUpstream = fromUpstream.slice(end + 1);
        const row = open.find((candidate) => candidate.id === reply?.id) ?? open[0];
        if (!row || !reply) continue;
        open.splice(open.indexOf(row), 1);
        this.log?.answer(row, reply);
      }
    });
    const close = (): void => {
      client.destroy();
      upstream.destroy();
      this.sockets.delete(client);
      this.sockets.delete(upstream);
    };
    client.on("end", () => upstream.end());
    upstream.on("end", () => client.end());
    client.on("close", () => {
      const timer = setTimeout(close, 30_000);
      upstream.once("close", () => clearTimeout(timer));
    });
    upstream.on("close", close);
    client.on("error", close);
    upstream.on("error", (error) => {
      for (const row of open) row.proxyError = error.message;
      close();
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(this.listen, { force: true });
  }
}
