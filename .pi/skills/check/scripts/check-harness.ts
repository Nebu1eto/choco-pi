#!/usr/bin/env node
import {
  isNumber,
  isObject,
  isString,
  type RuntimeValue,
} from "../../../extensions/lib/runtime-values.ts";

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type Capability = "tui" | "subagents" | "resources" | "lsp";
type CheckStatus = "pass" | "warn" | "fail";

type Check = { id: string; status: CheckStatus; detail: string };
type RunResult = { status: number; stdout: string; stderr: string };
type Settings = { packages?: unknown; tuiMode?: unknown };
type SubagentsSettings = { disableDefaultAgents?: unknown; fallbackSubagent?: unknown };

export type HarnessOptions = {
  configRoot?: string;
  mode: "full" | "automatic";
  requiredCapabilities?: readonly Capability[];
  nodeVersion?: string;
  readText?: (target: string) => Promise<string>;
  pathExists?: (target: string) => Promise<boolean>;
  runCommand?: (command: string, args: string[]) => Promise<RunResult>;
};

export type HarnessReport = {
  status: CheckStatus;
  configRoot: string;
  mode: "full" | "automatic";
  requiredCapabilities: Capability[] | "all";
  checks: Check[];
};

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultConfigRoot = path.resolve(scriptDir, "../../..");
const capabilities = ["tui", "subagents", "resources", "lsp"] as const;
const capabilityNames = new Set<string>(capabilities);

function capabilityForCheck(id: string): Capability | undefined {
  if (id === "tui-mode") return "tui";
  if (id === "subagents") return "subagents";
  if (id === "resources") return "resources";
  if (id === "choco-pi-lsp") return "lsp";
  return undefined;
}

function isCapability(value: string): value is Capability {
  return capabilityNames.has(value);
}

function isRecord(value: RuntimeValue): value is Record<string, RuntimeValue> {
  return isObject(value) && value !== null && !Array.isArray(value);
}

async function defaultExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function defaultRun(command: string, args: string[]): Promise<RunResult> {
  try {
    const result = await execFileAsync(command, args, { encoding: "utf8", timeout: 10_000 });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    const value = isRecord(error) ? error : {};
    return {
      status: isNumber(value.code) ? value.code : 1,
      stdout: isString(value.stdout) ? value.stdout : "",
      stderr: isString(value.stderr) ? value.stderr : "",
    };
  }
}

function numericVersion(value: string): number[] {
  return value
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

function atLeast(actual: string, expected: string): boolean {
  const left = numericVersion(actual);
  const right = numericVersion(expected);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) > (right[index] || 0);
  }
  return true;
}

function hasPiEntryPoint(manifest: Record<string, RuntimeValue>): boolean {
  if (!isRecord(manifest.pi)) return false;
  return Object.values(manifest.pi).some(
    (value) => Array.isArray(value) && value.some((entry) => isString(entry) && entry.length > 0),
  );
}

export function parseCliArgs(
  args: readonly string[],
): Pick<HarnessOptions, "mode" | "requiredCapabilities"> {
  if (args.length === 0) return { mode: "full" };
  if (args[0] !== "--automatic") throw new Error(`unknown argument: ${args[0]}`);

  const required: Capability[] = [];
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] !== "--require") throw new Error(`unknown argument: ${args[index]}`);
    const value = args[index + 1];
    if (!value) throw new Error("--require needs a capability");
    if (!isCapability(value)) {
      throw new Error(`unknown capability: ${value}; expected one of ${capabilities.join(", ")}`);
    }
    if (!required.includes(value)) required.push(value);
    index += 1;
  }
  return { mode: "automatic", requiredCapabilities: required };
}

