import test from "node:test";
import assert from "node:assert/strict";
import type { AvailableCommand, PromptResponse } from "@agentclientprotocol/sdk";
import { PiAcpAgent } from "../src/acp/agent.ts";
import { buildCommandCatalog, parseSlashInvocation } from "../src/acp/pi-commands.ts";
import { isBoundaryRecord } from "../src/boundary.ts";
import type { PiCommands, PiPromptImage } from "../src/pi-rpc/protocol.ts";
import type { PiRpcProcessLike } from "../src/pi-rpc/process.ts";
import { FakeAgentSideConnection, asAgentConn } from "./helpers-fakes.ts";

const cwd = process.cwd();

type CommandData = PiCommands;
type SessionPromptResult = PromptResponse["stopReason"];

interface CommandSession {
  sessionId: string;
  cwd: string;
  proc: PiRpcProcessLike;
  prompts: Array<{ message: string; images: PiPromptImage[] }>;
  prompt(message: string, images: PiPromptImage[]): Promise<SessionPromptResult>;
  activate?(): void;
  markIdle?(): void;
  wasCancelRequested?(): boolean;
  cancel?(): Promise<void>;
  setStartupInfo?(text: string): void;
  sendStartupInfoIfPending?(): Promise<void>;
}

interface AgentSessionsState {
  sessions: CommandSessions;
}

class CommandProcess implements PiRpcProcessLike {
  commandData: CommandData;
  readonly prompts: Array<{ message: string; attachments: PiPromptImage[] }> = [];
  getCommandsImpl?: () => Promise<CommandData>;
  promptImpl?: (message: string, attachments: PiPromptImage[]) => Promise<void>;

  constructor(commandData: CommandData) {
    this.commandData = commandData;
  }

  onEvent(_handler: Parameters<PiRpcProcessLike["onEvent"]>[0]): () => void {
    return () => {};
  }

  async getCommands(): Promise<CommandData> {
    return this.getCommandsImpl ? this.getCommandsImpl() : this.commandData;
  }

  async prompt(message: string, attachments: PiPromptImage[]): Promise<void> {
    this.prompts.push({ message, attachments });
    await this.promptImpl?.(message, attachments);
  }
}

class CommandSessions {
  private readonly sessions = new Map<string, CommandSession>();

  set(session: CommandSession): void {
    this.sessions.set(session.sessionId, session);
  }

  maybeGet(sessionId: string): CommandSession | undefined {
    return this.sessions.get(sessionId);
  }

  async create(): Promise<CommandSession> {
    throw new Error("CommandSessions.create is not used by this test");
  }

  get(sessionId: string): CommandSession {
    const session = this.maybeGet(sessionId);
    if (!session) throw new Error(`Unknown command session: ${sessionId}`);
    return session;
  }

  getOrCreate(sessionId: string): CommandSession {
    return this.get(sessionId);
  }

