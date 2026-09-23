import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, readlink, realpath, lstat } from "node:fs/promises";
import { homedir, arch } from "node:os";
import { join, resolve } from "node:path";
import { packagePath } from "./isolation.ts";
import { isJsonObject, isString, type JsonValue } from "../src/json.ts";
import { connect } from "node:net";
import { models, piPath, plan, type Tier, type TierBHelper } from "./isolation.ts";

export const gateNames = ["lint", "fmt:check", "typecheck", "test"] as const;
export type GateName = (typeof gateNames)[number];
export interface GateWaiver {
  gate: GateName;
  reason: string;
  baselineStatus: string;
}
export interface PreflightResult {
  models: string[];
  waivers: GateWaiver[];
  baseline?: string;
}

export class GateError extends Error {
  readonly reason: string;
  constructor(reason: string, description = "") {
    super(`${reason}${description ? ` ${description}` : ""}`);
    this.reason = reason;
  }
}
async function baselineGates(
  path: string,
  requested: Map<GateName, string>,
): Promise<GateWaiver[]> {
  let data: JsonValue;
  try {
    data = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new GateError("BASELINE_GATES", `${path}: unavailable or invalid JSON`);
  }
  if (!isJsonObject(data) || !isJsonObject(data.gates))
    throw new GateError("BASELINE_GATES", `${path}: missing gates object`);
  const waivers: GateWaiver[] = [];
  for (const gate of gateNames) {
    const status = data.gates[gate];
    if (status === 0) {
      if (requested.has(gate))
        throw new GateError("BASELINE_GATES", `${gate}: cannot waive a passing gate`);
      continue;
    }
    if (!isString(status) || !/^[1-9]\d*\s+\S/.test(status))
      throw new GateError("BASELINE_GATES", `${gate}: missing or invalid non-zero status`);
    const reason = requested.get(gate);
    if (!reason)
      throw new GateError(
        "BASELINE_GATES",
        `${gate}: ${status}; explicit --waive-gate ${gate}=<reason> required`,
      );
    waivers.push({ gate, reason, baselineStatus: status });
  }
  return waivers;
}
export async function command(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((done, reject) => {
    const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}
export async function socketBusy(socket: string): Promise<boolean> {
  return await new Promise((done) => {
    const client = connect(socket);
    // A connect that neither succeeds nor fails means something holds the path: treat as busy.
    const timer = setTimeout(() => {
      client.destroy();
      done(true);
    }, 1000);
    client.once("connect", () => {
      clearTimeout(timer);
      client.destroy();
      done(true);
    });
    client.once("error", () => {
      clearTimeout(timer);
      client.destroy();
      done(false);
    });
  });
}
export async function preflight(options: {
  root: string;
  tier: Tier;
  executable: string;
  substitutions: Map<string, string>;
  dryRun: boolean;
  baseline?: string;
  requireBaseline: boolean;
  requestedWaivers: Map<GateName, string>;
  /** Tier B: the dev helper app and its running daemon socket (never the main helper). */
  helper?: TierBHelper;
}): Promise<PreflightResult> {
  const {
    root,
    tier,
    executable,
    substitutions,
    dryRun,
    baseline,
    requireBaseline,
    requestedWaivers,
    helper,
  } = options;
  if (resolve(executable) !== piPath)
    throw new GateError(
      "PI_VERSION_MISMATCH",
      `${executable} is not the pinned Pi 0.87.1 launcher`,
    );
  if (!baseline && (requireBaseline || requestedWaivers.size > 0))
    throw new GateError("BASELINE_GATES", "provide --baseline with root gate evidence");
  const waivers = baseline ? await baselineGates(baseline, requestedWaivers) : [];
  if (!dryRun) {
    const isolatedEnv = plan(root, tier, models[0], "S1", "", "", executable, helper).env;
    let version;
    try {
      version = await command(executable, ["--version"], isolatedEnv);
    } catch {
      throw new GateError("PI_VERSION_MISMATCH", "pinned launcher unavailable");
    }
    if (version.code !== 0 || version.stdout.trim() !== "0.87.1")
      throw new GateError("PI_VERSION_MISMATCH", version.stdout.trim());
    const listing = await command(executable, ["--list-models"], isolatedEnv);
    if (listing.code !== 0) throw new GateError("MODEL_LIST_FAILED", listing.stderr.trim());
    for (const model of models) {
      const chosen = substitutions.get(model) ?? model;
      const [provider, id] = chosen.split("/");
      if (
        !provider ||
        !id ||
        !listing.stdout
          .split("\n")
          .some((row) => row.trim().split(/\s+/).slice(0, 2).join(" ") === `${provider} ${id}`)
      )
        throw new GateError(
          "MODEL_UNAVAILABLE",
          `${chosen}; run ${piPath} update --models; explicit fallback: --substitute ${model}=openai-codex/gpt-6-astra or gpt-5.6-sol`,
        );
    }
  }
  try {
    for (const name of ["auth.json", "models.json"]) {
      const link = join(root, "agent", name);
      const target = join(homedir(), ".pi/agent", name);
      const stat = await lstat(link);
      if (!stat.isSymbolicLink() || (await readlink(link)) !== target)
        throw new Error(`${name} is not the expected symlink`);
      if (name === "auth.json") await access(target);
    }
  } catch {
    throw new GateError("ISOLATION_DIR", "agent auth/models symlink or auth target missing");
  }
  if (await socketBusy(join(root, tier, "bridge.sock")))
    throw new GateError("SOCKET_BUSY", join(root, tier, "bridge.sock"));
  if (tier === "a" && !dryRun) {
    const fake = join(packagePath, "tests/helpers/fake-helper-daemon.ts");
    try {
      await access(fake);
    } catch {
      throw new GateError("FAKE_DAEMON_MISSING", fake);
    }
  }
  if (tier === "b") {
    if (arch() !== "arm64") throw new GateError("ARCH_UNSUPPORTED", arch());
    if (!helper)
      throw new GateError("ARGUMENT", "tier b requires --helper-app and --helper-socket");
    const mainApp = join(homedir(), "Applications/pi-computer-use.app");
    const mainSocket = join(homedir(), "Library/Caches/pi-computer-use/bridge.sock");
    if (resolve(helper.app) === mainApp || resolve(helper.socket) === mainSocket)
      throw new GateError("HELPER_IS_MAIN", "tier b must not use the main helper app or socket");
    if (!dryRun) {
      const app = helper.app;
      const signed = await command("codesign", ["--verify", "--strict", app]);
      if (signed.code !== 0) throw new GateError("HELPER_SIGNATURE", signed.stderr);
      const prebuilt = await readFile(join(packagePath, "prebuilt/macos/arm64/bridge"));
      const source = (await readFile(join(app, "Contents/Resources/source.sha256"), "utf8")).trim();
      if (source !== createHash("sha256").update(prebuilt).digest("hex"))
        throw new GateError("HELPER_PROVENANCE", "source hash mismatch");
      await realpath(join(app, "Contents/MacOS/bridge"));
      if (!(await socketBusy(helper.socket)))
        throw new GateError("HELPER_SOCKET", `no dev helper daemon at ${helper.socket}`);
    }
  }
  return { models: models.map((model) => substitutions.get(model) ?? model), waivers, baseline };
}
