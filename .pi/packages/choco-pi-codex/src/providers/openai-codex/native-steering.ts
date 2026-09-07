import { Type } from "typebox";
import { Check } from "typebox/value";
import { nativeRuntime } from "./native-runtime.ts";
import type {
  CodexStreamEvent,
  ProtocolValue,
  ResponsesBody,
  WebSocketEvent,
  WebSocketLike,
  CodexDiagnosticsSink,
} from "./types.ts";
import { decodeWebSocketData } from "./websocket-parser.ts";
import { DEFAULT_WEBSOCKET_CLOSE_TIMEOUT_MS } from "./constants.ts";
import {
  extractWebSocketCloseError,
  extractWebSocketError,
  isWebSocketMessageTooBigError,
} from "./websocket-connection.ts";
import {
  requestBodyForWebSocketContinuationComparison,
  responseInputsEqual,
} from "./websocket-continuation.ts";
import { extractCodexTurnStateFromWebSocketEvent } from "./turn-state.ts";

const EventSchema = Type.Object({
  type: Type.String(),
  response: Type.Optional(
    Type.Object({
      id: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
    }),
  ),
});
const SteerSchema = Type.Object({ id: Type.String(), previous_response_id: Type.String() });
const UserSchema = Type.Object({
  role: Type.Literal("user"),
  content: Type.Union([
    Type.String(),
    Type.Array(Type.Object({ type: Type.Literal("input_text"), text: Type.String() })),
  ]),
});
const OutputSchema = Type.Object({
  type: Type.Union([Type.Literal("function_call_output"), Type.Literal("custom_tool_call_output")]),
});
const IncompleteSchema = Type.Object({ reason: Type.Literal("steered") });

type Resolution = "automatic" | "required" | "failed";
interface PendingSteer {
  text: string;
  target: string;
  acceptedId?: string;
  ready: Promise<Resolution>;
  resolve: (value: Resolution) => void;
}
type Preparation =
  | { kind: "automatic" }
  | { kind: "send"; body: ResponsesBody }
  | { kind: "reconnect" };

const { bySocket, byOwner } = nativeRuntime;

function matchesUser(item: ProtocolValue, text: string): boolean {
  if (!Check(UserSchema, item)) return false;
  const content = Array.isArray(item.content)
    ? item.content.map((part) => part.text).join("")
    : item.content;
  return content === text;
}

/** Owns the socket inbox across two Pi turns; Pi still persists and dispatches the queued user input. */
export class NativeSteeringConnection {
  private socket: WebSocketLike;
  private owner: string;
  private closed = false;
  private generating = false;
  private responseId = "";
  private pending: PendingSteer | undefined;
  private body: ResponsesBody | undefined;
  private queue: { event: CodexStreamEvent; bytes: number }[] = [];
  private bytes = 0;
  private wake: (() => void) | undefined;
  private chain = Promise.resolve();
  private abortCleanup: (() => void) | undefined;
  private failure: Error | undefined;
  private socketError: Error | undefined;
  private socketErrorTimer: ReturnType<typeof setTimeout> | undefined;
  private onMessageTooBig: (() => void) | undefined;
  private trace: CodexDiagnosticsSink | undefined;
  steered = false;

  constructor(
    socket: WebSocketLike,
    owner: string,
    trace?: CodexDiagnosticsSink,
    onMessageTooBig?: () => void,
  ) {
    this.socket = socket;
    this.owner = owner;
    this.trace = trace;
    this.onMessageTooBig = onMessageTooBig;
    socket.addEventListener("message", this.onMessage);
    socket.addEventListener("close", this.onClose);
    socket.addEventListener("error", this.onError);
  }

  get hasPending(): boolean {
    return Boolean(this.pending);
  }

  steer(text: string): boolean {
    if (this.closed || !this.generating || this.pending || !text.trim() || text.length > 16384)
      return false;
    let resolve!: PendingSteer["resolve"];
    const ready = new Promise<Resolution>((done) => {
      resolve = done;
    });
    this.pending = { text, target: this.responseId, ready, resolve };
    try {
      this.socket.send(
        JSON.stringify({
          type: "response.steer",
          previous_response_id: this.responseId,
          input: text,
        }),
      );
      this.trace?.({ type: "native-steering", phase: "sent" });
      return true;
    } catch {
      this.close();
      return false; // Pi's ordinary input path still owns and queues this message.
    }
  }

