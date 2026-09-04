import test from "node:test";
import assert from "node:assert/strict";
import { PiAcpAgent, type SessionManagerLike } from "../src/acp/agent.ts";
import { SessionManager } from "../src/acp/session.ts";
import { errorMessage, type BoundaryValue } from "../src/boundary.ts";
import type {
  PiCommandInfo,
  PiCommands,
  PiExtensionUiResponse,
  PiPromptImage,
  PiRpcEvent,
} from "../src/pi-rpc/protocol.ts";
import type { PiRpcProcessLike } from "../src/pi-rpc/process.ts";
import { createRealPiRpcHarness, type RpcHarness } from "./component-rpc-harness.ts";
import { FakeAgentSideConnection, asAgentConn } from "./helpers-fakes.ts";

type ExpectedBehavior = "executes" | "fallback";
type PromptResult = Awaited<ReturnType<PiAcpAgent["prompt"]>>;
type CommandInfo = PiCommandInfo;

const COMMAND_MATRIX: ReadonlyArray<{ command: string; expected: ExpectedBehavior }> = [
  { command: "/status", expected: "executes" },
  { command: "/context", expected: "executes" },
  { command: "/goal", expected: "executes" },
  { command: "/sessions", expected: "executes" },
  { command: "/hooks", expected: "executes" },
  { command: "/review", expected: "executes" },
  { command: "/preferences", expected: "fallback" },
  { command: "/agents", expected: "fallback" },
  { command: "/btw", expected: "fallback" },
  { command: "/skill:check", expected: "executes" },
  { command: "/check", expected: "executes" },
];

type Settled<T> =
  | { kind: "resolved"; value: T }
  | { kind: "rejected"; error: BoundaryValue }
  | { kind: "deadline" };

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<Settled<T>> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "deadline" }), timeoutMs);
  });
  const settled = promise.then<Settled<T>, Settled<T>>(
    (value) => ({ kind: "resolved", value }),
    (error: BoundaryValue) => ({ kind: "rejected", error }),
  );
  const outcome = await Promise.race([settled, deadline]);
  if (timer) clearTimeout(timer);
  return outcome;
}

function commandName(message: string): string {
  return message.slice(1).split(/[\t ]/, 1)[0] ?? "";
}

class MatrixPiProcess implements PiRpcProcessLike {
  readonly prompts: Array<{ message: string; attachments: PiPromptImage[] }> = [];
  readonly extensionUiResponses: PiExtensionUiResponse[] = [];
  private handlers: Array<(event: PiRpcEvent) => void> = [];
  private nextUiId = 0;

  readonly commands: CommandInfo[] = COMMAND_MATRIX.map(({ command }) => {
    const name = command.slice(1);
    const source = name === "check" ? "prompt" : name.startsWith("skill:") ? "skill" : "extension";
    return { name, description: `Parity fixture for ${command}`, source };
  });

  onEvent(handler: (event: PiRpcEvent) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((candidate) => candidate !== handler);
    };
  }

  emit(event: PiRpcEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  async getCommands(): Promise<PiCommands> {
    return { commands: this.commands };
  }

  async prompt(message: string, attachments: PiPromptImage[]): Promise<void> {
    this.prompts.push({ message, attachments });
    const name = commandName(message);
    const id = `matrix-ui-${this.nextUiId++}`;

    if (name === "preferences") {
      this.emit({
        type: "extension_ui_request",
        id,
        method: "notify",
        message:
          "Agent language: match user\nRun /preferences in the interactive TUI to change preferences.",
      });
    } else if (name === "agents" || name === "btw") {
      this.emit({
        type: "extension_ui_request",
        id,
        method: "custom",
        title: `${name} interactive view`,
      });
    } else {
      this.emit({
        type: "extension_ui_request",
        id,
        method: "notify",
        message: `${message} completed through RPC`,
      });
    }

    queueMicrotask(() => this.emit({ type: "agent_settled" }));
  }

  async sendExtensionUiResponse(response: PiExtensionUiResponse): Promise<void> {
    this.extensionUiResponses.push(response);
  }

  async abort(): Promise<void> {}

  dispose(): void {}
}

function messageTexts(client: FakeAgentSideConnection, fromIndex: number): string[] {
  return client.updates.slice(fromIndex).flatMap((entry) => {
    const update = entry.update;
    return update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
      ? [update.content.text]
      : [];
  });
}

