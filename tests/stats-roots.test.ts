import { getAgentDir } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sessionsRoots } from "../profile/extensions/lib/stats/report.ts";

const agentSessions = path.resolve(getAgentDir(), "sessions");

test("without a configured session directory only the agent's own sessions are read", () => {
  assert.deepEqual(sessionsRoots(undefined, {}), [agentSessions]);
  assert.deepEqual(sessionsRoots("", { PI_CODING_AGENT_SESSION_DIR: "" }), [agentSessions]);
});

test("the sessionDir setting adds the directory Pi writes sessions to, normalized as Pi does", () => {
  assert.deepEqual(sessionsRoots("~/choco-sessions", {}), [
    agentSessions,
    path.join(homedir(), "choco-sessions"),
  ]);
  assert.deepEqual(sessionsRoots("relative/sessions", {}), [
    agentSessions,
    path.resolve("relative/sessions"),
  ]);
});

test("PI_CODING_AGENT_SESSION_DIR takes precedence over the setting, as in Pi", () => {
  assert.deepEqual(sessionsRoots("/from/settings", { PI_CODING_AGENT_SESSION_DIR: "/from/env" }), [
    agentSessions,
    "/from/env",
  ]);
  assert.deepEqual(sessionsRoots("/from/settings", { PI_CODING_AGENT_SESSION_DIR: "" }), [
    agentSessions,
    "/from/settings",
  ]);
});

test("a session directory equal to the agent's own is read once", () => {
  assert.deepEqual(sessionsRoots(agentSessions, {}), [agentSessions]);
});
