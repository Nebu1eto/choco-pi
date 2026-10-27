/**
 * Foreground xAI server-side compaction through a real `createAgentSession`
 * (the shared xAI rig: INSTALLED openai-responses adapter, fake transports, no
 * network): the host's compaction is answered with an opaque compaction item,
 * replay sends it first (before the system prompt) with no summary text,
 * failures fall back to the local summarizer with a single notice and a
 * cooldown (or, over a committed checkpoint, the opaque guard cancels), and a
 * replay the transport refuses is refused locally without turning server-side
 * off. Wire expectations are written out by the test (role and text of each
 * item), never derived by slicing a captured request.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { JsonObject } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { buildBackgroundCompactionPreferencesSections } from "../../../extensions/lib/background-compaction-preferences.ts";
import {
  refreshSessionNativeState,
  sessionNativeRefreshers,
} from "../src/background-host/native-refresh.ts";
import { waitForBackgroundCompactionPreferenceChanges } from "../src/preferences-section.ts";
import {
  DEFAULT_XAI_COMPACTION_INSTRUCTIONS,
  xaiCompactionInstructions,
} from "../src/xai/backend.ts";
import {
  parseXaiWireBody,
  releaseXaiSessionCaptures,
  xaiTransportRefusals,
  XaiWireBodySchema,
} from "../src/xai/capture.ts";
import { isXaiDetails, placeholderSummary } from "../src/xai/details.ts";
import { readXaiCompactionMode } from "../src/xai/mode.ts";
import {
  compactionsOf,
  compactResponse,
  createXaiRig,
  type RecordingFetch,
  recordingFetch,
  type Sent,
  textForeground,
  textResponse,
  XAI_API_KEY,
  XAI_MODEL,
  XAI_NOTICE_PREFIX,
  type XaiRig,
  type XaiRigOptions,
} from "./xai-rig.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/** This file's own opaque item: the lane answers with it, replay must carry it verbatim. */
const ITEM = { type: "compaction", encrypted_content: "xai-foreground-synthetic-opaque" };

function nativeLane(): RecordingFetch {
  return recordingFetch(() => compactResponse(ITEM));
}

function createRig(options: Omit<XaiRigOptions, "lane"> & { readonly lane?: RecordingFetch }) {
  return createXaiRig({ ...options, lane: options.lane ?? nativeLane() });
}

type Frame = JsonObject & { readonly type: string };

/** Tool the auto-compaction rig's model calls; each result is a distinct marker. */
const STEP_TOOL = defineTool({
  name: "step",
  label: "step",
  description: "deterministic step",
  parameters: Type.Object({ label: Type.String() }),
  async execute(_id, params) {
    return { content: [{ type: "text", text: `XSTEP-RESULT-${params.label}` }], details: {} };
  },
});

/**
 * A `step` function call reporting `inputTokens` of context (drives the host
 * threshold), optionally preceded by assistant text in the same turn: the
 * adapter then replays that turn as two input items (message + function_call).
 */
