import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerAgentsMdAutoload } from "../src/subdir.ts";

function createStubPi() {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	return {
		on(event: string, handler: (event: any, ctx: any) => unknown) {
			handlers.set(event, handler);
		},
		handlers,
	};
}

function realHostCodeModeEvent(target: string, cwd: string) {
	return {
		type: "tool_result",
		toolCallId: "1",
		toolName: "exec",
		input: {
			code: `const r = await tools.exec_command({cmd: ${JSON.stringify(`cat ${target}`)}, workdir: ${JSON.stringify(cwd)}}); text(r.output)`,
		},
		content: [{ type: "text", text: "Script completed" }],
		isError: false,
		details: {
			codeMode: true,
			cellId: "1",
			status: "result",
			traces: [
				{
					id: "cell:1:tool-1",
					name: "exec_command",
					input: { cmd: `cat ${target}`, workdir: cwd },
					status: "done",
					result: {
						content: [{ type: "text", text: `Command: cat ${target}\nOutput:\nfile body` }],
						details: { exit_code: 0 },
					},
				},
			],
		},
	};
}

test("injects AGENTS.md for Pi code-mode exec_command traces", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "choco-pi-agents-md-code-mode-"));
	try {
		// Match a git worktree, where .git is a file rather than a directory.
		fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/example-worktree\n");
		const packageDir = path.join(root, ".pi", "packages", "example");
		const target = path.join(packageDir, "src", "types.ts");
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(path.join(packageDir, "AGENTS.md"), "package-specific guidance");
		fs.writeFileSync(target, "export type Example = string;\n");

		const pi = createStubPi();
		registerAgentsMdAutoload(pi as never);
		const ctx = { cwd: root, hasUI: false, ui: { notify() {} } };
		pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

		const result = (await pi.handlers.get("tool_result")?.(realHostCodeModeEvent(target, root), ctx)) as
			| { content: { type: string; text?: string }[] }
			| undefined;
		const appendix = result?.content.find((item) => item.type === "text" && item.text?.includes("<subdirectory_agents_context>"));

		assert.ok(appendix?.text, "expected code-mode nested tool access to inject AGENTS.md context");
		assert.match(appendix.text, /<agents_file path="\.pi\/packages\/example\/AGENTS\.md">/);
		assert.match(appendix.text, /package-specific guidance/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
