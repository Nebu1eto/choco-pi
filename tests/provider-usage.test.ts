import assert from "node:assert/strict";
import test from "node:test";
import statusCommands, {
  createTabController,
  STATUS_TABS,
  type StatusTabId,
  tabBody,
  USAGE_REFRESH_MS,
} from "../.pi/extensions/status-commands.ts";
import {
  claudePlanLabel,
  codexPlanLabel,
  formatProviderUsage,
  normalizeClaudeUsage,
  normalizeCodexUsage,
} from "../.pi/extensions/provider-usage.ts";

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("status tabs expose Status and Usage in order", () => {
  assert.deepEqual(
    STATUS_TABS.map((tab) => tab.title),
    ["Status", "Usage"],
  );
});

test("usage tab keeps the white body text for readability", async () => {
  const body = await tabBody(
    {
      modelRegistry: { getProviderAuthStatus: () => ({ configured: false }) },
      ui: { theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` } },
    } as any,
    "medium",
    "usage",
    true,
  );
  assert.match(body, /^<text>Claude Code — not connected/);
});

test("registers /quota as a white-text alias for /usage", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  statusCommands({
    registerCommand: (
      name: string,
      command: { handler: (args: string, ctx: any) => Promise<void> },
    ) => {
      commands.set(name, command);
    },
    getThinkingLevel: () => "medium",
  } as any);

  assert.equal(commands.get("quota"), commands.get("usage"));
  assert.equal(commands.has("settings"), false);

  const notifications: Array<[string, string]> = [];
  await commands.get("quota")?.handler("", {
    modelRegistry: {
      getProviderAuthStatus: () => ({ configured: false }),
    },
    ui: {
      theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
      notify: (text: string, level: string) => notifications.push([text, level]),
    },
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.[1], "info");
  assert.match(notifications[0]?.[0] ?? "", /^<text>Claude Code — not connected/);
});

test("labels Claude plans from the live profile, with Team seats before the rate-limit tier", () => {
  const profile = (
    organization: Record<string, unknown>,
    account: Record<string, unknown> = {},
  ) => ({
    account,
    organization,
  });
  assert.equal(claudePlanLabel(profile({ rate_limit_tier: "default_claude_pro" })), "Pro");
  assert.equal(claudePlanLabel(profile({ rate_limit_tier: "default_claude_max_5x" })), "Max (5x)");
  assert.equal(
    claudePlanLabel(profile({ rate_limit_tier: "default_claude_max_20x" })),
    "Max (20x)",
  );
  assert.equal(
    claudePlanLabel(
      profile({
        organization_type: "claude_team",
        rate_limit_tier: "default_claude_max_5x",
        seat_tier: "team_tier_1",
      }),
    ),
    "Team",
  );
  assert.equal(
    claudePlanLabel(
      profile({
        organization_type: "claude_team",
        rate_limit_tier: "default_claude_max_20x",
        seat_tier: "team_premium",
      }),
    ),
    "Team Premium",
  );
  assert.equal(claudePlanLabel(profile({ organization_type: "claude_enterprise" })), "Enterprise");
  assert.equal(claudePlanLabel(profile({}, { has_claude_max: true })), "Max");
  assert.equal(claudePlanLabel(undefined), undefined);
  assert.equal(claudePlanLabel(undefined, "max"), "Max");
});

test("shows the Claude plan next to the usage windows", () => {
  const usage = normalizeClaudeUsage(
    {
      five_hour: { utilization: 12, resets_at: "2999-01-01T00:00:00Z" },
      extra_usage: { is_enabled: true, utilization: 4 },
    },
    { organization: { rate_limit_tier: "default_claude_max_20x" } },
  );
  assert.equal(usage.plan, "Max (20x)");
  assert.match(formatProviderUsage(usage), /^Claude Code — Max \(20x\) · extra usage 4% used\n/);
});

test("labels ChatGPT Codex plans and keeps unknown wire values readable", () => {
  assert.equal(codexPlanLabel("plus"), "Plus");
  assert.equal(codexPlanLabel("prolite"), "Pro (5x)");
  assert.equal(codexPlanLabel("pro"), "Pro (20x)");
  assert.equal(codexPlanLabel("business"), "Business");
  assert.equal(codexPlanLabel("self_serve_business_usage_based"), "Business");
  assert.equal(codexPlanLabel("team"), "Team");
  assert.equal(codexPlanLabel("some_new_plan"), "Some New Plan");
  assert.equal(codexPlanLabel(undefined), undefined);

  const usage = normalizeCodexUsage({
    plan_type: "prolite",
    credits: { balance: "0" },
    rate_limit: {},
  });
  assert.equal(usage.plan, "Pro (5x)");
  assert.equal(formatProviderUsage(usage), "OpenAI Codex — Pro (5x) · 0 credits");
});

test("re-queries the usage tab on every activation and every refresh interval", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const loads: StatusTabId[] = [];
  const paints: Array<[string, boolean]> = [];
  const controller = createTabController({
    load: (id) => {
      loads.push(id);
      return Promise.resolve(`${id}-body-${loads.length}`);
    },
    paint: (body, view) => paints.push([body, view.preserveScroll]),
    loading: "loading",
    failure: (id, message) => `failed ${id}: ${message}`,
  });

  controller.activate("usage");
  await flush();
  controller.activate("status");
  await flush();
  controller.activate("usage");
  await flush();
  assert.deepEqual(loads, ["usage", "status", "usage"]);
  assert.deepEqual(paints.at(-1), ["usage-body-3", false]);

  t.mock.timers.tick(USAGE_REFRESH_MS);
  await flush();
  assert.deepEqual(loads, ["usage", "status", "usage", "usage"]);
  assert.deepEqual(paints.at(-1), ["usage-body-4", true]);

  controller.dispose();
  t.mock.timers.tick(USAGE_REFRESH_MS * 2);
  assert.equal(loads.length, 4);
});

test("keeps the last good body when a refresh fails and never auto-refreshes Status", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let attempt = 0;
  const loads: StatusTabId[] = [];
  const paints: string[] = [];
  const controller = createTabController({
    load: (id) => {
      loads.push(id);
      attempt += 1;
      return attempt === 1 ? Promise.resolve("fresh") : Promise.reject(new Error("HTTP 500"));
    },
    paint: (body) => paints.push(body),
    loading: "loading",
    failure: (id, message) => `failed ${id}: ${message}`,
  });

  controller.activate("usage");
  await flush();
  assert.deepEqual(paints, ["loading", "fresh"]);

  t.mock.timers.tick(USAGE_REFRESH_MS);
  await flush();
  assert.deepEqual(loads, ["usage", "usage"]);
  assert.deepEqual(paints, ["loading", "fresh"]);

  controller.activate("status");
  await flush();
  assert.deepEqual(loads, ["usage", "usage", "status"]);
  assert.deepEqual(paints.at(-1), "failed status: HTTP 500");

  t.mock.timers.tick(USAGE_REFRESH_MS * 3);
  await flush();
  assert.deepEqual(loads, ["usage", "usage", "status"]);
  controller.dispose();
});
