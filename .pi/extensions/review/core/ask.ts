/**
 * Side-chat transport for the interactive review view (`/review`).
 *
 * The founding constraint of `/review` is that the diff never enters the main
 * session's model context. Letting the reviewer ask questions must not undo
 * that, so this module runs the chat on an independent agent session with its
 * own context. Nothing from the main session reaches it, and nothing it sends
 * reaches the main session.
 *
 * Three rules follow from that constraint:
 *
 * 1. Only the location slice in `ReviewChatContext` is ever sent. No field on
 *    that type can carry diff text beyond the single focused line, and
 *    `buildReviewChatPrompt` reads nothing else.
 * 2. The prompt sends where the hunk is — file, hunk header, focused line —
 *    never the hunk body. The agent explores the repository with its own
 *    tools from that location, exactly as it would at the main prompt.
 * 3. The session carries the main agent's full toolset and harness. Question
 *    turns still instruct the model that a review answer changes nothing; a
 *    crippled tool allowlist proved worse, because harness extensions inject
 *    the main system prompt and the model faked the missing tools in text.
 *
 * Failures are transcript messages, not exceptions. A missing model, a provider
 * error, or a cancelled request must not tear down a review that may hold an
 * hour of unsent comments.
 */

import type { DiffSide } from "./types.ts";

/** Prefix on every transcript entry that reports a failure instead of an answer. */
export const REVIEW_CHAT_FAILURE_PREFIX = "Review chat error: ";

/* --------------------------------------------------------------- contracts */

/**
 * The location slice of a review a single question may carry.
 *
 * Deliberately no diff body: the agent gets where the reviewer is looking —
 * file, hunk header, focused line — and explores the repository with its own
 * tools. `reviewRoot` is the worktree or repository root the chat may read;
 * for a pull request review that is the pull request worktree, which is
 * exactly the tree the reviewer is looking at.
 */
export type ReviewChatContext = {
	path: string;
	side: DiffSide;
	line: number;
	/** Source text of the focused row without its diff prefix. */
	focusedLineText: string;
	/** The hunk's `@@ -old,+new @@` header, locating the change in both revisions. */
	hunkHeader: string;
	/** Worktree or repository root the chat may read. */
	reviewRoot: string;
};

export type ReviewChatTextMessage = { role: "user" | "assistant"; text: string };

/**
 * One tool call the chat's agent made, kept in transcript order.
 *
 * `result` holds the raw tool result — partial while `done` is false — in the
 * exact shape the session reported, so the view can hand it to the same
 * component the main agent renders tool calls with.
 */
export type ReviewChatToolCall = {
	role: "tool";
	toolCallId: string;
	toolName: string;
	args: unknown;
	result?: unknown;
	isError?: boolean;
	done: boolean;
};

export type ReviewChatMessage = ReviewChatTextMessage | ReviewChatToolCall;

/** Thinking levels Pi accepts, used to validate `/effort` before a session exists. */
export const REVIEW_CHAT_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
export type ReviewChatThinkingLevel = (typeof REVIEW_CHAT_THINKING_LEVELS)[number];

/** Model and effort the chat currently targets, as shown in the pane heading. */
export type ReviewChatStatus = {
	/** `provider/id`, or undefined when Pi's default model applies. */
	model?: string;
	thinkingLevel?: string;
};

/** A slash command the chat's own session can run. */
export type ReviewChatCommandInfo = {
	name: string;
	description?: string;
};

/**
 * The view-facing chat.
 *
 * `ask` resolves when the turn settles and never rejects; a failure arrives as
 * an assistant message. `messages` is live, so `onUpdate` listeners re-read it
 * rather than receiving a payload.
 */