  begin(body: ResponsesBody, signal?: AbortSignal): void {
    this.body = body;
    this.steered = false;
    this.abortCleanup?.();
    const abort = () => this.close();
    signal?.addEventListener("abort", abort, { once: true });
    this.abortCleanup = () => signal?.removeEventListener("abort", abort);
    if (signal?.aborted) this.close();
  }

  async prepare(
    request: ResponsesBody,
    fullBody: ResponsesBody,
    signal: AbortSignal | undefined,
    timeout: number,
  ): Promise<Preparation> {
    const pending = this.pending;
    if (!pending) return this.closed ? { kind: "reconnect" } : { kind: "send", body: request };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => pending.resolve("failed");
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (timeout > 0)
        timer = setTimeout(() => {
          this.close();
        }, timeout);
      if (signal?.aborted) abort();
      const resolution = await pending.ready;
      signal?.throwIfAborted();
      if (this.closed) return { kind: "reconnect" };
      this.pending = undefined;
      if (resolution === "failed") return { kind: "send", body: request };
      if (!pending.acceptedId) return { kind: "reconnect" };
      const users = request.input.filter((item) => matchesUser(item, pending.text));
      const outputs = request.input.filter((item) => !matchesUser(item, pending.text));
      const settingsMatch =
        this.body &&
        responseInputsEqual(
          [requestBodyForWebSocketContinuationComparison(this.body)],
          [requestBodyForWebSocketContinuationComparison(fullBody)],
        );
      if (request.previous_response_id !== pending.target || users.length !== 1 || !settingsMatch) {
        this.trace?.({
          type: "native-steering",
          phase:
            request.previous_response_id !== pending.target
              ? "fallback-history"
              : users.length !== 1
                ? "fallback-input"
                : "fallback-settings",
        });
        return { kind: "reconnect" };
      }
      if (resolution === "automatic")
        return outputs.length === 0 ? { kind: "automatic" } : { kind: "reconnect" };
      if (outputs.length === 0 || !outputs.every((item) => Check(OutputSchema, item)))
        return { kind: "reconnect" };
      // Accepted steering is implicitly prepended by the server. Do not send it twice.
      return { kind: "send", body: { ...request, input: outputs } };
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  async *responseEvents(
    signal: AbortSignal | undefined,
    timeout: number,
    onTurnState?: (value: string) => void,
  ): AsyncIterable<CodexStreamEvent> {
    while (true) {
      signal?.throwIfAborted();
      const next = this.queue.shift();
      if (next) {
        this.bytes -= next.bytes;
        const event = next.event;
        const turnState = extractCodexTurnStateFromWebSocketEvent(event);
        if (turnState) onTurnState?.(turnState);
        const terminal =
          event.type === "response.completed" ||
          event.type === "response.done" ||
          event.type === "response.incomplete";
        if (
          event.type === "response.incomplete" &&
          this.pending &&
          event.response?.id === this.pending.target &&
          Check(IncompleteSchema, event.response?.["incomplete_details"])
        ) {
          this.steered = true;
          // The server finished the current item: this is not a token-truncated tool call.
          yield {
            ...event,
            type: "response.completed",
            response: { ...event.response, status: "completed", incomplete_details: undefined },
          };
        } else {
          yield event;
        }
        if (terminal) return;
        continue;
      }
      if (this.closed)
        throw this.failure ?? new Error("Native steering WebSocket closed before completion");
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        if (timeout > 0)
          timer = setTimeout(() => {
            this.close();
          }, timeout);
      }).finally(() => {
        if (timer) clearTimeout(timer);
        this.wake = undefined;
      });
    }
  }

  finish(): void {
    if (!this.pending) this.close(false);
  }

  close(closeSocket = true): void {
    if (this.closed) return;
    this.closed = true;
    this.trace?.({ type: "native-steering", phase: "closed" });
    this.generating = false;
    this.pending?.resolve("failed");
    this.abortCleanup?.();
    if (this.socketErrorTimer) clearTimeout(this.socketErrorTimer);
    this.socket.removeEventListener("message", this.onMessage);
    this.socket.removeEventListener("close", this.onClose);
    this.socket.removeEventListener("error", this.onError);
    bySocket.delete(this.socket);
    if (byOwner.get(this.owner) === this) byOwner.delete(this.owner);
    this.wake?.();
    if (closeSocket) this.socket.close();
  }

  private onClose = (event: WebSocketEvent) => {
    const closeError = extractWebSocketCloseError(event);
    if (this.socketErrorTimer) clearTimeout(this.socketErrorTimer);
    void this.chain.finally(() => {
      if (this.closed) return;
      const tooBig = isWebSocketMessageTooBigError(closeError);
      this.failure = tooBig ? closeError : (this.socketError ?? closeError);
      if (tooBig) this.onMessageTooBig?.();
      this.close(false);
    });
  };
  private onError = (event: WebSocketEvent) => {
    this.socketError = extractWebSocketError(event);
    if (this.socketErrorTimer) clearTimeout(this.socketErrorTimer);
    this.socketErrorTimer = setTimeout(() => {
      if (this.closed) return;
      this.failure = this.socketError;
      this.close();
    }, DEFAULT_WEBSOCKET_CLOSE_TIMEOUT_MS);
  };
  private onMessage = (message: WebSocketEvent) => {
    const data = message.data;
    this.chain = this.chain
      .then(async () => {
        const text = await decodeWebSocketData(data);
        if (this.closed || !text) return;
        const parsed = JSON.parse(text);
        if (!Check(EventSchema, parsed)) throw new Error("Invalid native steering event");
        // SAFETY: The discriminator and response identity used here are checked; the existing Responses parser validates output items.
        const event = parsed as CodexStreamEvent;
        const pending = this.pending;
        if (event.type === "response.created" && event.response?.id) {
          this.responseId = event.response.id;
          this.generating = true;
          if (pending && this.responseId !== pending.target) {
            this.trace?.({ type: "native-steering", phase: "automatic-ready" });
            pending.resolve("automatic");
          }
        }
        if (
          event.type === "response.completed" ||
          event.type === "response.done" ||
          event.type === "response.incomplete"
        )
          this.generating = false;
        if (
          event.type === "response.steer.accepted" &&
          pending &&
          Check(SteerSchema, event["steer"]) &&
          event["steer"].previous_response_id === pending.target
        ) {
          pending.acceptedId = event["steer"].id;
          this.trace?.({ type: "native-steering", phase: "accepted" });
        }
        if (
          event.type === "response.steer.pending" &&
          pending &&
          Check(SteerSchema, event["steer"]) &&
          event["steer"].id === pending.acceptedId
        ) {
          this.trace?.({ type: "native-steering", phase: "required-ready" });
          pending.resolve("required");
        }
        if (event.type === "response.steer.failed" && pending) {
          this.trace?.({ type: "native-steering", phase: "failed" });
          pending.resolve("failed");
        }
        this.bytes += text.length;
        if (this.bytes > 2000000 || this.queue.length >= 10000)
          throw new Error("Native steering inbox limit exceeded");
        this.queue.push({ event, bytes: text.length });
        this.wake?.();
      })
      .catch(() => {
        this.failure = new Error("Native steering protocol failed");
        this.close();
      });
  };
}

export function nativeSteeringForSocket(
  socket: WebSocketLike,
): NativeSteeringConnection | undefined {
  return bySocket.get(socket);
}
export function openNativeSteering(
  socket: WebSocketLike,
  owner: string,
  trace?: CodexDiagnosticsSink,
  onMessageTooBig?: () => void,
): NativeSteeringConnection {
  const existing = bySocket.get(socket);
  if (existing) return existing;
  byOwner.get(owner)?.close();
  const connection = new NativeSteeringConnection(socket, owner, trace, onMessageTooBig);
  bySocket.set(socket, connection);
  byOwner.set(owner, connection);
  return connection;
}
export function steerNativeResponse(owner: string, text: string): boolean {
  return byOwner.get(owner)?.steer(text) ?? false;
}
export function closeNativeSteering(owner?: string): void {
  if (owner) byOwner.get(owner)?.close();
  else for (const connection of byOwner.values()) connection.close();
}
