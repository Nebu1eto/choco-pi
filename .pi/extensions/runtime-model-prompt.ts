import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  composeModelGuidancePrompt,
  parseModelGuidance,
  type ParsedModelGuidance,
} from "./lib/model-guidance.ts";

const PROFILE_GUIDANCE_PATH = fileURLToPath(new URL("../model-guidance.md", import.meta.url));

function readProfileGuidance(): ParsedModelGuidance | undefined {
  try {
    return parseModelGuidance(readFileSync(PROFILE_GUIDANCE_PATH, "utf8"));
  } catch {
    return undefined;
  }
}

const profileGuidance = readProfileGuidance();

export default function runtimeModelPrompt(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, ctx) => {
    const model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
    return {
      systemPrompt: composeModelGuidancePrompt(event.systemPrompt, model, profileGuidance),
    };
  });
}