export type ReviewChat = {
	ask(question: string, context: ReviewChatContext): Promise<void>;
	readonly messages: readonly ReviewChatMessage[];
	/** Fires as the reply streams in. Returns an unsubscribe function. */
	onUpdate(listener: () => void): () => void;
	readonly pending: boolean;
	/** Live model and effort; falls back to the requested values before the session exists. */
	readonly status: ReviewChatStatus;
	/** Apply a model query; resolves to the applied `provider/id` or rejects with the reason. */
	setModel(query: string): Promise<string>;
	/** Apply a thinking level; resolves to the level in effect or rejects with the reason. */
	setThinkingLevel(level: string): Promise<string>;
	/**
	 * Reload the session's resources — extensions, skills, prompts, and
	 * context files — exactly like the main agent's `/reload`. The transcript
	 * is kept. Rejects while a reply is still streaming.
	 */
	reload(): Promise<void>;
	/** Create the underlying session eagerly so commands and status are available before the first question. */
	prepare(reviewRoot: string): Promise<void>;
	/** Slash commands the chat's session can run, once it exists. */
	commands(): ReviewChatCommandInfo[];
	/**
	 * The session's registered tool definition for a tool name, once the
	 * session exists. The main transcript hands this to its tool component so
	 * extension and MCP tools render with their own renderers; the review
	 * chat does the same.
	 */
	toolDefinition(name: string): unknown;
	/**
	 * Run a slash command through the session's own command surface: an
	 * extension command executes, and a skill or prompt template expands into
	 * a real turn that streams into the transcript.
	 */
	runCommand(text: string, reviewRoot: string): Promise<void>;
	dispose(): void;
};

/* -------------------------------------------------------------- session seam */

/**
 * The subset of an agent session event this module reads.
 *
 * Pi's `AgentSessionEvent` union is structurally assignable to this, so the
 * default factory can forward events unchanged while tests emit plain objects.
 */
export type ReviewChatSessionEvent = {
	readonly type: string;
	readonly message?: unknown;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly args?: unknown;
	readonly partialResult?: unknown;
	readonly result?: unknown;
	readonly isError?: boolean;
};

/**
 * The subset of an agent session this module drives.
 *
 * Kept narrow so tests can inject a fake and never reach a provider.
 */
export type ReviewChatSession = {
	sendUserMessage(content: string): Promise<void>;
	subscribe(listener: (event: ReviewChatSessionEvent) => void): () => void;
	abort(): Promise<void>;
	dispose(): void;
	/** Live model and effort of the underlying session, when the transport exposes them. */
	describeModel?(): ReviewChatStatus;
	/** Resolve and apply a model query, returning the applied `provider/id`. */
	setModel?(query: string): Promise<string>;
	/** Apply a thinking level, returning the level in effect after clamping. */
	setThinkingLevel?(level: string): string;
	/** Reload the session's extensions, skills, prompts, and context files. */
	reload?(): Promise<void>;
	/** Run text through the session's prompt path with command and template expansion. */
	runCommand?(text: string): Promise<void>;
	/** Slash commands registered in the session: extension commands, prompts, and skills. */
	listCommands?(): ReviewChatCommandInfo[];
	/** Registered tool definition lookup, forwarded to the tool renderer. */
	getToolDefinition?(name: string): unknown;
};

export type ReviewChatSessionRequest = {
	cwd: string;
	model?: string;
	thinkingLevel?: ReviewChatThinkingLevel;
	/** Root the session's tools operate under. */
	reviewRoot: string;
};

export type ReviewChatSessionFactory = (
	request: ReviewChatSessionRequest,
) => Promise<ReviewChatSession>;

export type ReviewChatOptions = {
	cwd: string;
	model?: string;
	thinkingLevel?: string;
	/** Injection seam for tests. Defaults to an independent Pi session with the main toolset. */
	createSession?: ReviewChatSessionFactory;
};

/* -------------------------------------------------------------------- prompt */

/**
 * Build the text sent for one question.
 *
 * Everything the model sees about the review is assembled here, from
 * `ReviewChatContext` alone — a location, not diff text, so the agent
 * investigates the repository itself instead of trusting a pasted snippet.
 */