export async function checkHarness(options: HarnessOptions): Promise<HarnessReport> {
  const configRoot = options.configRoot ?? defaultConfigRoot;
  const readText = options.readText ?? ((target: string) => readFile(target, "utf8"));
  const exists = options.pathExists ?? defaultExists;
  const run = options.runCommand ?? defaultRun;
  const required = new Set(options.requiredCapabilities ?? []);
  const checks: Check[] = [];
  const add = (id: string, rawStatus: CheckStatus, detail: string): void => {
    const capability = capabilityForCheck(id);
    const status =
      rawStatus === "fail" &&
      options.mode === "automatic" &&
      capability &&
      !required.has(capability)
        ? "warn"
        : rawStatus;
    checks.push({ id, status, detail });
  };

  const nodeVersion = options.nodeVersion ?? process.version;
  add("node", atLeast(nodeVersion, "24.0.0") ? "pass" : "fail", `${nodeVersion}; required >=24`);

  const piVersionResult = await run("pi", ["--version"]);
  if (piVersionResult.status !== 0) add("pi", "fail", "pi executable is unavailable");
  else {
    const piVersion = piVersionResult.stdout.trim();
    add("pi", atLeast(piVersion, "0.84.2") ? "pass" : "fail", `${piVersion}; required >=0.84.2`);
  }

  let settings: Settings | undefined;
  const settingsPath = path.join(configRoot, "settings.json");
  try {
    const parsed: unknown = JSON.parse(await readText(settingsPath));
    if (!isRecord(parsed)) throw new Error("settings.json must contain an object");
    settings = parsed;
    add("settings", "pass", settingsPath);
  } catch (error: unknown) {
    add("settings", "fail", error instanceof Error ? error.message : String(error));
  }

  if (settings) {
    add(
      "tui-mode",
      settings.tuiMode === "fullscreen" ? "pass" : "fail",
      settings.tuiMode === "fullscreen"
        ? "fullscreen application-owned scrolling enabled"
        : "expected tuiMode=fullscreen for stable multiplexed-terminal scrolling",
    );
    if (!Array.isArray(settings.packages))
      add("packages", "fail", "settings.packages must be an array");
    else {
      const packageResults = await Promise.all(
        settings.packages.map(async (spec) => {
          if (!isString(spec) || !/^\.\/packages\/[^/]+$/.test(spec)) {
            return { error: `${String(spec)}: expected ./packages/<name>` };
          }
          try {
            const manifest: unknown = JSON.parse(
              await readText(path.resolve(configRoot, spec, "package.json")),
            );
            if (!isRecord(manifest))
              return { error: `${spec}: package.json must contain an object` };
            if (!hasPiEntryPoint(manifest))
              return { error: `${spec}: package.json has no pi entry point` };
            return {};
          } catch (error: unknown) {
            return { error: `${spec}: ${error instanceof Error ? error.message : String(error)}` };
          }
        }),
      );
      const errors = packageResults.flatMap((result) => (result.error ? [result.error] : []));
      add(
        "packages",
        errors.length ? "fail" : "pass",
        errors.length ? errors.join("; ") : "all configured local packages have valid Pi manifests",
      );
    }
  }

  try {
    const parsed: unknown = JSON.parse(await readText(path.join(configRoot, "subagents.json")));
    if (!isRecord(parsed)) throw new Error("subagents.json must contain an object");
    // SAFETY: isRecord above establishes the only runtime shape used from this settings object.
    const subagents = parsed as SubagentsSettings;
    const valid = subagents.disableDefaultAgents === true && subagents.fallbackSubagent === "none";
    const roleFiles = ["general", "planner", "implementer", "reviewer", "handoff"];
    const roleResults = await Promise.all(
      roleFiles.map(async (role) => {
        const content = await readText(path.join(configRoot, "agents", `${role}.md`));
        const { frontmatter } = parseFrontmatter<Record<string, RuntimeValue>>(content);
        return {
          role,
          valid:
            isString(frontmatter.default_model) &&
            isString(frontmatter.default_thinking) &&
            frontmatter.model === undefined &&
            frontmatter.thinking === undefined,
        };
      }),
    );
    const invalidRoles = roleResults.filter((result) => !result.valid).map((result) => result.role);
    add(
      "subagents",
      valid && invalidRoles.length === 0 ? "pass" : "fail",
      valid && invalidRoles.length === 0
        ? "custom roles fail closed; model and thinking defaults remain spawn-overridable"
        : [
            valid ? null : "expected disableDefaultAgents=true and fallbackSubagent=none",
            invalidRoles.length
              ? `locked or missing role defaults: ${invalidRoles.join(", ")}`
              : null,
          ]
            .filter((value): value is string => value !== null)
            .join("; "),
    );
  } catch (error: unknown) {
    add("subagents", "fail", error instanceof Error ? error.message : String(error));
  }

  const requiredResources = [
    "../tsconfig.json",
    "../package.json",
    "../pnpm-lock.yaml",
    "../pnpm-workspace.yaml",
    "../scripts/install-profile.mjs",
    "../scripts/install-profile.d.mts",
    "SYSTEM.md",
    "choco-pi-codex.json",
    "zentui.json",
    "extensions/apex-provider.ts",
    "extensions/apex-provider.json",
    "extensions/command-filter.ts",
    "extensions/context-status.ts",
    "extensions/runtime-model-prompt.ts",
    "extensions/runtime-writing-prompt.ts",
    "extensions/model-context-cap.ts",
    "extensions/context-cap.json",
    "extensions/review.json",
    "extensions/review/index.ts",
    "extensions/model-controls.ts",
    "extensions/session-aliases.ts",
    "extensions/session-bridge.ts",
    "extensions/tool-search.ts",
    "extensions/file-checkpoints.ts",
    "extensions/exec-session-guidance.ts",
    "extensions/provider-usage.ts",
    "review-policy.md",
    "writing-policy.md",
    "subagents.json",
    "model-guidance.md",
    "agents/general.md",
    "agents/planner.md",
    "agents/implementer.md",
    "agents/reviewer.md",
    "agents/handoff.md",
    "skills/check/SKILL.md",
    "skills/effective-writing/SKILL.md",
    "skills/task-core/SKILL.md",
    "skills/task-inline/SKILL.md",
    "skills/task/SKILL.md",
    "skills/task-hotfix/SKILL.md",
    "skills/commit/SKILL.md",
    "skills/review/SKILL.md",
    "skills/check/scripts/check-harness.ts",
    "scripts/checkout-mutation-lease.ts",
    "prompts/check.md",
    "prompts/task-inline.md",
    "prompts/task.md",
    "prompts/task-hotfix.md",
    "prompts/commit.md",
    "prompts/review-agent.md",
  ];
  const resourceResults = await Promise.all(
    requiredResources.map(async (entry) => ({
      entry,
      exists: await exists(path.join(configRoot, entry)),
    })),
  );
  const missingResources = resourceResults
    .filter((result) => !result.exists)
    .map((result) => result.entry);
  const coreResources = new Set([
    "SYSTEM.md",
    "writing-policy.md",
    "skills/check/SKILL.md",
    "skills/check/scripts/check-harness.ts",
    "skills/task-core/SKILL.md",
    "scripts/checkout-mutation-lease.ts",
  ]);
  const missingCore = missingResources.filter((entry) => coreResources.has(entry));
  add(
    "core-resources",
    missingCore.length ? "fail" : "pass",
    missingCore.length
      ? `missing: ${missingCore.join(", ")}`
      : "shared instructions and mutation-ownership resources present",
  );
  add(
    "resources",
    missingResources.length ? "fail" : "pass",
    missingResources.length
      ? `missing: ${missingResources.join(", ")}`
      : "system prompt, agents, workflows, and command aliases present",
  );

  const lspRoot = path.join(configRoot, "packages", "choco-pi-lsp");
  try {
    const manifest: unknown = JSON.parse(await readText(path.join(lspRoot, "package.json")));
    const version = isRecord(manifest) && isString(manifest.version) ? manifest.version : undefined;
    const grammarPresent = await exists(
      path.join(lspRoot, "grammars", "tree-sitter-typescript.wasm"),
    );
    const astGrepPresent = await exists(path.join(lspRoot, "node_modules", "@ast-grep", "napi"));
    const valid = version === "0.1.0" && grammarPresent && astGrepPresent;
    add(
      "choco-pi-lsp",
      valid ? "pass" : "fail",
      valid
        ? `choco-pi-lsp ${version}; semantic tools available`
        : [
            version === "0.1.0" ? null : `expected version 0.1.0, found ${version ?? "unknown"}`,
            grammarPresent ? null : "tree-sitter-typescript.wasm is missing",
            astGrepPresent ? null : "@ast-grep/napi is missing",
          ]
            .filter((value): value is string => value !== null)
            .join("; "),
    );
  } catch (error: unknown) {
    add("choco-pi-lsp", "fail", error instanceof Error ? error.message : String(error));
  }

  const status: CheckStatus = checks.some((check) => check.status === "fail")
    ? "fail"
    : checks.some((check) => check.status === "warn")
      ? "warn"
      : "pass";
  return {
    status,
    configRoot,
    mode: options.mode,
    requiredCapabilities: options.mode === "full" ? "all" : [...required],
    checks,
  };
}

async function main(): Promise<void> {
  let options: Pick<HarnessOptions, "mode" | "requiredCapabilities">;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  const report = await checkHarness(options);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === "fail" ? 1 : 0;
}

function isCliEntry(entry: string | undefined): boolean {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isCliEntry(process.argv[1])) await main();
