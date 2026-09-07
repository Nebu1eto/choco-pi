import { randomUUID } from "node:crypto";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { WebSocket } from "undici";
import {
  buildWebSocketHeaders,
  extractAccountId,
  resolveCodexWebSocketUrl,
} from "../providers/openai-codex/headers.ts";
import { Check } from "typebox/value";
import type { PrototypeTransport } from "./protocol.ts";
import { wireEventSchema, textFrameSchema, type WireEvent } from "./wire.ts";

/** Uses an existing unexpired credential; never refreshes or writes authentication. */
export async function connectPrototype(signal: AbortSignal): Promise<PrototypeTransport> {
  signal.throwIfAborted();
  const credential = readStoredCredential("openai-codex");
  if (credential?.type !== "oauth" || credential.expires <= Date.now() + 120000) {
    throw new Error("prototype_requires_existing_unexpired_codex_login");
  }
  const headers = buildWebSocketHeaders(
    undefined,
    undefined,
    extractAccountId(credential.access),
    credential.access,
    randomUUID(),
  );
  const socket = new WebSocket(resolveCodexWebSocketUrl(undefined), {
    headers: Object.fromEntries(headers),
  });
  let ended = false;
  let controller: ReadableStreamDefaultController<WireEvent>;
  const events = new ReadableStream<WireEvent>({
    start(value) {
      controller = value;
    },
  });
  const close = () => {
    if (ended) return;
    ended = true;
    signal.removeEventListener("abort", close);
    socket.close();
    controller.close();
  };
  const fail = () => {
    if (ended) return;
    ended = true;
    signal.removeEventListener("abort", close);
    controller.error(new Error("prototype_websocket_failure"));
    socket.close();
  };
  socket.addEventListener("message", (event) => {
    if (ended) return;
    try {
      if (!Check(textFrameSchema, event.data)) {
        fail();
        return;
      }
      const parsed = JSON.parse(event.data);
      if (!Check(wireEventSchema, parsed)) {
        fail();
        return;
      }
      controller.enqueue(parsed);
    } catch {
      fail();
    }
  });
  socket.addEventListener("close", close);
  signal.addEventListener("abort", close, { once: true });
  // The reader exists before opening so connection errors cannot become unhandled rejections.
  const reader = events.getReader();
  try {
    await new Promise<void>((resolve, reject) => {
      const opened = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error("prototype_websocket_connect_failure"));
      };
      const cleanup = () => {
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
        signal.removeEventListener("abort", failed);
      };
      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener("error", failed, { once: true });
      socket.addEventListener("close", failed, { once: true });
      signal.addEventListener("abort", failed, { once: true });
    });
    signal.throwIfAborted();
    socket.addEventListener("error", fail);
  } catch (error) {
    close();
    reader.releaseLock();
    throw error;
  }
  return {
    events: (async function* () {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) return;
          yield next.value;
        }
      } finally {
        reader.releaseLock();
      }
    })(),
    send(event) {
      signal.throwIfAborted();
      if (ended) throw new Error("prototype_socket_closed");
      socket.send(JSON.stringify(event));
    },
    close,
  };
}