export function buildReviewChatPrompt(question: string, context: ReviewChatContext): string {
	const side = context.side === "LEFT" ? "LEFT (base revision)" : "RIGHT (head revision)";
	const lines = [
		"A human reviewer is reading one hunk of a local code review and has a question about it.",
		"",
		"Review context (location only — the diff body is deliberately not included):",
		`- file: ${context.path}`,
		`- hunk: ${context.hunkHeader}`,
		`- side: ${side}`,
		`- line: ${context.line}`,
		`- focused row text: ${JSON.stringify(context.focusedLineText)}`,
		`- repository root you may read: ${context.reviewRoot}`,
	];
	lines.push(
		"",
		"Question:",
		question.trim(),
		"",
		"Explore the repository yourself from that location: open the file around the given line under the repository root with your tools, and use git in that root (for example `git diff`, `git show`, `git log`) when you need the change itself or the base side.",
		"The working tree holds the head revision; LEFT line numbers refer to the base revision.",
		"Answer for a reviewer reading this code. You cannot and must not change anything.",
		"Be concise: lead with the answer in a few short sentences, and add detail only when the question genuinely needs it.",
		"Always end your turn with a text answer, even after using tools.",
		"Tag every fenced code block in your answer with its language, for example ```ts — an untagged fence renders without syntax highlighting.",
	);
	return lines.join("\n");
}

/* ---------------------------------------------------------------- transport */

/**
 * Create a review side chat.
 *
 * The session is created lazily on the first question and reused for every
 * later one, so follow-ups work without re-sending earlier context. It is
 * rooted at the first question's `reviewRoot`; a later question against a
 * different root still reports that root in its prompt, but the tools
 * stay where the chat started. A review does not change worktrees mid-session,
 * so that trade keeps one conversation instead of silently dropping history.
 */
