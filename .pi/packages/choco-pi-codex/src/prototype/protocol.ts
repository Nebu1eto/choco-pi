import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Check } from "typebox/value";
import {
  demoTool,
  emptyArgumentsSchema,
  type WireEvent,
  type WireRequest,
  type WireUsage,
} from "./wire.ts";

export interface PrototypeTransport {
  events: AsyncIterable<WireEvent>;
  send(event: WireRequest): void;
  close(): void;
}
export type PrototypeMode = "steering" | "async";

/** Single-turn experiment: owns only a synthetic tool, never Pi's tool registry. */
export class PrototypeTurn {
  readonly trace: string[] = [];
  readonly steeringInputs: string[] = [];
  responseId = "";
  private transport: PrototypeTransport;
  private mode: PrototypeMode;
  private active = true;
  private steeringSent = false;
  private steeringAccepted = false;
  private steeringId = "";
  private steeringTarget = "";
  private calls = new Set<string>();
  private job: Promise<string> | undefined;
  private jobOwner = new AbortController();
  private jobFinished = false;
  private marker = "";
  private continuationText = "";
  private callId = "";
  private delivered = false;

  constructor(transport: PrototypeTransport, mode: PrototypeMode) {
    this.transport = transport;
    this.mode = mode;
  }

  steer(input: string): boolean {
    if (!this.active || this.mode !== "steering" || !this.responseId || this.steeringSent) {
      return false;
    }
    if (!input.trim() || input.length > 4096) return false;
    this.transport.send({ type: "response.steer", previous_response_id: this.responseId, input });
    this.steeringTarget = this.responseId;
    this.steeringSent = true;
    this.steeringInputs.push(input);
    this.trace.push("steer_sent");
    return true;
  }

  close(): void {
    this.active = false;
    this.jobOwner.abort();
    this.transport.close();
  }

  async run(options: {
    prompt: string;
    signal: AbortSignal;
    onText: (text: string) => void;
    onCreated?: () => void;
    onUsage?: (usage: WireUsage) => void;
  }): Promise<void> {
    const { signal, onText, onCreated, onUsage, prompt } = options;
    const transport = this.transport;
    const abort = () => this.close();
    signal.throwIfAborted();
    signal.addEventListener("abort", abort, { once: true });
    const settings = {
      model: "gpt-6-astra",
      store: false,
      instructions:
        "You are a bounded protocol experiment. Follow the user. Never invent tool output.",
      reasoning: { effort: "low" },
      tools: this.mode === "async" ? [demoTool] : [],
    };
    try {
      const request: WireRequest = {
        type: "response.create",
        ...settings,
        input: [{ role: "user", content: prompt }],
      };
      if (this.mode === "async") request.tool_choice = { type: "function", name: demoTool.name };
      transport.send(request);
      let events = 0;
      let textLength = 0;
      for await (const event of transport.events) {
        signal.throwIfAborted();
        if (!this.active) throw new Error("prototype_closed");
        if (++events > 10000) throw new Error("prototype_event_limit");
        const type = event.type;
        const response = event.response;
        const id = response?.id ?? "";
        if (type === "error" || type === "response.failed" || type === "response.steer.failed") {
          // Never report arbitrary response bodies, request headers, or credential-bearing errors.
          const code = event.error?.code ?? "";
          throw new Error(
            `prototype_remote_failure:${type}:${/^[a-z_]{1,80}$/.test(code) ? code : "unspecified"}`,
          );
        }
        if (type === "response.created") {
          if (!id) throw new Error("prototype_missing_response_id");
          this.responseId = id;
          this.trace.push("response_created");
          onCreated?.();
        } else if (type === "response.steer.accepted") {
          const steer = event.steer;
          if (!this.steeringSent || steer?.previous_response_id !== this.steeringTarget) {
            throw new Error("prototype_unmatched_steer");
          }
          this.steeringId = steer.id ?? "";
          if (!this.steeringId) throw new Error("prototype_missing_steer_id");
          this.steeringAccepted = true;
          this.trace.push("steer_accepted");
        } else if (type === "response.steer.pending") {
          // Steering experiment advertises no tools. Do not fake approval or tool outputs.
          throw new Error("prototype_unexpected_required_input");
        } else if (type === "response.output_text.delta") {
          const delta = event.delta ?? "";
          textLength += delta.length;
          if (textLength > 24000) throw new Error("prototype_text_limit");
          if (this.job && !this.jobFinished && !this.trace.includes("text_before_result")) {
            this.trace.push("text_before_result");
          }
          if (this.delivered) this.continuationText += delta;
          onText(delta);
        } else if (type === "response.output_item.done") {
          const item = event.item;
          if (item?.type === "function_call" || item?.type === "custom_tool_call") {
            if (
              this.mode !== "async" ||
              item.type !== "function_call" ||
              item.name !== demoTool.name ||
              item.async !== true
            ) {
              throw new Error("prototype_not_native_async");
            }
            const callId = item.call_id ?? "";
            if (!callId || this.calls.has(callId) || this.calls.size >= 1) {
              throw new Error("prototype_duplicate_or_extra_call");
            }
            if (!Check(emptyArgumentsSchema, JSON.parse(item.arguments ?? "null"))) {
              throw new Error("prototype_invalid_tool_arguments");
            }
            this.calls.add(callId);
            this.callId = callId;
            this.trace.push("tool_started");
            this.marker = randomUUID();
            this.job = delay(1500, JSON.stringify({ marker: this.marker, source: "synthetic" }), {
              signal: AbortSignal.any([signal, this.jobOwner.signal]),
            }).then((output) => {
              this.jobFinished = true;
              return output;
            });
            // Attach immediately: cancellation may happen while still consuming model output.
            void this.job.catch(() => {});
          }
        } else if (type === "response.incomplete" || type === "response.completed") {
          if (id !== this.responseId) throw new Error("prototype_unmatched_completion");
          if (response?.usage) onUsage?.(response.usage);
          if (type === "response.incomplete") {
            if (
              !this.steeringSent ||
              id !== this.steeringTarget ||
              response?.incomplete_details?.reason !== "steered"
            ) {
              throw new Error("prototype_incomplete");
            }
            this.trace.push("response_steered");
            continue;
          }
          this.trace.push("response_completed");
          if (this.mode === "steering") {
            if (this.steeringSent && id === this.steeringTarget) continue;
            if (!this.steeringAccepted || id === this.steeringTarget) {
              throw new Error("prototype_steering_not_proven");
            }
            this.trace.push("steering_successor_completed");
            return;
          }
          if (!this.job) throw new Error("prototype_missing_async_call");
          if (this.delivered) {
            if (!this.continuationText.includes(this.marker))
              throw new Error("prototype_result_not_used");
            this.trace.push("async_continuation_completed");
            return;
          }
          const output = await this.job;
          signal.throwIfAborted();
          if (!this.active) throw new Error("prototype_closed");
          this.delivered = true;
          this.trace.push("tool_result_delivered");
          transport.send({
            type: "response.create",
            ...settings,
            tool_choice: "none",
            previous_response_id: id,
            input: [{ type: "function_call_output", call_id: this.callId, output }],
          });
        }
      }
      signal.throwIfAborted();
      throw new Error("prototype_connection_closed_before_completion");
    } finally {
      signal.removeEventListener("abort", abort);
      this.close();
    }
  }
}