function toolCallResponse(label: string, inputTokens: number, text?: string): Response {
  const item = {
    type: "function_call",
    id: `fc_${label}`,
    call_id: `call_${label}`,
    name: "step",
    arguments: JSON.stringify({ label }),
  };
  const callIndex = text === undefined ? 0 : 1;
  const message = { type: "message", id: `msg_${label}`, role: "assistant" };
  const textFrames: Frame[] =
    text === undefined
      ? []
      : [
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...message, status: "in_progress", content: [] },
          },
          {
            type: "response.output_text.delta",
            output_index: 0,
            item_id: message.id,
            content_index: 0,
            delta: text,
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              ...message,
              status: "completed",
              content: [{ type: "output_text", text, annotations: [] }],
            },
          },
        ];
  const frames: Frame[] = [
    { type: "response.created", response: { id: `resp_${label}`, status: "in_progress" } },
    ...textFrames,
    {
      type: "response.output_item.added",
      output_index: callIndex,
      item: { ...item, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: callIndex,
      item_id: item.id,
      delta: item.arguments,
    },
    {
      type: "response.output_item.done",
      output_index: callIndex,
      item: { ...item, status: "completed" },
    },
    {
      type: "response.completed",
      response: {
        id: `resp_${label}`,
        status: "completed",
        usage: {
          input_tokens: inputTokens,
          output_tokens: 1,
          total_tokens: inputTokens + 1,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    },
  ];
  return new Response(
    frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function noticesOf(rig: XaiRig): string[] {
  return rig.notices.filter((notice) => notice.startsWith(XAI_NOTICE_PREFIX));
}

const OpaqueItemSchema = Type.Object({
  type: Type.Literal("compaction"),
  encrypted_content: Type.String(),
});
const TextTurnSchema = Type.Object({ role: Type.String(), content: Type.String() });
const PartsTurnSchema = Type.Object({
  role: Type.String(),
  content: Type.Array(Type.Object({ text: Type.String() })),
});

/**
 * The test's own reading of one wire item: `system`, `<role>:<text>`, or
 * `compaction:<opaque>`. Independent of the production cut and mapping helpers.
 */
function turnOf(item: JsonObject | undefined): string {
  if (Value.Check(OpaqueItemSchema, item)) return `compaction:${item.encrypted_content}`;
  if (Value.Check(TextTurnSchema, item))
    return item.role === "system" ? "system" : `${item.role}:${item.content}`;
  if (!Value.Check(PartsTurnSchema, item)) return "unrecognized";
  if (item.role === "system") return "system";
  return `${item.role}:${item.content.map((part) => part.text).join("")}`;
}

function turnsOf(sent: Sent | undefined): string[] {
  return (sent?.body?.input ?? []).map(turnOf);
}

test(
  "server-side success commits the opaque item; replay sends it first, then the system prompt",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    const lane = nativeLane();
    const rig = await createRig({ foreground, lane });
    try {
      await rig.session.prompt("XR-GO");
      assert.equal(foreground.sent.length, 1);
      assert.deepEqual(
        turnsOf(foreground.sent[0]),
        [
          "system",
          "user:XR-PREFIX-A",
          "assistant:XR-PREFIX-B",
          "user:XR-KEPT-C",
          "assistant:XR-KEPT-D",
          "user:XR-GO",
        ],
        "the adapter sends the system prompt first, then the seeded turns",
      );

      const result = await rig.session.compact("XR focus");
      assert.equal(lane.sent.length, 1, "one compact request");
      const request = lane.sent[0];
      assert.equal(request?.url, "https://api.x.ai/v1/responses/compact");
      assert.equal(request?.headers.get("authorization"), `Bearer ${XAI_API_KEY}`);
      assert.ok(request?.body);
      assert.equal(request.body.model, XAI_MODEL.id);
      assert.equal(request.body.instructions, xaiCompactionInstructions("XR focus"));
      assert.ok(String(request.body.instructions).startsWith(DEFAULT_XAI_COMPACTION_INSTRUCTIONS));
      assert.ok(String(request.body.instructions).endsWith("XR focus"), "custom focus appended");
      // The compacted prefix: every captured turn up to the host cut, the
      // system prompt excluded, written out here rather than sliced from the capture.
      assert.deepEqual(turnsOf(request), [
        "user:XR-PREFIX-A",
        "assistant:XR-PREFIX-B",
        "user:XR-KEPT-C",
        "assistant:XR-KEPT-D",
        "user:XR-GO",
      ]);
      assert.equal(foreground.sent.length, 1, "the local summarizer never ran");

      const [entry, ...extra] = compactionsOf(rig.manager);
      assert.ok(entry);
      assert.equal(extra.length, 0);
      assert.ok(isXaiDetails(entry.details));
      assert.deepEqual(entry.details.item, {
        type: "compaction",
        encrypted_content: "xai-foreground-synthetic-opaque",
      });
      assert.equal(entry.details.compactionId, "cmp_rig");
      assert.equal(entry.details.cut.firstKeptEntryId, entry.firstKeptEntryId);
      assert.equal(entry.details.wire.compactedItems, 5, "five compacted turns");
      assert.equal(result.summary, placeholderSummary(5));
      assert.equal(result.summary.includes(ITEM.encrypted_content), false);
      assert.deepEqual(noticesOf(rig), []);

      await rig.session.prompt("XR-NEXT");
      const replay = foreground.sent.at(-1);
      assert.deepEqual(turnsOf(replay), [
        "compaction:xai-foreground-synthetic-opaque",
        "system",
        "assistant:XR-ANSWER",
        "user:XR-NEXT",
      ]);
      assert.equal(replay?.text.includes("xAI server-side compaction checkpoint"), false);
      assert.equal(replay?.body?.store, false);
      assert.deepEqual(xaiTransportRefusals(rig.manager.getSessionId()), []);

      // Re-compaction carries the earlier item forward inside the new prefix.
      await rig.session.compact();
      assert.equal(lane.sent.length, 2);
      assert.deepEqual(turnsOf(lane.sent[1]), [
        "compaction:xai-foreground-synthetic-opaque",
        "assistant:XR-ANSWER",
        "user:XR-NEXT",
      ]);
      assert.equal(
        lane.sent[1]?.body?.instructions,
        DEFAULT_XAI_COMPACTION_INSTRUCTIONS,
        "the default is sent when no custom instructions are given",
      );
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "an HTTP 4xx falls back to the local summarizer, then cools down without requests; each manual action is told",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    const lane = recordingFetch(
      () => new Response(JSON.stringify({ error: "bad request" }), { status: 400 }),
    );
    const rig = await createRig({ foreground, lane });
    try {
      await rig.session.prompt("XR-GO");
      const first = await rig.session.compact();
      assert.equal(lane.sent.length, 1);
      assert.match(first.summary, /XR-LOCAL-SUMMARY/u, "no checkpoint yet: local fallback");
      const [entry] = compactionsOf(rig.manager);
      assert.equal(isXaiDetails(entry?.details), false);
      assert.equal(noticesOf(rig).length, 1, "one fallback notice");
      assert.match(noticesOf(rig)[0] ?? "", /incompatible/u);

      await rig.session.prompt("XR-AGAIN");
      await rig.session.compact();
      assert.equal(lane.sent.length, 1, "the cooled-down scope sends nothing");
      assert.equal(noticesOf(rig).length, 2, "every manual fallback is told");
      const fallbacks = rig
        .records()
        .filter((record) => record.event === "fallback" && record.route === "manual");
      assert.equal(fallbacks.length, 2, "one record per manual action");
      assert.deepEqual(
        fallbacks.map((record) => record.trigger),
        ["manual", "manual"],
        "xAI fallback records carry the trigger",
      );
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "two manual no-capture compactions: one notice and one record each",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    const lane = nativeLane();
    const rig = await createRig({ foreground, lane });
    const sessionId = rig.manager.getSessionId();
    try {
      const counts: number[] = [];
      for (const prompt of ["XR-ONE", "XR-TWO"]) {
        await rig.session.prompt(prompt);
        releaseXaiSessionCaptures(sessionId);
        const before = noticesOf(rig).length;
        await rig.session.compact();
        counts.push(noticesOf(rig).length - before);
      }
      assert.deepEqual(counts, [1, 1]);
      assert.equal(lane.sent.length, 0, "no capture, no compact request");
      const fallbacks = rig
        .records()
        .filter(
          (record) =>
            record.event === "fallback" &&
            record.route === "manual" &&
            record.reason === "no-capture",
        );
      assert.equal(fallbacks.length, 2);
      assert.ok(fallbacks.every((record) => record.noticeAttempted));
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "a successful /compact with a focus journals instructions-forwarded silently",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    const rig = await createRig({ foreground });
    try {
      await rig.session.prompt("XR-GO");
      await rig.session.compact("keep decisions");
      assert.ok(isXaiDetails(compactionsOf(rig.manager)[0]?.details), "native success");
      const forwarded = rig
        .records()
        .filter((record) => record.detail === "instructions-forwarded");
      assert.equal(forwarded.length, 1);
      assert.equal(forwarded[0]?.noticeAttempted, false, "silent");
      assert.equal(forwarded[0]?.route, "manual");
      assert.equal(forwarded[0]?.provider, "xai");
      assert.deepEqual(noticesOf(rig), []);

      await rig.session.prompt("XR-NEXT");
      await rig.session.compact();
      assert.equal(
        rig.records().filter((record) => record.detail === "instructions-forwarded").length,
        1,
        "no record without a focus",
      );
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "a resolved endpoint other than api.x.ai is not admitted: no compact request, local summary, silent",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    const lane = nativeLane();
    // The model's static baseUrl is api.x.ai; the registry resolves a proxy for the request.
    const rig = await createRig({
      foreground,
      lane,
      auth: () => ({ ok: true, apiKey: XAI_API_KEY, baseUrl: "https://proxy.example/v1" }),
    });
    try {
      await rig.session.prompt("XR-GO");
      const result = await rig.session.compact();
      assert.equal(lane.sent.length, 0, "neither endpoint got a compact request");
      assert.match(result.summary, /XR-LOCAL-SUMMARY/u, "no checkpoint yet: local summary");
      assert.equal(isXaiDetails(compactionsOf(rig.manager).at(-1)?.details), false);
      assert.deepEqual(noticesOf(rig), [], "a policy decline is silent");
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "a focus over the instruction limit is refused before any request and falls back with a notice",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    const lane = nativeLane();
    const rig = await createRig({ foreground, lane });
    try {
      await rig.session.prompt("XR-GO");
      // 16 384 code points is the cap of the whole instructions text (default + focus).
      const result = await rig.session.compact("\u{1F600}".repeat(16_384));
      assert.equal(lane.sent.length, 0, "refused locally");
      assert.match(result.summary, /XR-LOCAL-SUMMARY/u);
      const notices = noticesOf(rig);
      assert.equal(notices.length, 1);
      assert.match(notices[0] ?? "", /oversized/u);
      const fallbacks = rig
        .records()
        .filter((record) => record.event === "fallback" && record.reason === "oversized");
      assert.equal(fallbacks.length, 1, JSON.stringify(rig.records()));
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "an extension ctx.compact() (the RPC and settled route) reaches the native lane",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    const lane = nativeLane();
    const rig = await createRig({ foreground, lane });
    try {
      await rig.session.prompt("XR-GO");
      const outcome = await new Promise<string>((resolve) => {
        rig.ctx().compact({
          customInstructions: "XR via ctx",
          onComplete: () => resolve("complete"),
          onError: (error) => resolve(`error: ${error.message}`),
        });
      });
      assert.equal(outcome, "complete");
      await rig.session.waitForIdle();
      assert.equal(lane.sent.length, 1);
      assert.equal(lane.sent[0]?.body?.instructions, xaiCompactionInstructions("XR via ctx"));
      assert.ok(isXaiDetails(compactionsOf(rig.manager).at(-1)?.details));
      assert.deepEqual(noticesOf(rig), []);
    } finally {
      await rig.dispose();
    }
  },
);

test("choco-pi mode never calls the compact endpoint", { timeout: 30_000 }, async () => {
  const foreground = textForeground();
  const lane = nativeLane();
  const rig = await createRig({ foreground, lane, mode: "choco-pi" });
  try {
    await rig.session.prompt("XR-GO");
    const result = await rig.session.compact();
    assert.equal(lane.sent.length, 0);
    assert.match(result.summary, /XR-LOCAL-SUMMARY/u);
  } finally {
    await rig.dispose();
  }
});

test(
  "a later handler that drops the item is refused at the transport; a local refusal never turns server-side off",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    const lane = nativeLane();
    let hostile = false;
    const stripper: ExtensionFactory = (pi) => {
      pi.on("before_provider_request", (event) => {
        if (!hostile || !Value.Check(XaiWireBodySchema, event.payload)) return undefined;
        return { ...event.payload, input: event.payload.input.slice(1) };
      });
    };
    const rig = await createRig({ foreground, lane, after: [stripper] });
    try {
      await rig.session.prompt("XR-GO");
      await rig.session.compact();
      assert.ok(isXaiDetails(compactionsOf(rig.manager)[0]?.details));
      hostile = true;
      const before = foreground.sent.length;
      await rig.session.prompt("XR-STRIPPED");
      assert.equal(foreground.sent.length, before, "the stripped request was never transmitted");
      assert.deepEqual(
        xaiTransportRefusals(rig.manager.getSessionId()).map((refusal) => refusal.code),
        ["item-missing"],
      );
      assert.equal(
        rig.notices.filter((notice) => /off for this session/u.test(notice)).length,
        0,
        "no disable notice",
      );
      assert.equal(
        rig.notices.filter((notice) => /replay refused \(item-missing\)/u.test(notice)).length,
        1,
        "one refusal notice",
      );

      hostile = false;
      await rig.session.prompt("XR-AFTER");
      const sent = foreground.sent.at(-1);
      assert.equal(turnsOf(sent)[0], "compaction:xai-foreground-synthetic-opaque", "replay on");
      assert.equal(
        sent?.text.includes("xAI server-side compaction checkpoint"),
        false,
        "no placeholder sent",
      );

      await rig.session.compact();
      assert.equal(lane.sent.length, 2, "later compactions stay native");
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "a provider 400 naming the compaction item turns server-side off; the checkpoint is then refused until loss is authorized",
  { timeout: 30_000 },
  async () => {
    let reject = false;
    const foreground = recordingFetch((index) =>
      reject
        ? new Response(JSON.stringify({ error: { message: "invalid compaction item" } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          })
        : textResponse(index === 0 ? "XR-ANSWER" : `XR-LOCAL-SUMMARY-${index}`),
    );
    const rig = await createRig({ foreground });
    try {
      await rig.session.prompt("XR-GO");
      await rig.session.compact();
      reject = true;
      await rig.session.prompt("XR-REJECTED");
      assert.equal(noticesOf(rig).length, 1);
      assert.match(noticesOf(rig)[0] ?? "", /provider-400/u);
      reject = false;
      const before = foreground.sent.length;
      await rig.session.prompt("XR-AFTER");
      assert.equal(foreground.sent.length, before, "refused locally: nothing transmitted");
      assert.deepEqual(
        xaiTransportRefusals(rig.manager.getSessionId()).map((refusal) => refusal.code),
        ["disabled"],
      );
      const refused = rig
        .records()
        .filter((record) => record.event === "refuse" && record.reason === "disabled");
      assert.equal(refused.length, 1);

      await rig.session.prompt("/compaction-allow-loss");
      await rig.session.prompt("XR-WITH-CONSENT");
      assert.equal(foreground.sent.length, before + 1, "sent once the loss is authorized");
      const sent = foreground.sent.at(-1);
      assert.equal(sent?.text.includes(ITEM.encrypted_content), false, "no item");
      assert.ok(sent?.text.includes("xAI server-side compaction checkpoint"), "placeholder");
      const losses = rig
        .records()
        .filter((record) => record.event === "loss" && record.detail === "disabled");
      assert.equal(losses.length, 1);
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "the xAI Preferences row writes the real setting and applies it to the running session",
  { timeout: 30_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "choco-pi-xai-preferences-"));
    const previous = process.env[AGENT_DIR_ENV];
    // `applyXaiMode` writes to Pi's agent dir; the session reads the mode back from it.
    process.env[AGENT_DIR_ENV] = dir;
    const foreground = textForeground();
    const lane = nativeLane();
    const rig = await createRig({ foreground, lane, dir, readMode: readXaiCompactionMode });
    try {
      await rig.session.prompt("XR-GO");
      const [section] = buildBackgroundCompactionPreferencesSections(rig.ctx());
      assert.ok(section, "the real registration published the row");
      const row = () => section.buildItems().find((item) => item.id === "compactionXai");
      assert.equal(row()?.label, "xAI compaction");
      assert.equal(row()?.currentValue, "server-side", "no settings file: the default");
      assert.deepEqual(row()?.values, ["server-side", "choco-pi"]);
      assert.deepEqual(section.handleChange("compactionXai", "bogus"), { kind: "rebuild" });

      section.handleChange("compactionXai", "choco-pi");
      await waitForBackgroundCompactionPreferenceChanges();
      const written: unknown = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
      assert.ok(Value.Check(Type.Object({ compactionXai: Type.Literal("choco-pi") }), written));
      assert.equal(row()?.currentValue, "choco-pi");
      // Applied in place: the next compaction stays local.
      const local = await rig.session.compact();
      assert.equal(lane.sent.length, 0, "choco-pi mode: no compact request");
      assert.match(local.summary, /XR-LOCAL-SUMMARY/u);

      section.handleChange("compactionXai", "server-side");
      await waitForBackgroundCompactionPreferenceChanges();
      assert.equal(await readXaiCompactionMode(dir), "server-side");
      await rig.session.prompt("XR-AGAIN");
      await rig.session.compact();
      assert.equal(lane.sent.length, 1, "server-side again: the compact endpoint answers");
      assert.ok(isXaiDetails(compactionsOf(rig.manager).at(-1)?.details));
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, AGENT_DIR_ENV);
      else process.env[AGENT_DIR_ENV] = previous;
      await rig.dispose();
    }
  },
);

test(
  "a subagent child compacts natively and replays its own item; the main session is untouched",
  { timeout: 60_000 },
  async () => {
    const mainForeground = textForeground();
    const mainLane = nativeLane();
    const childForeground = textForeground();
    const childLane = nativeLane();
    const main = await createRig({ foreground: mainForeground, lane: mainLane });
    const child = await createRig({ foreground: childForeground, lane: childLane, child: true });
    try {
      await main.session.prompt("XR-MAIN-GO");
      await child.session.prompt("XR-CHILD-GO");
      await child.session.compact();
      assert.equal(childLane.sent.length, 1, "the child's own compact request");
      assert.ok(turnsOf(childLane.sent[0]).includes("user:XR-CHILD-GO"));
      assert.ok(isXaiDetails(compactionsOf(child.manager)[0]?.details));
      await child.session.prompt("XR-CHILD-NEXT");
      assert.equal(
        turnsOf(childForeground.sent.at(-1))[0],
        "compaction:xai-foreground-synthetic-opaque",
        "child replay",
      );
      assert.deepEqual(xaiTransportRefusals(child.manager.getSessionId()), []);
      assert.deepEqual(noticesOf(child), []);

      assert.equal(mainLane.sent.length, 0, "the main session made no request for the child");
      assert.equal(compactionsOf(main.manager).length, 0);
      await main.session.compact();
      assert.equal(mainLane.sent.length, 1);
      assert.equal(turnsOf(mainLane.sent[0]).includes("user:XR-CHILD-GO"), false);
      assert.ok(isXaiDetails(compactionsOf(main.manager)[0]?.details));
      assert.deepEqual(noticesOf(main), []);
    } finally {
      await child.dispose();
      await main.dispose();
    }
  },
);

test(
  "the per-session refresh hook restores a reattached child's replay binding",
  { timeout: 60_000 },
  async () => {
    const foreground = textForeground();
    const lane = nativeLane();
    const rig = await createRig({ foreground, lane, child: true });
    const sessionId = rig.manager.getSessionId();
    try {
      assert.ok(sessionNativeRefreshers(sessionId).includes("choco-pi-compaction:replay"));
      // Detached state: the session's projection is gone, so captures cannot be mapped.
      releaseXaiSessionCaptures(sessionId);
      await rig.session.prompt("XR-UNMAPPED");
      await rig.session.compact();
      assert.equal(lane.sent.length, 0, "an unmapped capture cannot be compacted natively");
      assert.equal(isXaiDetails(compactionsOf(rig.manager).at(-1)?.details), false);

      await refreshSessionNativeState(sessionId, rig.ctx());
      await rig.session.prompt("XR-REMAPPED");
      await rig.session.compact();
      assert.equal(lane.sent.length, 1, "the restored binding maps the capture again");
      assert.ok(isXaiDetails(compactionsOf(rig.manager).at(-1)?.details));
      await rig.session.prompt("XR-AFTER");
      assert.equal(
        turnsOf(foreground.sent.at(-1))[0],
        "compaction:xai-foreground-synthetic-opaque",
        "replayed after refresh",
      );
    } finally {
      await rig.dispose();
    }
    assert.deepEqual(sessionNativeRefreshers(sessionId), [], "disposal unregisters the hook");
  },
);

test(
  "an auth-failed compact request fails the compaction instead of summarizing locally",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    const lane = recordingFetch(
      () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );
    const rig = await createRig({ foreground, lane });
    try {
      await rig.session.prompt("XR-GO");
      await assert.rejects(rig.session.compact(), /cancelled/u);
      assert.equal(lane.sent.length, 1);
      assert.equal(foreground.sent.length, 1, "no local summary after an auth failure");
      assert.equal(compactionsOf(rig.manager).length, 0);
      const notices = noticesOf(rig);
      assert.equal(notices.length, 1);
      assert.match(notices[0] ?? "", /auth/u);
    } finally {
      await rig.dispose();
    }
  },
);
test(
  "consecutive xAI compactions in a child tool loop advance the cut and never keep a compaction",
  { timeout: 60_000 },
  async () => {
    const TURNS = 4;
    const foreground = recordingFetch((index) =>
      index < TURNS ? toolCallResponse(`t${index}`, 190_000) : textResponse("XR-DONE"),
    );
    const lane = nativeLane();
    const rig = await createRig({
      foreground,
      lane,
      child: true,
      autoCompaction: true,
      tools: [STEP_TOOL],
    });
    try {
      await rig.session.prompt("XR-LOOP");
      const branch = rig.manager.getBranch();
      const position = new Map(branch.map((entry, index) => [entry.id, index]));
      const native = compactionsOf(rig.manager).filter((entry) => isXaiDetails(entry.details));
      assert.ok(native.length >= 3, `three native compactions in a row (got ${native.length})`);
      const kept = native.map((entry) => position.get(entry.firstKeptEntryId) ?? -1);
      for (let index = 1; index < kept.length; index++) {
        assert.ok(
          (kept[index] ?? -1) > (kept[index - 1] ?? -1),
          `firstKeptEntryId advances: ${kept.join(", ")}`,
        );
      }
      for (const entry of native) {
        const firstKept = branch.find((candidate) => candidate.id === entry.firstKeptEntryId);
        assert.notEqual(firstKept?.type, "compaction");
      }
      for (let index = 2; index < lane.sent.length; index++) {
        const label = `XSTEP-RESULT-t${index - 2}`;
        assert.equal(lane.sent[index]?.text.includes(label), false, `${label} not resent`);
      }
      assert.deepEqual(noticesOf(rig), []);
    } finally {
      await rig.dispose();
    }
  },
);
/** A response that streams nothing more until the request is aborted (a cancelled turn). */
function stalledResponse(signal: AbortSignal | null | undefined): Response {
  const created = {
    type: "response.created",
    response: { id: "resp_stall", status: "in_progress" },
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(`event: ${created.type}\ndata: ${JSON.stringify(created)}\n\n`),
      );
      signal?.addEventListener("abort", () => controller.error(new Error("aborted")), {
        once: true,
      });
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test(
  "xAI turns with text and a tool call compact natively three times across a cancel and resume",
  { timeout: 60_000 },
  async () => {
    const STALL = 2;
    const turns = new Map<number, number>([
      [0, 0],
      [1, 1],
      [3, 2],
      [4, 3],
      [5, 4],
    ]);
    const sent: Sent[] = [];
    const foreground: RecordingFetch = {
      sent,
      fetch: async (input, init) => {
        const text = String(init?.body ?? "");
        sent.push({
          url: String(input),
          headers: new Headers(init?.headers),
          text,
          body: parseXaiWireBody(text),
        });
        const index = sent.length - 1;
        if (index === STALL) return stalledResponse(init?.signal);
        const turn = turns.get(index);
        return turn === undefined
          ? textResponse("XR-DONE")
          : toolCallResponse(`t${turn}`, 190_000, `Reading step ${turn} now.`);
      },
    };
    const rig = await createRig({
      foreground,
      child: true,
      autoCompaction: true,
      tools: [STEP_TOOL],
    });
    try {
      const first = rig.session.prompt("XR-LOOP");
      while (sent.length <= STALL) await new Promise((resolve) => setTimeout(resolve, 5));
      await rig.session.abort();
      await first;
      await rig.session.prompt("XR-RESUME");
      const branch = rig.manager.getBranch();
      const position = new Map(branch.map((entry, index) => [entry.id, index]));
      const all = compactionsOf(rig.manager);
      const native = all.filter((entry) => isXaiDetails(entry.details));
      assert.ok(
        native.length >= 3,
        `three native compactions (got ${native.length} of ${all.length})`,
      );
      assert.equal(native.length, all.length, "no local fallback");
      const kept = native.map((entry) => position.get(entry.firstKeptEntryId) ?? -1);
      for (let index = 1; index < kept.length; index++) {
        assert.ok(
          (kept[index] ?? -1) > (kept[index - 1] ?? -1),
          `firstKeptEntryId advances: ${kept.join(", ")}`,
        );
      }
      const prefixes = native.map((entry) =>
        isXaiDetails(entry.details) ? entry.details.wire.prefixDigest : "",
      );
      assert.equal(new Set(prefixes).size, prefixes.length, "no compacted prefix is sent twice");
      assert.deepEqual(noticesOf(rig), []);
    } finally {
      await rig.dispose();
    }
  },
);

/** Request 0 answers; request 1 (after the first compaction) fails, so its capture is unusable. */
function failingSecondRequest(): RecordingFetch {
  return recordingFetch((index) =>
    index === 1
      ? new Response(JSON.stringify({ error: { message: "synthetic outage" } }), { status: 500 })
      : textResponse(`XR-ANSWER-${index}`),
  );
}

test(
  "a capture from before the newest compaction is never reused; the opaque guard cancels the local fallback",
  { timeout: 60_000 },
  async () => {
    const lane = nativeLane();
    const rig = await createRig({ foreground: failingSecondRequest(), lane, child: true });
    try {
      await rig.session.prompt("XR-GO");
      await rig.session.compact();
      assert.equal(lane.sent.length, 1);
      const [first] = compactionsOf(rig.manager);
      assert.ok(first && isXaiDetails(first.details));
      await rig.session.prompt("XR-FAILS");
      await assert.rejects(rig.session.compact(), /Compaction cancelled/u);
      assert.equal(lane.sent.length, 1, "the stale capture was not sent to the compact endpoint");
      assert.equal(compactionsOf(rig.manager).at(-1)?.id, first.id, "no placeholder summarized");
      assert.ok(
        rig.notices.some((notice) => /opaque xai server-side record/u.test(notice)),
        "the guard names the exits",
      );
      const cancels = rig
        .records()
        .filter((record) => record.event === "cancel" && record.reason === "opaque-checkpoint");
      assert.equal(cancels.length, 1, JSON.stringify(rig.records()));
      assert.equal(cancels[0]?.checkpointEntryId, first.id);
      assert.equal(
        rig.records().some((record) => record.event === "loss"),
        false,
        "no loss without consent",
      );
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "the same stale-capture fallback with loss authorized summarizes locally and journals the loss",
  { timeout: 60_000 },
  async () => {
    const lane = nativeLane();
    const rig = await createRig({
      foreground: failingSecondRequest(),
      lane,
      child: true,
      opaqueHistory: "allow-loss",
    });
    try {
      await rig.session.prompt("XR-GO");
      await rig.session.compact();
      const [first] = compactionsOf(rig.manager);
      assert.ok(first && isXaiDetails(first.details));
      await rig.session.prompt("XR-FAILS");
      await rig.session.compact();
      assert.equal(lane.sent.length, 1, "still no stale capture sent");
      const latest = compactionsOf(rig.manager).at(-1);
      assert.notEqual(latest?.id, first.id);
      assert.equal(isXaiDetails(latest?.details), false, "the local summarizer answered");
      const losses = rig.records().filter((record) => record.event === "loss");
      assert.equal(losses.length, 1, JSON.stringify(rig.records()));
      assert.equal(losses[0]?.checkpointEntryId, first.id);
      assert.ok(losses[0]?.noticeAttempted, "the loss is told");
    } finally {
      await rig.dispose();
    }
  },
);