export function createReviewChat(options: ReviewChatOptions): ReviewChat {
	const createSession = options.createSession ?? createDefaultReviewSession;
	const messages: ReviewChatMessage[] = [];
	const listeners = new Set<() => void>();

	let session: ReviewChatSession | undefined;
	let sessionPromise: Promise<ReviewChatSession> | undefined;
	let unsubscribe: (() => void) | undefined;
	let pendingCount = 0;
	let disposed = false;
	let queue: Promise<void> = Promise.resolve();
	/* model and effort requested for the session; live session values win once it exists */
	let desiredModel = options.model;
	let desiredThinking = parseThinkingLevel(options.thinkingLevel);

	/* per-turn streaming state */
	let activeAssistant: number | undefined;
	let turnProducedText = false;
	let turnFailure: string | undefined;

	function notify(): void {
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch {
				/* A broken view listener must not take the review down with it. */
			}
		}
	}

	function push(role: ReviewChatTextMessage["role"], text: string): number {
		messages.push({ role, text });
		return messages.length - 1;
	}

	function toolEntry(toolCallId: string): ReviewChatToolCall | undefined {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.role === "tool" && message.toolCallId === toolCallId) return message;
		}
		return undefined;
	}

	/**
	 * Mirror tool executions into the transcript in event order. The session
	 * emits them between assistant messages, so interleaving text and tool
	 * rows here reproduces the main agent's transcript order.
	 */
	function handleToolEvent(event: ReviewChatSessionEvent): boolean {
		if (typeof event.toolCallId !== "string") return false;
		if (event.type === "tool_execution_start") {
			if (typeof event.toolName !== "string") return true;
			messages.push({
				role: "tool",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				done: false,
			});
			notify();
			return true;
		}
		if (event.type === "tool_execution_update") {
			const entry = toolEntry(event.toolCallId);
			if (entry && event.partialResult !== undefined) {
				entry.result = event.partialResult;
				notify();
			}
			return true;
		}
		if (event.type === "tool_execution_end") {
			const entry = toolEntry(event.toolCallId);
			if (entry) {
				entry.result = event.result;
				entry.isError = event.isError === true;
				entry.done = true;
				notify();
			}
			return true;
		}
		return false;
	}

	function handleEvent(event: ReviewChatSessionEvent): void {
		if (disposed) return;
		if (handleToolEvent(event)) return;
		if (event.type === "message_start") {
			// A new message begins, so streamed text starts a new transcript entry.
			activeAssistant = undefined;
			return;
		}
		if (event.type !== "message_update" && event.type !== "message_end") return;

		const text = assistantText(event.message);
		if (text) {
			turnProducedText = true;
			if (activeAssistant === undefined) {
				activeAssistant = push("assistant", text);
				notify();
			} else {
				const existing = messages[activeAssistant];
				// `message_end` repeats the text already streamed; do not repaint for it.
				if (!(existing?.role === "assistant" && existing.text === text)) {
					messages[activeAssistant] = { role: "assistant", text };
					notify();
				}
			}
		}
		if (event.type === "message_end") {
			const failure = messageFailure(event.message);
			if (failure) turnFailure = failure;
			activeAssistant = undefined;
		}
	}

	async function ensureSession(reviewRoot: string): Promise<ReviewChatSession | undefined> {
		if (session) return session;
		if (!sessionPromise) {
			sessionPromise = Promise.resolve()
				.then(() =>
					createSession({
						cwd: options.cwd,
						model: desiredModel,
						...(desiredThinking ? { thinkingLevel: desiredThinking } : {}),
						reviewRoot: reviewRoot || options.cwd,
					}),
				)
				.catch((error: unknown) => {
					// Do not cache the failure: a later question should retry.
					sessionPromise = undefined;
					throw error;
				});
		}
		const created = await sessionPromise;
		if (disposed) {
			closeSession(created);
			return undefined;
		}
		if (!session) {
			session = created;
			unsubscribe = created.subscribe(handleEvent);
		}
		return session;
	}

	async function runTurn(question: string, context: ReviewChatContext): Promise<void> {
		try {
			if (disposed) return;
			const active = await ensureSession(context.reviewRoot);
			if (!active || disposed) return;

			activeAssistant = undefined;
			turnProducedText = false;
			turnFailure = undefined;

			await active.sendUserMessage(buildReviewChatPrompt(question, context));
			if (disposed) return;

			if (turnFailure) push("assistant", `${REVIEW_CHAT_FAILURE_PREFIX}${turnFailure}`);
			else if (!turnProducedText) {
				push("assistant", `${REVIEW_CHAT_FAILURE_PREFIX}the model returned no answer.`);
			}
			// Preamble text ("Let me check…") before a tool call satisfies
			// turnProducedText, so a turn whose transcript ends on a tool row
			// still finished without answering. Silence here reads as a hang to
			// the reviewer; name it instead.
			else if (messages.at(-1)?.role === "tool") {
				push("assistant", `${REVIEW_CHAT_FAILURE_PREFIX}the model ended its turn after a tool call without a final answer. Ask again to continue.`);
			}
		} catch (error) {
			if (!disposed) push("assistant", `${REVIEW_CHAT_FAILURE_PREFIX}${describeError(error)}`);
		} finally {
			pendingCount = Math.max(0, pendingCount - 1);
			notify();
		}
	}

	function closeSession(active: ReviewChatSession): void {
		void Promise.resolve()
			.then(() => active.abort())
			.catch(() => undefined)
			.then(() => {
				try {
					active.dispose();
				} catch {
					/* Already gone; disposal must not throw at the view. */
				}
			});
	}

	/**
	 * One command sent through the session's own prompt path. Unlike a
	 * question, a command may legitimately settle without producing text — an
	 * extension command runs immediately and returns — so no "no answer"
	 * failure is synthesized here.
	 */
	async function runCommandTurn(text: string, reviewRoot: string): Promise<void> {
		try {
			if (disposed) return;
			const active = await ensureSession(reviewRoot);
			if (!active || disposed) return;
			if (!active.runCommand) throw new Error("This chat session cannot run commands.");

			activeAssistant = undefined;
			turnProducedText = false;
			turnFailure = undefined;

			await active.runCommand(text);
			if (disposed) return;
			if (turnFailure) push("assistant", `${REVIEW_CHAT_FAILURE_PREFIX}${turnFailure}`);
		} catch (error) {
			if (!disposed) push("assistant", `${REVIEW_CHAT_FAILURE_PREFIX}${describeError(error)}`);
		} finally {
			pendingCount = Math.max(0, pendingCount - 1);
			notify();
		}
	}

	return {
		async ask(question: string, context: ReviewChatContext): Promise<void> {
			if (disposed) return;
			const trimmed = question.trim();
			if (!trimmed) return;

			push("user", trimmed);
			pendingCount += 1;
			notify();

			// Serialize turns: an independent session rejects a second prompt while
			// the first is still running.
			const run = queue.then(() => runTurn(trimmed, context));
			queue = run.then(
				() => undefined,
				() => undefined,
			);
			await run;
		},

		get messages(): readonly ReviewChatMessage[] {
			return messages;
		},

		onUpdate(listener: () => void): () => void {
			if (disposed) return () => undefined;
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		get pending(): boolean {
			return pendingCount > 0;
		},

		get status(): ReviewChatStatus {
			const live = session?.describeModel?.();
			const model = live?.model ?? desiredModel;
			const thinkingLevel = live?.thinkingLevel ?? desiredThinking;
			return {
				...(model ? { model } : {}),
				...(thinkingLevel ? { thinkingLevel } : {}),
			};
		},

		async setModel(query: string): Promise<string> {
			const trimmed = query.trim();
			if (!trimmed) throw new Error("Give a model query, for example /model claude-fable-5.");
			if (session) {
				if (!session.setModel) throw new Error("This chat session cannot switch models.");
				desiredModel = await session.setModel(trimmed);
			} else {
				// Applied and validated when the session is created on the next question.
				desiredModel = trimmed;
			}
			notify();
			return desiredModel;
		},

		async setThinkingLevel(level: string): Promise<string> {
			const parsed = parseThinkingLevel(level.trim());
			if (!parsed) {
				throw new Error(`Unknown thinking level "${level.trim()}". Use one of: ${REVIEW_CHAT_THINKING_LEVELS.join(", ")}.`);
			}
			if (session) {
				if (!session.setThinkingLevel) throw new Error("This chat session cannot change its thinking level.");
				desiredThinking = parseThinkingLevel(session.setThinkingLevel(parsed)) ?? parsed;
			} else desiredThinking = parsed;
			notify();
			return desiredThinking;
		},

		async reload(): Promise<void> {
			if (disposed) return;
			if (pendingCount > 0) {
				throw new Error("Wait for the current reply to finish before reloading the chat.");
			}
			// Before a session exists there is nothing loaded; the first
			// question reads every resource fresh anyway.
			if (!session) return;
			if (!session.reload) throw new Error("This chat session cannot reload resources.");
			await session.reload();
			notify();
		},

		async prepare(reviewRoot: string): Promise<void> {
			await ensureSession(reviewRoot);
			notify();
		},

		commands(): ReviewChatCommandInfo[] {
			return session?.listCommands?.() ?? [];
		},

		toolDefinition(name: string): unknown {
			return session?.getToolDefinition?.(name);
		},

		async runCommand(text: string, reviewRoot: string): Promise<void> {
			if (disposed) return;
			const trimmed = text.trim();
			if (!trimmed.startsWith("/")) return;
			push("user", trimmed);
			pendingCount += 1;
			notify();
			const run = queue.then(() => runCommandTurn(trimmed, reviewRoot));
			queue = run.then(
				() => undefined,
				() => undefined,
			);
			await run;
		},

		dispose(): void {
			if (disposed) return;
			disposed = true;
			unsubscribe?.();
			unsubscribe = undefined;
			listeners.clear();
			const active = session;
			session = undefined;
			// A session still being created is disposed by the awaiting turn, which
			// observes `disposed` when it resumes.
			if (active) closeSession(active);
		},
	};
}

