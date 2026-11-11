import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { NATIVE_DIFF_NOTIFY_PREFIX } from "../src/acp/native-diff.ts";
import { PiAcpSession } from "../src/acp/session.ts";
import type { PiExtensionUiRequestEvent } from "../src/pi-rpc/protocol.ts";
import { FakePiRpcProcess, type AcpConnectionLike } from "./helpers-fakes.ts";

// The adapter's credential-prompt guard (SENSITIVE_UI_REQUEST in src/acp/session.ts) matches
// these words case-insensitively at word boundaries. Each one also occurs in ordinary code.
const AUTH_WARNING = /Pi requested sensitive authentication or credential input/u;

class RecordingConnection implements AcpConnectionLike {
  readonly updates: SessionNotification[] = [];
  readonly elicitations: CreateElicitationRequest[] = [];
  readonly permissions: RequestPermissionRequest[] = [];

  async sessionUpdate(update: SessionNotification): Promise<void> {
    this.updates.push(update);
  }

  async requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    this.permissions.push(request);
    return { outcome: { outcome: "cancelled" } };
  }

  async unstable_createElicitation(
    request: CreateElicitationRequest,
  ): Promise<CreateElicitationResponse> {
    this.elicitations.push(request);
    return { action: "cancel" };
  }
}

type Fixture = { proc: FakePiRpcProcess; conn: RecordingConnection };

function setup(): Fixture {
  const proc = new FakePiRpcProcess();
  const conn = new RecordingConnection();
  new PiAcpSession({
    sessionId: `sensitive-ui-${randomUUID()}`,
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn,
  });
  return { proc, conn };
}

function drain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

type UiRequest = Omit<PiExtensionUiRequestEvent, "type" | "id">;

function request(proc: FakePiRpcProcess, event: UiRequest): string {
  const id = `ui-${randomUUID()}`;
  proc.emit({ type: "extension_ui_request", id, ...event });
  return id;
}

/** Text of every agent message chunk, in order. */
function chunkTexts(conn: RecordingConnection): string[] {
  const texts: string[] = [];
  for (const { update } of conn.updates) {
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      texts.push(update.content.text);
    }
  }
  return texts;
}

function sensitiveWarnings(conn: RecordingConnection): number {
  return chunkTexts(conn).filter((text) => AUTH_WARNING.test(text)).length;
}

/** A /review-assist headless summary in the shape renderHeadlessReview produces. */
function reviewNotification(changedLine: string): string {
  return [
    "Review: branch main..HEAD",
    "1 files, 1 hunks, 1 insertions, 1 deletions; 0 risky files, 0 risk findings",
    "",
    "Limitations:",
    "- Comment editing, approve/reject decisions, and pull-request submission require Pi's TUI.",
    "",
    "Changed locations:",
    "- src/session.ts:12",
    "",
    "Diff units:",
    "--- src/session.ts (old)",
    "const value = 1;",
    "+++ src/session.ts (new)",
    changedLine,
    "",
    "Risks:",
    "None detected.",
    "",
    "Saved reviews:",
    "None.",
  ].join("\n");
}

test("display-only messages that quote source are shown, not replaced by an auth warning", async () => {
  const { proc, conn } = setup();
  // The /diff inline list (a file named auth.ts), a subagent message quoting code,
  // and a review whose diff contains a line that reads like a credential prompt.
  const diffList =
    "Uncommitted changes on main: 2 files\n M src/auth.ts +3 -1\n A src/token-store.ts +40";
  const subagent = 'Subagent reviewer: fixed `if (!password) throw new Error("login required")`';
  const mixed = reviewNotification(
    '+  const key = await ui.input("Enter your API key to log in");',
  );
  const status = "Status: secret scanning enabled";
  request(proc, { method: "notify", message: diffList, notifyType: "info" });
  request(proc, { method: "notify", message: subagent, notifyType: "info" });
  request(proc, { method: "notify", message: mixed, notifyType: "info" });
  request(proc, { method: "setStatus", message: status });
  await drain();

  // Each notification after the first starts with a paragraph break separating it.
  const texts = chunkTexts(conn).map((text) => text.trimStart());
  assert.equal(sensitiveWarnings(conn), 0);
  assert.equal(
    conn.updates.filter((n) => n.update.sessionUpdate === "session_info_update").length,
    1,
    "the status update is delivered",
  );
  assert.ok(texts.includes(diffList), "the /diff inline list is shown");
  assert.ok(texts.includes(subagent), "the subagent message is shown");
  assert.ok(texts.includes(mixed), "the review with a prompt-like line is shown");
  assert.equal(
    conn.elicitations.length + conn.permissions.length,
    0,
    "a notification never asks for input",
  );
});