test(
  "Phase 4 command parity matrix settles and reports degraded behavior",
  { timeout: 10_000 },
  async () => {
    const client = new FakeAgentSideConnection();
    const proc = new MatrixPiProcess();
    const sessions = new SessionManager();
    sessions.getOrCreate("phase4-parity", {
      cwd: process.cwd(),
      mcpServers: [],
      proc,
      conn: asAgentConn(client),
    });
    const agent = new PiAcpAgent(asAgentConn(client));
    // The real SessionManager binds this fixture's prebuilt session to the agent.
    Object.assign(agent, { sessions } satisfies { sessions: SessionManagerLike });
    await agent.refreshAvailableCommands("phase4-parity");

    try {
      for (const { command, expected } of COMMAND_MATRIX) {
        const updateIndex = client.updates.length;
        const promptCount = proc.prompts.length;
        const outcome = await settleWithin(
          agent.prompt({
            sessionId: "phase4-parity",
            prompt: [{ type: "text", text: command }],
          }),
          750,
        );

        assert.notEqual(outcome.kind, "deadline", `${command} did not settle within 750ms`);
        if (outcome.kind === "deadline") continue;

        assert.equal(
          outcome.kind,
          "resolved",
          `${command} should settle successfully${
            outcome.kind === "rejected" ? `: ${errorMessage(outcome.error)}` : ""
          }`,
        );
        if (outcome.kind !== "resolved") continue;
        assert.equal(
          proc.prompts.length,
          promptCount + 1,
          `${command} must be dispatched to Pi exactly once instead of being answered by an adapter-side gate`,
        );
        assert.deepEqual(outcome.value, { stopReason: "end_turn" });
        await new Promise<void>((resolve) => setImmediate(resolve));

        if (expected === "fallback") {
          const visibleText = messageTexts(client, updateIndex).join("\n");
          if (command === "/preferences") {
            assert.match(
              visibleText,
              /Run \/preferences in the interactive TUI to change preferences/,
            );
          } else {
            assert.match(visibleText, /custom UI request is not supported/);
            assert.match(visibleText, /Open a Terminal Thread/);
          }
        } else {
          const visibleText = messageTexts(client, updateIndex).join("\n");
          assert.match(visibleText, new RegExp(`${command} completed through RPC`));
          assert.doesNotMatch(visibleText, /custom UI request is not supported/);
          assert.doesNotMatch(visibleText, /Open a Terminal Thread/);
        }
      }
    } finally {
      sessions.close("phase4-parity");
    }
  },
);

// component-rpc-lifecycle.test.ts owns command discovery and source-routing assertions.
// This opt-in case adds only a bounded no-hang check against a real Pi subprocess.
test(
  "Phase 4 representative commands settle through real Pi",
  { skip: process.env.PI_ACP_REAL_PI !== "1", timeout: 45_000 },
  async () => {
    const harness: RpcHarness = createRealPiRpcHarness(process.cwd());
    try {
      const created = await settleWithin(
        harness.agent.newSession({ cwd: harness.cwd, mcpServers: [] }),
        10_000,
      );
      assert.notEqual(created.kind, "deadline", "real Pi session creation did not settle");
      assert.equal(created.kind, "resolved");
      if (created.kind !== "resolved") return;

      for (const command of ["/status", "/preferences", "/agents", "/btw", "/review"]) {
        const outcome: Settled<PromptResult> = await settleWithin(
          harness.agent.prompt({
            sessionId: created.value.sessionId,
            prompt: [{ type: "text", text: command }],
          }),
          5_000,
        );
        assert.notEqual(outcome.kind, "deadline", `${command} hung against real Pi`);
        if (command === "/review") {
          assert.equal(
            outcome.kind,
            "resolved",
            `/review must resolve through real Pi${
              outcome.kind === "rejected" ? `: ${errorMessage(outcome.error)}` : ""
            }`,
          );
          if (outcome.kind === "resolved") {
            assert.ok(outcome.value.stopReason, "/review resolved without a stop reason");
          }
          continue;
        }
        if (outcome.kind === "rejected") {
          assert.ok(
            errorMessage(outcome.error).trim(),
            `${command} rejected without an explanation`,
          );
        } else if (outcome.kind === "resolved") {
          assert.ok(outcome.value.stopReason, `${command} resolved without a stop reason`);
        }
      }
    } finally {
      const shutdown = await settleWithin(harness.agent.shutdown(1_000), 2_000);
      assert.notEqual(shutdown.kind, "deadline", "real Pi shutdown did not settle");
    }
  },
);