/* ------------------------------------------------------------ default factory */

/**
 * Default session factory: an independent Pi session with the main agent's
 * default toolset and harness extensions, so the chat behaves exactly like
 * the main prompt while its conversation stays out of the main context.
 *
 * The session is in-memory: a review side chat is ephemeral, and an in-memory
 * session manager cannot restore messages from any earlier session.
 *
 * Imported dynamically so `core/ask.ts` stays loadable, and testable, without
 * pulling in the agent SDK.
 */
async function createDefaultReviewSession(
	request: ReviewChatSessionRequest,
): Promise<ReviewChatSession> {
	const { ModelRuntime, SessionManager, createAgentSession, resolveCliModel } =
		await import("@earendil-works/pi-coding-agent");

	const root = request.reviewRoot || request.cwd;
	const modelRuntime = await ModelRuntime.create();

	// Extension-registered providers (for example a proxy the main session's
	// model lives on) only enter `modelRuntime` during `bindExtensions`, so a
	// model that fails static resolution here is retried after binding
	// instead of failing the chat outright.
	let model: Awaited<ReturnType<typeof resolveCliModel>>["model"];
	let deferredModelQuery: string | undefined;
	if (request.model) {
		const resolved = resolveCliModel({ cliModel: request.model, modelRuntime });
		if (resolved.model) model = resolved.model;
		else deferredModelQuery = request.model;
	}

	const { session, extensionsResult } = await createAgentSession({
		cwd: root,
		model,
		modelRuntime,
		...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
		// The full default toolset, exactly like the main session. A tool
		// allowlist here is worse than none: extensions still inject the main
		// harness system prompt, and a model told about tools it cannot call
		// starts writing fake tool transcripts with fabricated results.
		sessionManager: SessionManager.inMemory(root),
	});

	try {
		await session.bindExtensions({ mode: "print" });
	} catch (error) {
		session.dispose();
		throw error;
	}

	if (deferredModelQuery) {
		const resolved = resolveCliModel({ cliModel: deferredModelQuery, modelRuntime });
		if (resolved.error || !resolved.model) {
			session.dispose();
			throw new Error(resolved.error ?? `No model matched ${deferredModelQuery}.`);
		}
		await session.setModel(resolved.model);
	}

	return {
		sendUserMessage: (content) => session.sendUserMessage(content),
		subscribe: (listener) => session.subscribe((event) => listener(event)),
		abort: () => session.abort(),
		dispose: () => session.dispose(),
		describeModel: () => ({
			...(session.model ? { model: `${session.model.provider}/${session.model.id}` } : {}),
			thinkingLevel: session.thinkingLevel,
		}),
		setModel: async (query) => {
			const resolved = resolveCliModel({ cliModel: query, modelRuntime });
			if (resolved.error || !resolved.model) {
				throw new Error(resolved.error ?? `No model matched ${query}.`);
			}
			await session.setModel(resolved.model);
			return `${resolved.model.provider}/${resolved.model.id}`;
		},
		setThinkingLevel: (level) => {
			const match = session.getAvailableThinkingLevels().find((candidate) => candidate === level);
			if (!match) {
				throw new Error(`Thinking level "${level}" is not available for this model. Available: ${session.getAvailableThinkingLevels().join(", ")}.`);
			}
			session.setThinkingLevel(match);
			return session.thinkingLevel;
		},
		reload: () => session.reload(),
		runCommand: (text) => session.prompt(text),
		listCommands: () => {
			try {
				return extensionsResult.runtime.getCommands().map((info) => ({
					name: info.name,
					...(info.description ? { description: info.description } : {}),
				}));
			} catch {
				// The runtime rejects reads until initialization; an empty
				// catalog only disables completion, never the commands.
				return [];
			}
		},
		getToolDefinition: (name) => session.getToolDefinition(name),
	};
}

/* ------------------------------------------------------------------- helpers */

function parseThinkingLevel(level: string | undefined): ReviewChatThinkingLevel | undefined {
	return REVIEW_CHAT_THINKING_LEVELS.find((candidate) => candidate === level);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Concatenated text content of an assistant message, ignoring thinking and tool calls. */
function assistantText(message: unknown): string {
	if (!isRecord(message) || message.role !== "assistant") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content) {
		if (isRecord(part) && part.type === "text" && typeof part.text === "string") text += part.text;
	}
	return text;
}

/**
 * Failure recorded on a finished assistant message.
 *
 * Provider failures do not reject the prompt call; they arrive as a final
 * assistant message with `stopReason` `error` or `aborted`.
 */
function messageFailure(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "assistant") return undefined;
	if (message.stopReason === "error") {
		return typeof message.errorMessage === "string" && message.errorMessage.trim()
			? message.errorMessage.trim()
			: "the model provider reported an error.";
	}
	if (message.stopReason === "aborted") return "the request was cancelled.";
	return undefined;
}

function describeError(error: unknown): string {
	if (error instanceof Error && error.message.trim()) return error.message.trim();
	const text = String(error).trim();
	return text || "unknown failure.";
}
