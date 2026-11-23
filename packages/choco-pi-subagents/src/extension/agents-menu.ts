import { type ModelRegistry, resolveModel } from "../model-resolver.ts";
import { getAgentConfig, getAllTypes, BUILTIN_TOOL_NAMES } from "../agent-types.ts";
import {
  type ExtensionCommandContext,
  getSettingsListTheme,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { showSchedulesMenu } from "../ui/schedule-menu.ts";
import type { AgentConfig, AgentRecord } from "../types.ts";
import { type SettingItem, SettingsList, Container, Text, Spacer } from "@earendil-works/pi-tui";
import { describeRoleDeclaration } from "../invocation-config.ts";
import { pickAgentType, BACK, headlessConversationNotice } from "../ui/headless-menus.ts";
import { selectItem } from "../ui/select-item.ts";
import { getDisplayName, formatDuration } from "../ui/agent-widget.ts";
import { continueRunningAgentNavigation } from "../ui/focus-mode.ts";
import {
  locateAgentFile,
  personalAgentsDir,
  projectAgentsDir,
  serializeAgentFile,
  disableInContent,
  enableInContent,
  isEmptyStub,
  buildNewAgentFile,
} from "../agent-file-toggle.ts";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { pathExists } from "../fs-async.ts";
import { join } from "node:path";
import { THINKING_LEVELS } from "../workflow.ts";
import { isWorktreeIsolationEnabled } from "../worktree.ts";
import { getModelLabelFromConfig } from "./helpers.ts";
import type { SubagentsRuntime } from "./runtime.ts";

export function installAgentsMenu(pi: ExtensionAPI, rt: SubagentsRuntime) {
  function getModelLabel(type: string, registry?: ModelRegistry): string {
    const cfg = getAgentConfig(type);
    if (!cfg?.model) return "inherit";
    const label = getModelLabelFromConfig(cfg.model);
    if (!registry) return label;
    const resolution = resolveModel(cfg.model, registry);
    switch (resolution.tag) {
      case "error":
        return `${label} (unavailable, fallback: inherit)`;
      case "resolved": {
        const resolvedFull = `${resolution.model.provider}/${resolution.model.id}`;
        const norm = (s: string) =>
          s
            .toLowerCase()
            .replace(/\./g, "-")
            .replace(/-\d{8}$/, "");
        if (norm(cfg.model) === norm(resolvedFull)) return label;
        return `${label} (→ ${resolvedFull.replace(/-\d{8}$/, "")})`;
      }
    }
  }

  async function showAgentsMenu(ctx: ExtensionCommandContext) {
    if (!(await rt.revival.refreshAgentsForSession())) return;
    const allNames = getAllTypes();

    const options: string[] = [];

    const agents = rt.core.manager.listAgents().filter((a) => !a.parentAgentId);
    if (agents.length > 0) {
      const running = agents.filter((a) => a.status === "running" || a.status === "queued").length;
      const done = agents.filter((a) => a.status === "completed" || a.status === "steered").length;
      options.push(`Running agents (${agents.length}) — ${running} running, ${done} done`);
    }

    if (allNames.length > 0) {
      options.push(`Agent types (${allNames.length})`);
    }

    if (rt.scheduling.scheduler.isActive()) {
      const jobCount = rt.scheduling.scheduler.list().length;
      options.push(`Scheduled jobs (${jobCount})`);
    }

    options.push("Create new agent");
    options.push("Settings");

    const noAgentsMsg =
      allNames.length === 0 && agents.length === 0
        ? "No agents found. Create specialized subagents that can be delegated to.\n\n" +
          "Each subagent has its own context window, custom system prompt, and specific tools.\n\n" +
          "Try creating: Code Reviewer, Security Auditor, Test Writer, or Documentation Writer.\n\n"
        : "";

    if (noAgentsMsg) {
      ctx.ui.notify(noAgentsMsg, "info");
    }

    const choice = await ctx.ui.select("Agents", options);
    if (!choice) return;

    const reopen = ctx.mode === "tui" ? () => showAgentsMenu(ctx) : async () => {};

    if (choice.startsWith("Running agents (")) {
      const focused = await showRunningAgents(ctx);
      if (!focused) await reopen();
    } else if (choice.startsWith("Agent types (")) {
      const back = await showAllAgentsList(ctx);
      if (back) await showAgentsMenu(ctx);
      else await reopen();
    } else if (choice.startsWith("Scheduled jobs (")) {
      await showSchedulesMenu(ctx, rt.scheduling.scheduler);
      await reopen();
    } else if (choice === "Create new agent") {
      await showCreateWizard(ctx);
    } else if (choice === "Settings") {
      await rt.settingsMenu.showSettings(ctx);
      await reopen();
    }
  }

  async function showAllAgentsList(ctx: ExtensionCommandContext): Promise<boolean> {
    const allNames = getAllTypes();
    if (allNames.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return false;
    }

    const sourceIndicator = (cfg: AgentConfig | undefined) => {
      const disabled = cfg?.enabled === false;
      if (cfg?.source === "project") return disabled ? "✕• " : "•  ";
      if (cfg?.source === "global") return disabled ? "✕◦ " : "◦  ";
      if (disabled) return "✕  ";
      return "   ";
    };

    const items: SettingItem[] = allNames.map((name) => {
      const cfg = getAgentConfig(name);
      const disabled = cfg?.enabled === false;
      const model = getModelLabel(name, ctx.modelRegistry);
      const declared = describeRoleDeclaration(cfg);
      return {
        id: name,
        label: `${sourceIndicator(cfg)}${name}`,
        currentValue: model,
        description: `${disabled ? "(disabled)" : (cfg?.description ?? name)}\n${declared}`,
        values: [model],
      };
    });

    const hasCustom = allNames.some((n) => {
      const c = getAgentConfig(n);
      return c && !c.isDefault && c.enabled !== false;
    });
    const hasDisabled = allNames.some((n) => getAgentConfig(n)?.enabled === false);
    const legendParts: string[] = [];
    if (hasCustom) legendParts.push("• = project  ◦ = global");
    if (hasDisabled) legendParts.push("✕ = disabled");

    if (ctx.mode !== "tui") {
      const picked = await pickAgentType(ctx.ui, items);
      if (picked === BACK) return true;
      if (picked !== undefined && getAgentConfig(picked)) {
        await showAgentDetail(ctx, picked);
        return showAllAgentsList(ctx);
      }
      return false;
    }

    const selected = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
      const slTheme = getSettingsListTheme();
      const list = new SettingsList(
        items,
        Math.min(items.length, 12),
        slTheme,
        (id) => done(id),
        () => done(undefined),
      );
      const container = new Container();
      container.addChild(new Text("Agent types", 0, 0));
      if (legendParts.length)
        container.addChild(new Text(slTheme.hint(legendParts.join("  ")), 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(list);
      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => list.handleInput?.(data),
      };
    });

    if (selected && getAgentConfig(selected)) {
      await showAgentDetail(ctx, selected);
      await showAllAgentsList(ctx);
    }
    return false;
  }

  async function showRunningAgents(ctx: ExtensionCommandContext): Promise<boolean> {
    const agents = rt.core.manager.listAgents().filter((a) => !a.parentAgentId);
    if (agents.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return false;
    }

    const record = await selectItem(ctx.ui, "Running agents", agents, (a) => {
      const dn = getDisplayName(a.type);
      const dur = formatDuration(a.startedAt, a.completedAt);
      return `${dn} (${a.description}) · ${a.toolUses} tools · ${a.status} · ${dur}`;
    });
    if (!record) return false;

    const focused = await viewAgentConversation(ctx, record);
    return continueRunningAgentNavigation(focused, () => showRunningAgents(ctx));
  }

  async function viewAgentConversation(
    ctx: ExtensionCommandContext,
    record: AgentRecord,
  ): Promise<boolean> {
    if (ctx.mode !== "tui") {
      const label = `${getDisplayName(record.type)} (${record.description})`;
      ctx.ui.notify(headlessConversationNotice(record, label), "info");
      return false;
    }
    if (!record.session) {
      ctx.ui.notify(
        `Agent is ${record.status === "queued" ? "queued" : "expired"} — no session available.`,
        "info",
      );
      return false;
    }

    const { ConversationViewer, VIEWPORT_HEIGHT_PCT } =
      await import("../ui/conversation-viewer.ts");
    const session = record.session;
    const activity = rt.agentActivity.get(record.id);

    let focusRequested = false;
    await ctx.ui.custom<undefined>(
      (tui, theme, keybindings, done) => {
        return new ConversationViewer(
          tui,
          session,
          record,
          activity,
          theme,
          done,
          () => {
            if (rt.core.manager.abort(record.id)) {
              ctx.ui.notify(`Stopped "${record.description}".`, "info");
            }
          },
          keybindings,
          (message: string) => rt.core.manager.steer(record.id, message),
          {
            onFocus: () => {
              focusRequested = true;
              done(undefined);
              queueMicrotask(() => rt.views.focus.focus(record, tui, theme));
            },
          },
        );
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
      },
    );
    return focusRequested;
  }

  async function showAgentDetail(ctx: ExtensionCommandContext, name: string) {
    const cfg = getAgentConfig(name);
    if (!cfg) {
      ctx.ui.notify(`Agent config not found for "${name}".`, "warning");
      return;
    }

    const file = await locateAgentFile(name, cfg.sourcePath);
    const isDefault = cfg.isDefault === true;
    const disabled = cfg.enabled === false;

    let menuOptions: string[];
    if (disabled && file) {
      menuOptions = isDefault
        ? ["Enable", "Edit", "Reset to default", "Delete", "Back"]
        : ["Enable", "Edit", "Delete", "Back"];
    } else if (isDefault && !file) {
      menuOptions = ["Eject (export as .md)", "Disable", "Back"];
    } else if (isDefault && file) {
      menuOptions = ["Edit", "Disable", "Reset to default", "Delete", "Back"];
    } else {
      menuOptions = ["Edit", "Disable", "Delete", "Back"];
    }

    const choice = await ctx.ui.select(name, menuOptions);
    if (!choice || choice === "Back") return;

    if (choice === "Edit" && file) {
      const content = await readFile(file.path, "utf-8");
      const edited = await ctx.ui.editor(`Edit ${name}`, content);
      if (edited !== undefined && edited !== content) {
        await writeFile(file.path, edited, "utf-8");
        if (!(await rt.revival.refreshAgentsForSession())) return;
        ctx.ui.notify(`Updated ${file.path}`, "info");
      }
    } else if (choice === "Delete") {
      if (file) {
        const confirmed = await ctx.ui.confirm(
          "Delete agent",
          `Delete ${name} from ${file.location} (${file.path})?`,
        );
        if (confirmed) {
          await unlink(file.path);
          if (!(await rt.revival.refreshAgentsForSession())) return;
          ctx.ui.notify(`Deleted ${file.path}`, "info");
        }
      }
    } else if (choice === "Reset to default" && file) {
      const confirmed = await ctx.ui.confirm(
        "Reset to default",
        `Delete override ${file.path} and restore embedded default?`,
      );
      if (confirmed) {
        await unlink(file.path);
        if (!(await rt.revival.refreshAgentsForSession())) return;
        ctx.ui.notify(`Restored default ${name}`, "info");
      }
    } else if (choice.startsWith("Eject")) {
      await ejectAgent(ctx, name, cfg);
    } else if (choice === "Disable") {
      await disableAgent(ctx, name);
    } else if (choice === "Enable") {
      await enableAgent(ctx, name);
    }
  }

  async function prepareAgentTarget(
    targetDir: string,
    targetPath: string,
  ): Promise<boolean | undefined> {
    const generation = rt.state.revivalGeneration;
    await mkdir(targetDir, { recursive: true });
    const exists = await pathExists(targetPath);
    return generation === rt.state.revivalGeneration ? exists : undefined;
  }

  async function ejectAgent(ctx: ExtensionCommandContext, name: string, cfg: AgentConfig) {
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    const targetPath = join(targetDir, `${name}.md`);
    const targetExists = await prepareAgentTarget(targetDir, targetPath);
    if (targetExists === undefined) return;
    if (targetExists) {
      const overwrite = await ctx.ui.confirm(
        "Overwrite",
        `${targetPath} already exists. Overwrite?`,
      );
      if (!overwrite) return;
    }

    const content = serializeAgentFile(cfg);

    await writeFile(targetPath, content, "utf-8");
    if (!(await rt.revival.refreshAgentsForSession())) return;
    ctx.ui.notify(`Ejected ${name} to ${targetPath}`, "info");
  }

  async function disableAgent(ctx: ExtensionCommandContext, name: string) {
    const file = await locateAgentFile(name, getAgentConfig(name)?.sourcePath);
    if (file) {
      const content = await readFile(file.path, "utf-8");
      const { content: updated, outcome } = disableInContent(content);
      if (outcome === "already-disabled") {
        ctx.ui.notify(`${name} is already disabled.`, "info");
        return;
      }
      if (outcome === "no-frontmatter") {
        ctx.ui.notify(`Cannot disable ${name}: ${file.path} has no frontmatter block.`, "error");
        return;
      }
      await writeFile(file.path, updated, "utf-8");
      if (!(await rt.revival.refreshAgentsForSession())) return;
      ctx.ui.notify(`Disabled ${name} (${file.path})`, "info");
      return;
    }

    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    await mkdir(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    await writeFile(targetPath, "---\nenabled: false\n---\n", "utf-8");
    if (!(await rt.revival.refreshAgentsForSession())) return;
    ctx.ui.notify(`Disabled ${name} (${targetPath})`, "info");
  }

  async function enableAgent(ctx: ExtensionCommandContext, name: string) {
    const file = await locateAgentFile(name, getAgentConfig(name)?.sourcePath);
    if (!file) return;

    const content = await readFile(file.path, "utf-8");
    const { content: updated, changed } = enableInContent(content);
    if (!changed && !isEmptyStub(updated)) {
      ctx.ui.notify(`${name} is not disabled in ${file.path}.`, "info");
      return;
    }
    if (isEmptyStub(updated)) {
      await unlink(file.path);
      if (!(await rt.revival.refreshAgentsForSession())) return;
      ctx.ui.notify(`Enabled ${name} (removed ${file.path})`, "info");
    } else {
      await writeFile(file.path, updated, "utf-8");
      if (!(await rt.revival.refreshAgentsForSession())) return;
      ctx.ui.notify(`Enabled ${name} (${file.path})`, "info");
    }
  }

  async function showCreateWizard(ctx: ExtensionCommandContext) {
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();

    const method = await ctx.ui.select("Creation method", [
      "Generate with Claude (recommended)",
      "Manual configuration",
    ]);
    if (!method) return;

    if (method.startsWith("Generate")) {
      await showGenerateWizard(ctx, targetDir);
    } else {
      await showManualWizard(ctx, targetDir);
    }
  }

  async function showGenerateWizard(ctx: ExtensionCommandContext, targetDir: string) {
    const description = await ctx.ui.input("Describe what this agent should do");
    if (!description) return;

    const name = await ctx.ui.input("Agent name (filename, no spaces)");
    if (!name) return;

    const targetPath = join(targetDir, `${name}.md`);
    const targetExists = await prepareAgentTarget(targetDir, targetPath);
    if (targetExists === undefined) return;
    if (targetExists) {
      const overwrite = await ctx.ui.confirm(
        "Overwrite",
        `${targetPath} already exists. Overwrite?`,
      );
      if (!overwrite) return;
    }

    ctx.ui.notify("Generating agent definition...", "info");

    const generatePrompt = `Create a custom pi sub-agent definition file based on this description: "${description}"

Write a markdown file to: ${targetPath}

The file format is a markdown file with YAML frontmatter and a system prompt body:

\`\`\`markdown
---
description: <one-line description shown in UI>
color: <optional agent name badge color: red, blue, green, yellow, purple, orange, pink, cyan, an Agency Agents alias, or quoted "#RRGGBB">
tools: <comma-separated built-in tools: read, bash, edit, write, find, ls. Use "none" for no tools. Omit for all tools>
model: <optional default model as "provider/modelId"; a caller's model overrides it unless model_locked. Omit to inherit the parent model>
thinking: <optional default thinking level: ${THINKING_LEVELS.join(", ")}; a caller's thinking overrides it unless model_locked>
model_locked: <true pins model and thinking so callers cannot override them. Default: false>
max_turns: <optional max agentic turns. 0 or omit for unlimited (default)>
internal: <true hides the agent from every caller-supplied type (Agent tool, workflows, @mentions, /btw); only first-party code spawns it by name. Default: false>
prompt_mode: <"replace" (body IS the full system prompt) or "append" (body is appended to default prompt). Default: replace>
extensions: <true (inherit all MCP/extension tools), false (none), or comma-separated names. Default: true>
skills: <true (inherit all), false (none), or comma-separated skill names to preload into prompt. Default: true>
disallowed_tools: <comma-separated tool names to block, even if otherwise available. Omit for none>
inherit_context: <true to fork parent conversation into agent so it sees chat history. Default: false>
run_in_background: <true or false to fix this agent's run mode. Omit to follow the caller (top-level spawns default to background)>
output_transcript: <false to write no transcript file or path for this agent. Independent of persist_session. Default: true>
isolated: <true for no extension/MCP tools, only built-in tools. Default: false>
memory: <"user" (global), "project" (per-project), or "local" (gitignored per-project) for persistent memory. Omit for none>${
      isWorktreeIsolationEnabled()
        ? `\nisolation: <"worktree" to run in isolated git worktree; "off" to refuse one even when the caller asks. Omit for normal>`
        : ""
    }
---

<system prompt body — instructions for the agent>
\`\`\`

Guidelines for choosing settings:
- For read-only tasks (review, analysis): tools: read, bash, find, ls
- For code modification tasks: include edit, write
- Use prompt_mode: append if the agent should keep the default system prompt and add specialization on top
- Use prompt_mode: replace for fully custom agents with their own personality/instructions
- Set inherit_context: true if the agent needs to know what was discussed in the parent conversation
- Set isolated: true if the agent should NOT have access to MCP servers or other extensions
- Set output_transcript: false to skip writing this agent's transcript; this alone doesn't keep the run off disk (persist_session, isolation: worktree commits, and memory still write) — set those too if that's the goal
- Only include frontmatter fields that differ from defaults — omit fields where the default is fine

Write the file with your file-writing tool (write, or apply_patch inside exec in Code Mode). Only write the file, nothing else.`;

    const { record } = await rt.core.manager.spawnAndWait(
      pi,
      ctx,
      "general-purpose",
      generatePrompt,
      {
        description: `Generate ${name} agent`,
        maxTurns: 5,
      },
    );

    if (record.status === "error") {
      ctx.ui.notify(`Generation failed: ${record.error}`, "warning");
      return;
    }

    if (!(await rt.revival.refreshAgentsForSession())) return;

    const createdGeneration = rt.state.revivalGeneration;
    const created = await pathExists(targetPath);
    if (createdGeneration !== rt.state.revivalGeneration) return;
    if (created) {
      ctx.ui.notify(`Created ${targetPath}`, "info");
    } else {
      ctx.ui.notify(
        "Agent generation completed but file was not created. Check the agent output.",
        "warning",
      );
    }
  }

  async function showManualWizard(ctx: ExtensionCommandContext, targetDir: string) {
    const name = await ctx.ui.input("Agent name (filename, no spaces)");
    if (!name) return;

    const description = await ctx.ui.input("Description (one line)");
    if (!description) return;

    const toolChoice = await ctx.ui.select("Tools", [
      "all",
      "none",
      "read-only (read, bash, find, ls)",
      "custom...",
    ]);
    if (!toolChoice) return;

    let tools: string;
    if (toolChoice === "all") {
      tools = BUILTIN_TOOL_NAMES.join(", ");
    } else if (toolChoice === "none") {
      tools = "none";
    } else if (toolChoice.startsWith("read-only")) {
      tools = "read, bash, find, ls";
    } else {
      const customTools = await ctx.ui.input(
        "Tools (comma-separated)",
        BUILTIN_TOOL_NAMES.join(", "),
      );
      if (!customTools) return;
      tools = customTools;
    }

    const modelChoice = await ctx.ui.select("Model", [
      "inherit (parent model)",
      "haiku",
      "sonnet",
      "opus",
      "custom...",
    ]);
    if (!modelChoice) return;

    let model: string | undefined;
    if (modelChoice === "haiku") model = "anthropic/claude-haiku-4-5";
    else if (modelChoice === "sonnet") model = "anthropic/claude-sonnet-4-6";
    else if (modelChoice === "opus") model = "anthropic/claude-opus-4-6";
    else if (modelChoice === "custom...") {
      model = (await ctx.ui.input("Model (provider/modelId)")) || undefined;
    }

    const thinkingChoice = await ctx.ui.select("Thinking level", ["inherit", ...THINKING_LEVELS]);
    if (!thinkingChoice) return;

    const systemPrompt = await ctx.ui.editor("System prompt", "");
    if (systemPrompt === undefined) return;

    const content = buildNewAgentFile({
      description,
      tools,
      model,
      thinking: thinkingChoice === "inherit" ? undefined : thinkingChoice,
      systemPrompt,
    });

    const targetPath = join(targetDir, `${name}.md`);
    const targetExists = await prepareAgentTarget(targetDir, targetPath);
    if (targetExists === undefined) return;
    if (targetExists) {
      const overwrite = await ctx.ui.confirm(
        "Overwrite",
        `${targetPath} already exists. Overwrite?`,
      );
      if (!overwrite) return;
    }

    await writeFile(targetPath, content, "utf-8");
    if (!(await rt.revival.refreshAgentsForSession())) return;
    ctx.ui.notify(`Created ${targetPath}`, "info");
  }

  return { showAgentsMenu };
}
