import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertRecordingDestinationsAvailable,
  deriveAgentBrowser0381ContactSheetPath,
  getRecordingContactSheetRequest,
} from "../extensions/agent-browser/lib/recording-contact-sheet.ts";
import {
  enumerateRecordingReservationDestinations,
  restoreRecordingReservationStateFromBranch,
} from "../extensions/agent-browser/lib/recording-reservations.ts";
import { getArtifactPreflightValidationError } from "../extensions/agent-browser/lib/runtime-extension.ts";
import { extractFileArtifacts } from "../extensions/agent-browser/lib/results/presentation/artifacts.ts";

test("derives and rejects colliding contact-sheet destinations before recording", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-browser-recording-"));
  try {
    assert.equal(
      deriveAgentBrowser0381ContactSheetPath("captures/demo.webm"),
      "captures/demo.contact-sheet.png",
    );
    const request = getRecordingContactSheetRequest(
      ["record", "start", "demo.webm", "--contact-sheet"],
      cwd,
    );
    assert.equal(request.destination?.path, "demo.contact-sheet.png");
    await assert.rejects(
      assertRecordingDestinationsAvailable({
        activeAbsolutePaths: new Set([request.destination?.absolutePath ?? ""]),
        destinations: request.destination ? [request.destination] : [],
      }),
      /reserved by an active recording/,
    );
    await writeFile(request.destination?.absolutePath ?? "", "user-owned");
    await assert.rejects(
      assertRecordingDestinationsAvailable({
        activeAbsolutePaths: new Set(),
        destinations: request.destination ? [request.destination] : [],
      }),
      /already exists/,
    );
    const artifacts = await extractFileArtifacts({
      commandInfo: { command: "record", subcommand: "stop" },
      cwd,
      data: { contactSheetPath: request.destination?.path },
    });
    assert.equal(artifacts[0]?.kind, "image");
    assert.equal(artifacts[0]?.mediaType, "image/png");
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("restores version-two extra recording destinations and closes them", () => {
  const activeEntry = {
    customType: "agent-browser-recording-reservation",
    data: {
      absolutePath: "/tmp/take.webm",
      additionalDestinations: [
        {
          absolutePath: "/tmp/take-contact-sheet.png",
          kind: "image",
          path: "take-contact-sheet.png",
          role: "contact-sheet",
        },
      ],
      cwd: "/tmp",
      path: "take.webm",
      sessionName: "owned",
      state: "active",
      version: 2,
    },
    type: "custom",
  };
  const restored = restoreRecordingReservationStateFromBranch([activeEntry]);
  const reservation = [...restored.active.values()][0];
  assert.ok(reservation);
  assert.deepEqual(enumerateRecordingReservationDestinations(reservation), [
    { absolutePath: "/tmp/take.webm", path: "take.webm" },
    { absolutePath: "/tmp/take-contact-sheet.png", path: "take-contact-sheet.png" },
  ]);
  const closed = restoreRecordingReservationStateFromBranch([
    activeEntry,
    {
      customType: "agent-browser-recording-reservation",
      data: { sessionName: "owned", state: "closed", version: 2 },
      type: "custom",
    },
  ]);
  assert.equal(closed.active.size, 0);
  assert.equal(closed.terminal.size, 1);
});

test("general artifact guards reserve recording contact sheets without blocking cleanup", () => {
  const reservation = {
    absolutePath: "/tmp/take.webm",
    additionalDestinations: [
      {
        absolutePath: "/tmp/take.contact-sheet.png",
        kind: "image" as const,
        path: "take.contact-sheet.png",
        role: "contact-sheet" as const,
      },
    ],
    cwd: "/tmp",
    path: "take.webm",
    sessionName: "owned",
  };
  const common = { activeRecordingReservations: [reservation], cwd: "/tmp" };
  assert.match(
    getArtifactPreflightValidationError({
      ...common,
      args: ["snapshot"],
      outputPath: "/tmp/take.contact-sheet.png",
    }) ?? "",
    /reserved by an active recording/u,
  );
  assert.match(
    getArtifactPreflightValidationError({
      ...common,
      args: ["batch"],
      stdin: '[["screenshot","/tmp/take.contact-sheet.png"]]',
    }) ?? "",
    /reserved by an active recording/u,
  );
  assert.equal(
    getArtifactPreflightValidationError({ ...common, args: ["record", "stop"] }),
    undefined,
  );
  assert.equal(getArtifactPreflightValidationError({ ...common, args: ["close"] }), undefined);
  assert.equal(
    getArtifactPreflightValidationError({
      ...common,
      args: ["snapshot"],
      outputPath: "/tmp/distinct.json",
    }),
    undefined,
  );
});
