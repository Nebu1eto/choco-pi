import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { PrototypeTurn, type PrototypeMode, type PrototypeTransport } from "./protocol.ts";

export const prototypeProvider = "choco-codex-prototype";

/** Explicitly loaded experiment. No registered-tool bridge, host mutation, or Code Mode. */
export function prototypeExtension(options: {
  mode: PrototypeMode;
  connect: (signal: AbortSignal) => Promise<PrototypeTransport>;
  onCreated?: (turn: PrototypeTurn) => void;
  onFinished?: (turn: PrototypeTurn) => void;
}): ExtensionFactory {
  return (pi) => {
    let generation = 0;
    let used = false;
    let active: PrototypeTurn | undefined;
    let owner: AbortController | undefined;
    const reset = () => {
      generation++;
      owner?.abort();
      active?.close();
      active = undefined;
    };
    pi.on("session_shutdown", reset);
    pi.on("session_start", reset);
    pi.on("input", (event, ctx) => {
      if (ctx.model?.provider !== prototypeProvider || event.streamingBehavior !== "steer") return;
      if (active && !event.images?.length && active.steer(event.text)) {
        // Persist explicitly as experiment metadata, not a fabricated normal Pi user turn.
        pi.appendEntry("codex-prototype-steer", { text: event.text });
        return { action: "handled" };
      }
      // Do not silently downgrade unsupported input into delayed steering.
      pi.appendEntry("codex-prototype-rejected-input", {
        reason: "prototype_steering_unavailable",
      });
      ctx.ui.notify("Prototype steering unavailable; input was not submitted.", "error");
      return { action: "handled" };
    });
    pi.registerProvider(prototypeProvider, {
      api: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      apiKey: "prototype-uses-own-readonly-auth",
      models: [
        {
          id: "gpt-6-astra",
          name: "Codex protocol prototype (one turn)",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32000,
          maxTokens: 6000,
        },
      ],
      streamSimple(model, context, streamOptions) {
        const stream = createAssistantMessageEventStream();
        const epoch = generation;
        const controller = new AbortController();
        owner = controller;
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(90000),
          ...(streamOptions?.signal ? [streamOptions.signal] : []),
        ]);
        const output: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [{ type: "text", text: "" }],
          stopReason: "pending",
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        const user = context.messages.at(-1);
        const prompt =
          user?.role === "user" && !Array.isArray(user.content)
            ? user.content
            : user?.role === "user" && Array.isArray(user.content)
              ? user.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
              : "";
        const wasUsed = used;
        used = true;
        void (async () => {
          let turn: PrototypeTurn | undefined;
          try {
            if (
              wasUsed ||
              !prompt ||
              context.messages.some((message) => message.role === "assistant")
            ) {
              throw new Error("prototype_requires_fresh_single_turn_session");
            }
            const transport = await options.connect(signal);
            if (generation !== epoch || signal.aborted) {
              transport.close();
              throw new Error("prototype_cancelled");
            }
            turn = new PrototypeTurn(transport, options.mode);
            active = turn;
            stream.push({ type: "start", partial: output });
            stream.push({ type: "text_start", contentIndex: 0, partial: output });
            const current = turn;
            await turn.run({
              prompt,
              signal,
              onCreated: () => options.onCreated?.(current),
              onText(delta) {
                if (generation !== epoch || signal.aborted) return;
                const text = output.content[0];
                if (text?.type === "text") text.text += delta;
                stream.push({ type: "text_delta", contentIndex: 0, delta, partial: output });
              },
              onUsage(usage) {
                const input = Number(usage.input_tokens) || 0;
                const tokens = Number(usage.output_tokens) || 0;
                output.usage.input += input;
                output.usage.output += tokens;
                output.usage.totalTokens += input + tokens;
              },
            });
            if (generation !== epoch || signal.aborted) throw new Error("prototype_cancelled");
            output.stopReason = "stop";
            stream.push({
              type: "text_end",
              contentIndex: 0,
              content: output.content[0]?.type === "text" ? output.content[0].text : "",
              partial: output,
            });
            stream.push({ type: "done", reason: "stop", message: output });
          } catch (error) {
            output.stopReason = signal.aborted ? "aborted" : "error";
            const message = error instanceof Error ? error.message : "";
            output.errorMessage = message.startsWith("prototype_") ? message : "prototype_failed";
            stream.push({ type: "error", reason: output.stopReason, error: output });
          } finally {
            turn?.close();
            if (generation === epoch) {
              active = undefined;
              if (turn) options.onFinished?.(turn);
            }
            stream.end();
          }
        })();
        return stream;
      },
    });
  };
}
