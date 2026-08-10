import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function runtimeModelPrompt(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event, ctx) => {
		if (!ctx.model) return;

		const runtimeContext = [
			"<runtime_environment>",
			`Current model: ${ctx.model.provider}/${ctx.model.id}`,
			"</runtime_environment>",
		].join("\n");

		return { systemPrompt: `${event.systemPrompt}\n\n${runtimeContext}` };
	});
}
