import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CURRENT_MODEL_PLACEHOLDER = "{{PI_CURRENT_MODEL}}";
const MAX_RUNTIME_MODEL_LENGTH = 512;

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function encodeRuntimeModel(provider: string, model: string): string {
	const value = `${provider}/${model}`;
	const bounded = value.length > MAX_RUNTIME_MODEL_LENGTH
		? `${value.slice(0, MAX_RUNTIME_MODEL_LENGTH - 1)}…`
		: value;
	const serialized = JSON.stringify(bounded)
		.replaceAll("\u2028", "\\u2028")
		.replaceAll("\u2029", "\\u2029");

	return escapeXml(serialized);
}

export function injectCurrentModel(systemPrompt: string, provider: string, model: string): string {
	const currentModel = encodeRuntimeModel(provider, model);
	if (systemPrompt.includes(CURRENT_MODEL_PLACEHOLDER)) {
		return systemPrompt.replaceAll(CURRENT_MODEL_PLACEHOLDER, currentModel);
	}

	const runtimeContext = [
		"<runtime_environment>",
		"Harness: choco-pi",
		`Current model: ${currentModel}`,
		"</runtime_environment>",
	].join("\n");

	return `${systemPrompt}\n\n${runtimeContext}`;
}

export default function runtimeModelPrompt(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event, ctx) => {
		if (!ctx.model) {
			return;
		}

		return {
			systemPrompt: injectCurrentModel(event.systemPrompt, ctx.model.provider, ctx.model.id),
		};
	});
}