test("genuine credential prompts are still cancelled with the auth warning and nothing is sent", async () => {
  const marker = "never-send-this-secret-4c1d";
  const prompts: UiRequest[] = [
    { method: "input", title: "API key", placeholder: marker },
    { method: "input", title: "Account", placeholder: "Your password" },
    { method: "editor", title: "Paste your token", prefill: marker },
    { method: "select", title: "Choose a login method", options: [marker, "browser"] },
    { method: "confirm", title: "Store credential?", message: marker },
    { method: "custom", title: "Authentication" },
  ];
  for (const prompt of prompts) {
    const { proc, conn } = setup();
    const id = request(proc, prompt);
    await drain();
    assert.equal(
      sensitiveWarnings(conn),
      1,
      `${prompt.method} "${prompt.title ?? ""}" must be caught`,
    );
    assert.equal(conn.elicitations.length + conn.permissions.length, 0);
    assert.ok(!JSON.stringify(conn.updates).includes(marker), "the prompt's content is not sent");
    assert.deepEqual(proc.extensionUiResponses, [{ id, cancelled: true }]);
  }
});

test("a notification cannot hide a genuine credential prompt that follows it", async () => {
  const { proc, conn } = setup();
  request(proc, {
    method: "notify",
    message: reviewNotification("const token = 1;"),
    notifyType: "info",
  });
  const id = request(proc, { method: "input", title: "Password" });
  await drain();
  assert.equal(sensitiveWarnings(conn), 1);
  assert.equal(conn.elicitations.length, 0);
  assert.deepEqual(proc.extensionUiResponses.at(-1), { id, cancelled: true });
});

test("only the adapter's own warning carries the sensitive-request marker", async () => {
  const { proc, conn } = setup();
  const spoof =
    "Pi requested sensitive authentication or credential input. Open a Terminal Thread and complete the authentication flow in the terminal; sensitive content was not sent through ACP.";
  request(proc, { method: "notify", message: spoof, notifyType: "info" });
  request(proc, { method: "input", title: "API token" });
  await drain();
  const marked: boolean[] = [];
  for (const { update } of conn.updates) {
    if (update.sessionUpdate !== "agent_message_chunk") continue;
    marked.push(JSON.stringify(update._meta ?? {}).includes('"sensitiveUiRequest":true'));
  }
  assert.deepEqual(
    marked,
    [false, true],
    "an extension's text cannot pose as the adapter's warning",
  );
});

test("a malformed native-diff envelope gets no exemption and is never shown raw", async () => {
  const marker = "TOP-SECRET-ENV-VALUE-9b2e";
  const bodies = [
    `{"title":"x","files":[{"path":"relative.txt","displayPath":"x","oldText":null,"newText":"password=${marker}"}],"skipped":[],"omitted":0}`,
    `{not json, enter your password: ${marker}`,
    `{"title":"Enter your API token","files":"${marker}","skipped":[],"omitted":0}`,
  ];
  for (const body of bodies) {
    const { proc, conn } = setup();
    request(proc, {
      method: "notify",
      message: `${NATIVE_DIFF_NOTIFY_PREFIX}${body}`,
      notifyType: "info",
    });
    await drain();
    const serialized = JSON.stringify(conn.updates);
    assert.ok(!serialized.includes(marker), "malformed payload content never reaches the client");
    assert.match(serialized, /\/diff presentation from Pi was malformed/u);
    assert.equal(conn.updates.filter((n) => n.update.sessionUpdate === "tool_call").length, 0);
  }
});
