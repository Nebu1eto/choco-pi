import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAcpAgent } from "../src/acp/agent.ts";
import { type BoundaryRecord, isBoundaryRecord, parseJsonLine } from "../src/boundary.ts";
import { FakeAgentSideConnection, asAgentConn } from "./helpers-fakes.ts";

export type RpcHarness = {
  agent: PiAcpAgent;
  client: FakeAgentSideConnection;
  cwd: string;
  readRecords(): BoundaryRecord[];
};

/** Where the stub `pi` executable and its recorded NDJSON transcript live. */
type FakePiExecutable = {
  executable: string;
  recordsPath: string;
};

/** Decode the stub executable's NDJSON transcript; a missing file reads as no records. */
function readRecordedFrames(recordsPath: string): BoundaryRecord[] {
  let contents: string;
  try {
    contents = readFileSync(recordsPath, "utf8");
  } catch {
    return [];
  }

  const records: BoundaryRecord[] = [];
  for (const line of contents.trim().split("\n")) {
    if (!line) continue;
    const frame = parseJsonLine(line);
    if (isBoundaryRecord(frame)) records.push(frame);
  }
  return records;
}

function createFakePiExecutable(root: string): FakePiExecutable {
  const executable = join(root, "fake pi rpc");
  const recordsPath = join(root, "records.jsonl");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const recordsPath = ${JSON.stringify(recordsPath)};
const record = (value) => fs.appendFileSync(recordsPath, JSON.stringify(value) + "\\n");
record({ type: "spawn", cwd: process.cwd(), argv: process.argv.slice(2), marker: process.env.PI_ACP_HARNESS_MARKER ?? null });
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  record({ type: "request", command: request.type });
  let data = {};
  if (request.type === "get_state") data = { sessionId: "fake-session", thinkingLevel: "medium", model: { provider: "test", id: "model" } };
  if (request.type === "get_available_models") data = { models: [{ provider: "test", id: "model", name: "Model" }] };
  if (request.type === "get_commands") data = { commands: [{ name: "context", description: "Show context", source: "extension" }] };
  process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data }) + "\\n");
});
process.on("SIGTERM", () => { record({ type: "signal", signal: "SIGTERM" }); process.exit(0); });
`;
  writeFileSync(executable, source, { mode: 0o755 });
  chmodSync(executable, 0o755);
  return { executable, recordsPath };
}

export function createFakeAcpToPiHarness(cwd: string): RpcHarness {
  const root = mkdtempSync(join(tmpdir(), "choco-pi-acp-harness-"));
  const { executable, recordsPath } = createFakePiExecutable(root);
  const client = new FakeAgentSideConnection();
  return {
    agent: new PiAcpAgent(asAgentConn(client), { piCommand: executable }),
    client,
    cwd,
    readRecords: () => readRecordedFrames(recordsPath),
  };
}

/** Real-Pi variant for later opt-in integration tests; constructing it does not spawn Pi. */
export function createRealPiRpcHarness(cwd: string): RpcHarness {
  const client = new FakeAgentSideConnection();
  return {
    agent: new PiAcpAgent(asAgentConn(client)),
    client,
    cwd,
    readRecords: () => [],
  };
}
