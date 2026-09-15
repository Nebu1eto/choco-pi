import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { canonicalJson, systemText, cacheableSegments } from "../../.pi/extensions/cache-probe.ts";
import {
  isJsonRecord,
  isString,
  type RuntimeValue,
} from "../../.pi/extensions/lib/runtime-values.ts";
import { parseJson } from "./io.ts";
import type { CaptureRecord, JsonValue } from "./types.ts";

export function hashCanonicalJson(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function requestPayload(value: RuntimeValue): JsonValue {
  return parseJson(JSON.stringify(value));
}

function captureRecord(payload: JsonValue, requestIndex: number): CaptureRecord {
  const request = isJsonRecord(payload) ? payload : {};
  const model = isString(request.model) ? request.model : "unknown";
  const tools = Array.isArray(request.tools) ? request.tools : [];
  let messages: JsonValue[] = [];
  if (Array.isArray(request.messages)) messages = request.messages;
  else if (Array.isArray(request.input)) messages = request.input;
  const system = systemText(payload);
  return {
    requestIndex,
    model,
    systemHash: hashCanonicalJson(system),
    systemChars: system.length,
    toolsHash: hashCanonicalJson(tools),
    toolNames: cacheableSegments(payload).toolNames,
    toolCount: tools.length,
    toolsChars: canonicalJson(tools).length,
    messageCount: messages.length,
  };
}

export default function capturePrefix(pi: ExtensionAPI): void {
  const capturePath = process.env.CHOCO_PI_PREFIX_CAPTURE;
  const captureFullPayload = process.env.CHOCO_PI_PREFIX_CAPTURE_FULL === "1";
  if (!capturePath) return;

  let requestIndex = 0;
  pi.on("before_provider_request", async (event) => {
    requestIndex += 1;
    const payload = requestPayload(event.payload);
    const record = captureRecord(payload, requestIndex);
    await mkdir(dirname(capturePath), { recursive: true });
    await appendFile(capturePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    if (captureFullPayload) {
      await writeFile(
        `${capturePath}.${requestIndex}.payload.json`,
        `${JSON.stringify(payload, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
  });
}
