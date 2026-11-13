import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { PiAcpAgent } from "./acp/agent.ts";
import { type BoundaryValue, errorMessage, isNumber } from "./boundary.ts";
import { resolvePiLaunch } from "./pi-rpc/command.ts";

/** Maximum bytes in one inbound ACP NDJSON frame, excluding the newline. */
export const ACP_MAX_INBOUND_FRAME_BYTES = 1_048_576;

type InboundFrameViolation = "frame_too_large" | "malformed_json";

function runInteractivePi(cwd: string): never {
  let launch;
  try {
    launch = resolvePiLaunch(process.env.PI_ACP_PI_COMMAND);
  } catch (failure) {
    // SAFETY: command resolution may throw an arbitrary runtime value; errorMessage handles every value.
    const cause = failure as BoundaryValue;
    process.stderr.write(`choco-pi-acp: ${errorMessage(cause)}\n`);
    process.exit(1);
  }

  const result = spawnSync(launch.command, launch.argsPrefix, {
    cwd,
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env },
    shell: false,
  });
  if (result.error) {
    process.stderr.write("choco-pi-acp: could not start the interactive Pi setup.\n");
  }
  process.exit(isNumber(result.status) ? result.status : 1);
}

// Terminal Auth entrypoint. The ACP client launches the agent with `--terminal-login`.
if (process.argv.includes("--terminal-login")) {
  runInteractivePi(process.cwd());
}

const trustArgIndex = process.argv.indexOf("--terminal-trust");
if (trustArgIndex >= 0) {
  const requestedCwd = process.argv[trustArgIndex + 1];
  if (!requestedCwd || !isAbsolute(requestedCwd)) {
    process.stderr.write(
      "choco-pi-acp: --terminal-trust requires the absolute project path to review.\n",
    );
    process.exit(2);
  }
  const cwd = resolve(requestedCwd);
  try {
    if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
  } catch {
    process.stderr.write(`choco-pi-acp: trust path is not a directory: ${cwd}\n`);
    process.exit(2);
  }
  process.stderr.write(
    `Review the project-local Pi files in ${cwd}. Pi will ask whether to trust them; this adapter does not pass --approve. Exit Pi after completing the one-time choice.\n`,
  );
  runInteractivePi(cwd);
}

function writeStdout(chunk: Uint8Array): Promise<void> {
  return new Promise<void>((resolve) => {
    if (process.stdout.destroyed || !process.stdout.writable) return resolve();

    try {
      process.stdout.write(chunk, (err) => {
        void err;
        resolve();
      });
    } catch {
      // Common: ERR_STREAM_DESTROYED ("Cannot call write after a stream was destroyed").
      resolve();
    }
  });
}

let currentAgent: PiAcpAgent | null = null;
let shutdownStarted = false;
let inboundFrameRejected = false;

async function shutdown(exitCode = 0): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const ownedAgent = currentAgent;
  currentAgent = null;
  try {
    await ownedAgent?.shutdown();
  } catch (failure) {
    // SAFETY: shutdown may reject with an arbitrary runtime value; errorMessage handles every value.
    const cause = failure as BoundaryValue;
    process.stderr.write(`choco-pi-acp: shutdown failed: ${errorMessage(cause)}\n`);
  }
  process.exit(exitCode);
}

async function rejectInboundFrame(
  reason: InboundFrameViolation,
  byteLength: number,
): Promise<void> {
  const response = {
    jsonrpc: "2.0",
    id: null,
    error: {
      code: -32700,
      message: "Parse error",
      data: { reason, byteLength, maxFrameBytes: ACP_MAX_INBOUND_FRAME_BYTES },
    },
  };
  process.stderr.write(
    `choco-pi-acp: closing ACP connection after ${reason} (bytes=${byteLength}, max=${ACP_MAX_INBOUND_FRAME_BYTES}).\n`,
  );
  await writeStdout(new TextEncoder().encode(`${JSON.stringify(response)}\n`));
  await shutdown(1);
}

function boundedAcpInput(): ReadableStream<Uint8Array> {
  let cleanup = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let frameParts: Uint8Array[] = [];
      let frameBytes = 0;
      let stopped = false;

      const fail = (reason: InboundFrameViolation, byteLength: number) => {
        if (stopped) return;
        stopped = true;
        inboundFrameRejected = true;
        cleanup();
        process.stdin.pause();
        controller.error(new Error(`Invalid inbound ACP frame (${reason}, bytes=${byteLength})`));
        void rejectInboundFrame(reason, byteLength);
      };

      const append = (part: Uint8Array): boolean => {
        const nextBytes = frameBytes + part.byteLength;
        if (nextBytes > ACP_MAX_INBOUND_FRAME_BYTES) {
          fail("frame_too_large", nextBytes);
          return false;
        }
        if (part.byteLength > 0) frameParts.push(new Uint8Array(part));
        frameBytes = nextBytes;
        return true;
      };

      const emitFrame = (newline: boolean): boolean => {
        const frame = new Uint8Array(frameBytes);
        let offset = 0;
        for (const part of frameParts) {
          frame.set(part, offset);
          offset += part.byteLength;
        }

        try {
          const text = decoder.decode(frame).trim();
          if (text) JSON.parse(text);
        } catch {
          fail("malformed_json", frameBytes);
          return false;
        }

        const forwarded = new Uint8Array(frameBytes + (newline ? 1 : 0));
        forwarded.set(frame);
        if (newline) forwarded[frameBytes] = 0x0a;
        controller.enqueue(forwarded);
        frameParts = [];
        frameBytes = 0;
        return true;
      };

      const onData = (chunk: Buffer) => {
        if (stopped) return;
        let start = 0;
        for (let index = 0; index < chunk.byteLength; index += 1) {
          if (chunk[index] !== 0x0a) continue;
          if (!append(chunk.subarray(start, index)) || !emitFrame(true)) return;
          start = index + 1;
        }
        append(chunk.subarray(start));
      };
      const onEnd = () => {
        if (stopped) return;
        if (frameBytes > 0 && !emitFrame(false)) return;
        stopped = true;
        cleanup();
        controller.close();
      };
      const onError = (error: Error) => {
        if (stopped) return;
        stopped = true;
        cleanup();
        controller.error(error);
      };
      cleanup = () => {
        process.stdin.off("data", onData);
        process.stdin.off("end", onEnd);
        process.stdin.off("error", onError);
      };

      process.stdin.on("data", onData);
      process.stdin.on("end", onEnd);
      process.stdin.on("error", onError);
    },
    cancel() {
      cleanup();
    },
  });
}

const input = new WritableStream<Uint8Array>({ write: writeStdout });
const output = boundedAcpInput();

const stream = ndJsonStream(input, output);

new AgentSideConnection((conn) => {
  const instance = new PiAcpAgent(conn);
  currentAgent = instance;
  return instance;
}, stream);

process.stdin.on("end", () => {
  if (!inboundFrameRejected) void shutdown();
});
process.stdin.on("close", () => {
  if (!inboundFrameRejected) void shutdown();
});

process.stdin.resume();
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

// Avoid crashing if the client closes stdout early.
process.stdout.on("error", () => {
  void shutdown();
});
