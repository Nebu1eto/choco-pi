import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  agentLabels,
  describePath,
  formatStatus,
  lookupModelRecord,
  normalizePackageKey,
  parseAgentFrontmatter,
  summarizeStatusRows,
} from "../.pi/extensions/session-status.ts";

test("formatStatus renders multi-line values with continuation lines", () => {
  const rendered = formatStatus([
    { label: "Skills", value: "2 loaded\n  check, review" },
    { label: "Theme", value: "nord-dark" },
  ]);
  const lines = rendered.split("\n");
  assert.match(lines[0], /^Skills:\s+2 loaded$/);
  assert.equal(lines[1], "  check, review");
  assert.match(lines[2], /^Theme:\s+nord-dark$/);
});

test("formatStatus colors semantic environment values", () => {
  const calls: string[] = [];
  const style = {
    fg: (color: string, text: string) => {
      calls.push(`${color}:${text}`);
      return text;
    },
    bold: (text: string) => text,
  };
  const rendered = formatStatus(
    [
      { label: "Model", value: "claude-fable-5" },
      { label: "Context usage", value: "59.9% (10,000 tokens) · details in /context" },
      { label: "Context usage", value: "60.0% (20,000 tokens) · details in /context" },
      { label: "Context usage", value: "85.1% (30,000 tokens) · details in /context" },
      { label: "MCP servers", value: "2 configured, 1 cached, awaiting: figma" },
      { label: "Skills", value: "2 loaded\n  check, review" },
    ],
    style,
  );

  assert.match(rendered, /^Model:/m);
  assert.ok(calls.includes("accent:claude-fable-5"));
  assert.ok(calls.includes("success:59.9%"));
  assert.ok(calls.includes("warning:60.0%"));
  assert.ok(calls.includes("error:85.1%"));
  assert.ok(calls.includes("warning:, awaiting: figma"));
  assert.ok(calls.includes("dim:  check, review"));
});

test("normalizePackageKey strips protocol and version while keeping scopes", () => {
  assert.equal(
    normalizePackageKey("npm:@tintinweb/pi-subagents@0.16.1"),
    "@tintinweb/pi-subagents",
  );
  assert.equal(normalizePackageKey("npm:pi-zentui@0.18.1"), "pi-zentui");
  assert.equal(
    normalizePackageKey("./packages/choco-pi-provider-synthetic"),
    "./packages/choco-pi-provider-synthetic",
  );
});

test("describePath reports missing files without throwing", () => {
  const missing = path.join(tmpdir(), "choco-pi-status-definitely-missing", "AGENTS.md");
  assert.match(describePath(missing, tmpdir()), /\(missing\)$/);
});

test("describePath exposes symlink targets", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "choco-pi-status-link-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "SYSTEM.md");
  const link = path.join(directory, "agent", "SYSTEM.md");
  await writeFile(target, "prompt");
  await rm(path.dirname(link), { recursive: true, force: true });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(link), { recursive: true });
  await symlink(target, link);

  const description = describePath(link, directory);
  assert.match(description, /->/);
  assert.ok(description.includes(displaySuffix(target)) || description.includes(target));
});

function displaySuffix(filePath: string): string {
  return filePath.split(path.sep).slice(-2).join("/");
}

test("lookupModelRecord returns baseUrl from the agent models store", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "choco-pi-status-models-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const agentBase = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  context.after(() => {
    if (agentBase === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = agentBase;
  });
  await writeFile(
    path.join(directory, "models-store.json"),
    JSON.stringify({
      synthetic: {
        models: [
          {
            id: "kimi",
            provider: "synthetic",
            baseUrl: "https://api.synthetic.new/v1",
            name: "Kimi",
          },
        ],
      },
    }),
  );
  const record = lookupModelRecord({ cwd: directory }, "synthetic", "kimi");
  assert.equal(record?.baseUrl, "https://api.synthetic.new/v1");
});

test("parseAgentFrontmatter reads model and thinking defaults", () => {
  const frontmatter = parseAgentFrontmatter(
    "---\nname: reviewer\ndefault_model: anthropic/claude-opus\ndefault_thinking: high\n---\nbody",
  );
  assert.deepEqual(frontmatter, {
    default_model: "anthropic/claude-opus",
    default_thinking: "high",
  });
});

test("agentLabels reports unreadable definitions instead of failing", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "choco-pi-status-agents-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const labels = agentLabels(path.join(directory, "missing"));
  assert.deepEqual(labels, []);
});

test("summarizeStatusRows includes session and model essentials", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "choco-pi-status-rows-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const ctx = {
    cwd: directory,
    model: undefined,
    sessionManager: {
      getSessionName: () => undefined,
      getSessionId: () => "session-1",
      getSessionFile: () => undefined,
      getHeader: () => ({ timestamp: "2026-08-17T10:00:00Z" }),
    },
    getContextUsage: () => undefined,
    modelRegistry: { find: () => undefined },
    getSystemPromptOptions: () => ({ contextFiles: [], skills: [] }),
  };
  // SAFETY: The fixture supplies every host member exercised by this test.
  const rows = summarizeStatusRows(ctx as never, "medium");
  const rendered = formatStatus(rows);
  assert.match(rendered, /Session ID:\s+session-1/);
  assert.match(rendered, /Model:\s+No model is currently selected/);
  assert.match(rendered, /Reasoning effort:\s+medium/);
  assert.match(rendered, /Context files:\s+none/);
  assert.match(rendered, /Skills:\s+none loaded/);
});