  close(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  disposeAll(): void {
    this.sessions.clear();
  }

  async shutdownAll(): Promise<void> {
    this.disposeAll();
  }

  retainRecent(_sessionId: string, _maxLive: number): void {}
}

function commandSession(
  sessionId: string,
  proc: CommandProcess,
  promptImpl: (
    message: string,
    images: PiPromptImage[],
  ) => Promise<SessionPromptResult> = async () => "end_turn",
): CommandSession {
  const prompts: Array<{ message: string; images: PiPromptImage[] }> = [];
  return {
    sessionId,
    cwd,
    proc,
    prompts,
    prompt: async (message: string, images: PiPromptImage[]) => {
      prompts.push({ message, images });
      return promptImpl(message, images);
    },
  };
}

function deferred<T>(): PromiseWithResolvers<T> {
  return Promise.withResolvers<T>();
}

function latestAvailableCommands(conn: FakeAgentSideConnection): AvailableCommand[] {
  const update = conn.updates.at(-1)?.update;
  return update?.sessionUpdate === "available_commands_update" ? update.availableCommands : [];
}

function lastPromptMessage(session: CommandSession): string | undefined {
  return session.prompts.at(-1)?.message;
}

test("command discovery classifies sources and canonically merges collisions", () => {
  const builtins = [
    { name: "same", description: "adapter same" },
    { name: "local", description: "adapter local" },
  ] satisfies AvailableCommand[];
  const data = {
    data: {
      commands: [
        { name: "/same", description: "prompt same", source: "prompt" },
        {
          name: "ext",
          description: "extension command",
          source: "extension",
          sourceInfo: { location: "project", path: "/extension.ts" },
        },
        { name: "skill:check", description: "skill command", source: "skill" },
        { name: "prompt", description: "prompt command", source: "prompt" },
        { name: "same", description: "extension same", source: "extension" },
        { name: "bad/name", description: "invalid", source: "extension" },
        { name: "ignored", description: "unknown source", source: "other" },
      ],
    },
  };

  const snapshot = buildCommandCatalog(data, builtins);
  assert.deepEqual(
    snapshot.entries.map(({ name, source }) => ({ name, source })),
    [
      { name: "same", source: "extension" },
      { name: "ext", source: "extension" },
      { name: "skill:check", source: "skill" },
      { name: "prompt", source: "prompt" },
      { name: "local", source: "builtin" },
    ],
  );
  const metadata = snapshot.availableCommands[1]?._meta;
  assert.ok(isBoundaryRecord(metadata));
  assert.ok(isBoundaryRecord(metadata.piAcp));
  assert.deepEqual(metadata.piAcp.command, {
    source: "extension",
    location: "project",
    path: "/extension.ts",
  });

  const withoutSkills = buildCommandCatalog(data, builtins, {
    enableSkillCommands: false,
  });
  assert.equal(
    withoutSkills.entries.some((entry) => entry.source === "skill"),
    false,
  );
  assert.deepEqual(parseSlashInvocation("/prompt exact args  "), {
    name: "prompt",
    text: "/prompt exact args  ",
  });
});

test("agent separates immediate extension commands from prompt and skill session turns", async () => {
  const conn = new FakeAgentSideConnection();
  const sessions = new CommandSessions();
  const proc = new CommandProcess({
    commands: [
      { name: "extension", description: "extension", source: "extension" },
      { name: "prompt", description: "prompt", source: "prompt" },
      { name: "skill:test", description: "skill", source: "skill" },
      { name: "review", description: "review", source: "extension" },
      { name: "reviewing", description: "not review", source: "extension" },
    ],
  });
  const promptCompletion = deferred<SessionPromptResult>();
  const skillCompletion = deferred<SessionPromptResult>();
  const sessionCompletions = [promptCompletion.promise, skillCompletion.promise];
  const session = commandSession("s1", proc, async () => {
    const completion = sessionCompletions.shift();
    return completion ?? "end_turn";
  });
  sessions.set(session);

  const agent = new PiAcpAgent(asAgentConn(conn));
  // The injected manager implements the session operations exercised by command dispatch.
  Object.assign(agent, { sessions } satisfies AgentSessionsState);
  await agent.refreshAvailableCommands("s1");

  const advertised = latestAvailableCommands(conn);
  assert.equal(conn.updates.at(-1)?.update.sessionUpdate, "available_commands_update");
  assert.deepEqual(
    advertised
      .filter((command: AvailableCommand) =>
        ["extension", "prompt", "skill:test", "review"].includes(command.name),
      )
      .map((command: AvailableCommand) => command.name),
    ["extension", "prompt", "skill:test", "review"],
  );

  const extensionResult = await agent.prompt({
    sessionId: "s1",
    prompt: [{ type: "text", text: "/extension one  " }],
  });
  assert.equal(extensionResult.stopReason, "end_turn");
  assert.deepEqual(proc.prompts, [{ message: "/extension one  ", attachments: [] }]);
  assert.deepEqual(session.prompts, []);

  let promptSettled = false;
  const promptResultPromise = agent
    .prompt({
      sessionId: "s1",
      prompt: [{ type: "text", text: "/prompt two  " }],
    })
    .finally(() => {
      promptSettled = true;
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(promptSettled, false);
  assert.deepEqual(session.prompts, [{ message: "/prompt two  ", images: [] }]);
  promptCompletion.resolve("max_tokens");
  assert.equal((await promptResultPromise).stopReason, "max_tokens");

  let skillSettled = false;
  const skillResultPromise = agent
    .prompt({
      sessionId: "s1",
      prompt: [{ type: "text", text: "/skill:test three" }],
    })
    .finally(() => {
      skillSettled = true;
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(skillSettled, false);
  assert.deepEqual(session.prompts.at(-1), {
    message: "/skill:test three",
    images: [],
  });
  skillCompletion.resolve("end_turn");
  assert.equal((await skillResultPromise).stopReason, "end_turn");

  const reviewingResult = await agent.prompt({
    sessionId: "s1",
    prompt: [{ type: "text", text: "/reviewing" }],
  });
  assert.equal(reviewingResult.stopReason, "end_turn");
  assert.deepEqual(
    proc.prompts.map((prompt) => prompt.message),
    ["/extension one  ", "/reviewing"],
  );
  assert.deepEqual(
    proc.prompts.map((prompt) => prompt.attachments),
    [[], []],
  );

  // The adapter no longer intercepts `/review`. It dispatches to Pi like any
  // other extension command, where the headless presenter answers with bounded
  // display-only output. `/reviewing` above still proves the prefix collision
  // is not matched by this path.
  const reviewResult = await agent.prompt({
    sessionId: "s1",
    prompt: [{ type: "text", text: "/review branch main" }],
  });
  assert.equal(reviewResult.stopReason, "end_turn");
  assert.deepEqual(
    proc.prompts.map((prompt) => prompt.message),
    ["/extension one  ", "/reviewing", "/review branch main"],
  );
  await assert.rejects(
    agent.prompt({
      sessionId: "s1",
      prompt: [{ type: "text", text: "/unknown" }],
    }),
    /Unknown or unavailable slash command: \/unknown/,
  );

  proc.promptImpl = async (message) => {
    if (message === "/extension") {
      proc.commandData = {
        commands: [{ name: "replacement", description: "replacement", source: "prompt" }],
      };
    }
  };
  const refreshResult = await agent.prompt({
    sessionId: "s1",
    prompt: [{ type: "text", text: "/extension" }],
  });
  assert.equal(refreshResult.stopReason, "end_turn");
  const refreshed = latestAvailableCommands(conn);
  assert.deepEqual(
    refreshed.map((command) => command.name),
    [
      "replacement",
      "compact",
      "autocompact",
      "export",
      "session",
      "name",
      "steering",
      "follow-up",
      "changelog",
    ],
  );
  await assert.rejects(
    agent.prompt({
      sessionId: "s1",
      prompt: [{ type: "text", text: "/extension" }],
    }),
    /Unknown or unavailable slash command: \/extension/,
  );
  const replacement = await agent.prompt({
    sessionId: "s1",
    prompt: [{ type: "text", text: "/replacement" }],
  });
  assert.equal(replacement.stopReason, "end_turn");
  assert.equal(lastPromptMessage(session), "/replacement");
});

test("session replacement cannot retain or publish the previous process catalog", async () => {
  const conn = new FakeAgentSideConnection();
  const sessions = new CommandSessions();
  const oldProc = new CommandProcess({
    commands: [{ name: "old", description: "old", source: "extension" }],
  });
  sessions.set(commandSession("shared", oldProc));

  const agent = new PiAcpAgent(asAgentConn(conn));
  // The injected manager implements the session operations exercised by catalog replacement.
  Object.assign(agent, { sessions } satisfies AgentSessionsState);
  await agent.refreshAvailableCommands("shared");

  const commandResult = Promise.withResolvers<CommandData>();
  oldProc.getCommandsImpl = () => commandResult.promise;
  const staleRefresh = agent.refreshAvailableCommands("shared");
  await Promise.resolve();

  const newProc = new CommandProcess({
    commands: [{ name: "new", description: "new", source: "prompt" }],
  });
  const newSession = commandSession("shared", newProc);
  sessions.set(newSession);
  commandResult.resolve({
    commands: [{ name: "stale", description: "stale", source: "extension" }],
  });
  await assert.rejects(staleRefresh, /session was replaced while refreshing commands/);

  await assert.rejects(
    agent.prompt({
      sessionId: "shared",
      prompt: [{ type: "text", text: "/old" }],
    }),
    /Unknown or unavailable slash command: \/old/,
  );
  const result = await agent.prompt({
    sessionId: "shared",
    prompt: [{ type: "text", text: "/new" }],
  });
  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(newSession.prompts, [{ message: "/new", images: [] }]);
  assert.equal(newProc.prompts.length, 0);
  assert.equal(oldProc.prompts.length, 0);
});
