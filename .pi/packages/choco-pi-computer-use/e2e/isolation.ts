import { randomUUID } from "node:crypto";
import { mkdir, lstat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScenarioId } from "./scenarios/index.ts";

export const project = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
export const packagePath = resolve(fileURLToPath(new URL("../", import.meta.url)));
export const piPath = "/Users/Nebuleto/.local/pi-0.87.1/node_modules/.bin/pi";
export const tools =
  "find_roots,observe_ui,search_ui,expand_ui,inspect_ui,act_ui,read_text,wait_for";
export const models = ["anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol"] as const;
export type Tier = "a" | "b";
export type Plan = {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  events: string;
  stderr: string;
  sessionId: string;
  requests: string;
  daemonLog: string;
  /** Socket Pi uses: the tier-A fake daemon, or the tier-B logging proxy. */
  socket: string;
  /** Tier B: the real dev helper daemon socket the proxy forwards to. */
  upstream?: string;
  helperApp: string;
  /**
   * Tier B: this attempt's fixture log directory (also holds .cu-quit and .cu-resize), unique per
   * attempt and session so a retry never inherits a stale .cu-quit or earlier launch rows.
   */
  fixtureDir: string;
};
/** Tier B: an independently installed dev helper app and the socket its daemon serves. */
export interface TierBHelper {
  app: string;
  socket: string;
}
export const scratchRoot = (): string =>
  join(
    "/tmp/choco-pi",
    process.env.PI_SESSION_ID?.replaceAll(/[^a-zA-Z0-9_-]/g, "_") ||
      new Date().toISOString().replaceAll(/[^a-zA-Z0-9_-]/g, "_"),
    "e2e",
  );
export const slug = (model: string): string => model.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
export function plan(
  root: string,
  tier: Tier,
  model: string,
  scenario: ScenarioId,
  prompt: string,
  system: string,
  executable = piPath,
  helper?: TierBHelper,
  attempt = 0,
): Plan {
  const modelDir = join(root, tier, slug(model));
  const sessionId = randomUUID();
  const socket = join(root, tier, "bridge.sock");
  const helperApp = tier === "b" && helper ? helper.app : join(root, tier, "pi-computer-use.app");
  const env: NodeJS.ProcessEnv = {
    HOME: homedir(),
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    USER: process.env.USER,
    PI_CODING_AGENT_DIR: join(root, "agent"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_CU_SOCKET_PATH: socket,
    PI_COMPUTER_USE_HELPER_APP_PATH: helperApp,
    PI_COMPUTER_USE_BROWSER_USE: "0",
    PI_COMPUTER_USE_CURSOR_OVERLAY: "0",
    PI_COMPUTER_USE_HEADLESS: "0",
  };
  for (const key of [
    "PI_COMPUTER_USE_DELIVERY_POLICY",
    "PI_COMPUTER_USE_EVENT_DELIVERY",
    "PI_COMPUTER_USE_FOREGROUND_GRANT",
  ] as const)
    delete env[key];
  if (scenario === "S6") env.PI_COMPUTER_USE_FOREGROUND_GRANT = "com.choco-pi.FocusFixture";
  return {
    executable,
    cwd: project,
    env,
    socket,
    upstream: tier === "b" ? helper?.socket : undefined,
    helperApp,
    fixtureDir: join(modelDir, `${scenario}.attempt-${attempt}.${sessionId}.fixture`),
    sessionId,
    args: [
      "--mode",
      "json",
      "--model",
      model,
      "--thinking",
      "medium",
      "--no-approve",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--tools",
      tools,
      "--session-dir",
      join(root, "sessions"),
      "--session-id",
      sessionId,
      "--name",
      `cu-e2e-${scenario}-${slug(model)}`,
      "--system-prompt",
      system,
      "--",
      prompt,
    ],
    events: join(modelDir, `${scenario}.events.jsonl`),
    stderr: join(modelDir, `${scenario}.stderr`),
    requests: join(modelDir, `${scenario}.requests.jsonl`),
    daemonLog: join(modelDir, `${scenario}.daemon.log`),
  };
}
export async function setup(root: string, tier: Tier): Promise<void> {
  for (const dir of [root, join(root, "agent"), join(root, "sessions"), join(root, tier)])
    await mkdir(dir, { recursive: true });
  const agent = join(root, "agent");
  for (const name of ["auth.json", "models.json"]) {
    const target = join(homedir(), ".pi", "agent", name);
    const link = join(agent, name);
    try {
      await lstat(link);
    } catch {
      await symlink(target, link);
    }
  }
  await writeFile(
    join(agent, "settings.json"),
    `${JSON.stringify({ packages: [packagePath], defaultProjectTrust: "never", compaction: { enabled: false } }, null, 2)}\n`,
    { flag: "w" },
  );
}
export function printable(p: Plan): string {
  return `cwd=${p.cwd}\nenv=${JSON.stringify(p.env, Object.keys(p.env).sort())}\nPI_COMPUTER_USE_DELIVERY_POLICY=<unset>\nPI_COMPUTER_USE_EVENT_DELIVERY=<unset>\nPI_COMPUTER_USE_FOREGROUND_GRANT=${p.env.PI_COMPUTER_USE_FOREGROUND_GRANT ?? "<unset>"}\n${JSON.stringify([p.executable, ...p.args])}\nstdout=${p.events}\nstderr=${p.stderr}\nrequests=${p.requests}\ndaemonLog=${p.daemonLog}\n${p.upstream ? `upstream=${p.upstream}\nhelperApp=${p.helperApp}\nfixtureDir=${p.fixtureDir}\n` : ""}auth.json -> ${join(homedir(), ".pi/agent/auth.json")} (symlink; not read)\nmodels.json -> ${join(homedir(), ".pi/agent/models.json")} (symlink; not read)`;
}
