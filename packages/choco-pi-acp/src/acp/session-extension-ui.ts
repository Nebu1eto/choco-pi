/**
 * Extension UI bridging: sanitizing Pi extension UI requests and answering them through ACP elicitation or permission prompts.
 */
import type {
  ContentBlock,
  CreateElicitationRequest,
  RequestPermissionResponse,
  SessionUpdate,
  PermissionOption,
  CreateElicitationResponse,
} from "@agentclientprotocol/sdk";
import { type BoundaryValue, isBoolean, isBoundaryRecord, isString } from "../boundary.ts";
import type { PiRpcProcessLike } from "../pi-rpc/process.ts";
import { recordField, type PiExtensionUiRequestEvent } from "../pi-rpc/protocol.ts";
import { decodeNativeDiff, NATIVE_DIFF_NOTIFY_PREFIX, nativeDiffContent } from "./native-diff.ts";
import type { AcpConnection } from "./session.ts";

export type PermissionResponse = RequestPermissionResponse;

export type PendingExtensionUi = {
  generation: number;
  timer: ReturnType<typeof setTimeout>;
  cancelled: Promise<null>;
  release: () => void;
};

/** The `session_info_update` variant of an ACP session update. */
export type SessionInfoNotification = Extract<
  SessionUpdate,
  { sessionUpdate: "session_info_update" }
>;

/**
 * The sanitized, bounded projection of an extension UI request published to the
 * client, either as ACP `_meta` or as a synthetic tool call's `rawInput`.
 */
export type ExtensionUiRawInput = {
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
};

/** The synthetic ACP tool call standing in for an extension UI request on legacy clients. */
export type ExtensionUiToolCall = {
  toolCallId: string;
  title: string;
  kind: "other";
  status: "pending";
  rawInput: ExtensionUiRawInput;
};

export type ExtensionUiResponse =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true };

export const CONFIRM_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: "yes", name: "Yes", kind: "allow_once" },
  { optionId: "no", name: "No", kind: "reject_once" },
];

export const CHOICE_OPTION_PREFIX = "choice-";

export const EXTENSION_UI_TIMEOUT_MS = 60_000;

export const MAX_EXTENSION_UI_FALLBACK_LENGTH = 2_000;

export const MAX_EXTENSION_UI_TEXT_LENGTH = 10_000;

export const EXTENSION_UI_TOMBSTONE_CAPACITY = 8_192;

export const SENSITIVE_UI_REQUEST =
  /\b(?:auth(?:entication|orization)?|credential|login|pass(?:code|phrase|word)?|secret|token|api[ _-]?key|private[ _-]?key)\b/i;

/**
 * Extension UI methods that only display text and never collect a reply. They cannot
 * carry a credential prompt, so the keyword guard does not inspect them: their text is
 * routinely source code, file names, and diffs, where those words are ordinary.
 */
export const DISPLAY_ONLY_UI_METHODS: ReadonlySet<string> = new Set([
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
]);

export const SENSITIVE_UI_REQUEST_WARNING =
  "Pi requested sensitive authentication or credential input. Open a Terminal Thread and complete the authentication flow in the terminal; sensitive content was not sent through ACP.";

/** Convert bounded TUI-oriented extension text into portable ACP text. */
export function sanitizeExtensionUiText(input: string): string {
  const source = input.slice(0, MAX_EXTENSION_UI_TEXT_LENGTH);
  const output: string[] = [];
  let index = 0;
  while (index < source.length) {
    const code = source.charCodeAt(index);

    if (code === 0x1b || code === 0x9d) {
      const isOsc = code === 0x9d || source.charCodeAt(index + 1) === 0x5d;
      if (isOsc) {
        index += code === 0x1b ? 2 : 1;
        while (index < source.length) {
          const current = source.charCodeAt(index);
          if (current === 0x07 || current === 0x9c) {
            index += 1;
            break;
          }
          if (current === 0x1b && source.charCodeAt(index + 1) === 0x5c) {
            index += 2;
            break;
          }
          index += 1;
        }
        continue;
      }

      if (code === 0x1b && source.charCodeAt(index + 1) === 0x5b) {
        index += 2;
        while (index < source.length) {
          const current = source.charCodeAt(index++);
          if (current >= 0x40 && current <= 0x7e) break;
        }
        continue;
      }

      index += 1;
      while (index < source.length) {
        const current = source.charCodeAt(index);
        if (current >= 0x20 && current <= 0x2f) {
          index += 1;
          continue;
        }
        if (current >= 0x30 && current <= 0x7e) index += 1;
        break;
      }
      continue;
    }

    if (code === 0x9b) {
      index += 1;
      while (index < source.length) {
        const current = source.charCodeAt(index++);
        if (current >= 0x40 && current <= 0x7e) break;
      }
      continue;
    }

    if (code === 0x0d) {
      if (source.charCodeAt(index + 1) === 0x0a) output.push("\n");
      index += source.charCodeAt(index + 1) === 0x0a ? 2 : 1;
      continue;
    }
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)) {
      index += 1;
      continue;
    }

    if ((code >= 0x2500 && code <= 0x259f) || code === 0x25ac) {
      let runLength = 0;
      while (index < source.length) {
        const current = source.charCodeAt(index);
        if (!((current >= 0x2500 && current <= 0x259f) || current === 0x25ac)) break;
        runLength += 1;
        index += 1;
      }
      // A maximal progress/decoration run becomes a readable bar capped at 32 cells.
      output.push("#".repeat(Math.min(runLength, 32)));
      continue;
    }

    output.push(source[index]!);
    index += 1;
  }
  return output.join("");
}

export class BoundedRequestIdTombstones {
  private readonly ids = new Set<string>();

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    if (this.ids.has(id)) return;
    if (this.ids.size === EXTENSION_UI_TOMBSTONE_CAPACITY) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    this.ids.add(id);
  }
}

/**
 * Candidate values a client may have supplied for one elicitation field.
 *
 * Clients place accepted content in `content`, in `_meta`, or in `_meta.content`,
 * and some place it directly on the response, so every source is inspected in
 * that precedence order.
 */
export function acceptedElicitationValues(
  response: CreateElicitationResponse | null,
  field: string,
  aliases: readonly string[] = [],
): BoundaryValue[] {
  if (!response || response.action !== "accept") return [];
  const responseValue: BoundaryValue = response;
  if (!isBoundaryRecord(responseValue)) return [];
  const content = recordField(responseValue, "content");
  const meta = recordField(responseValue, "_meta");
  const metaContent = meta === undefined ? undefined : recordField(meta, "content");
  const keys = [field, ...aliases];
  const values: BoundaryValue[] = [];
  for (const source of [content, meta, metaContent, responseValue]) {
    if (!source) continue;
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined) values.push(value);
    }
  }
  return values;
}

export function extensionUiTimeoutMs(ev: PiExtensionUiRequestEvent): number {
  const value = ev.timeoutMs;
  return value !== undefined && value > 0
    ? Math.min(value, EXTENSION_UI_TIMEOUT_MS)
    : EXTENSION_UI_TIMEOUT_MS;
}

export function extensionUiMessage(ev: PiExtensionUiRequestEvent): string {
  const title = sanitizeExtensionUiText(ev.title ?? "").trim();
  const message = sanitizeExtensionUiText(ev.message ?? "").trim();
  if (title && message && title !== message) return `${title}\n\n${message}`;
  return title || message || "Pi requests input";
}

/**
 * The form field's label. The request's title is already the form's message
 * (`extensionUiMessage`, the one text ACP requires), and Zed draws both, so
 * the field gets a generic word for its kind instead; none when that word is
 * the message itself.
 */
export function extensionUiFieldTitle(label: string, message: string): { title?: string } {
  return label === message ? {} : { title: label };
}

export function extensionUiTitle(ev: PiExtensionUiRequestEvent): string | undefined {
  for (const candidate of [ev.title, ev.value, ev.text]) {
    const value = sanitizeExtensionUiText(candidate ?? "").trim();
    if (value) return value.slice(0, MAX_EXTENSION_UI_FALLBACK_LENGTH);
  }
  return undefined;
}

export function isSensitiveUiRequest(ev: PiExtensionUiRequestEvent): boolean {
  // Only a request that collects a reply (select, confirm, input, editor) or an unknown
  // method can be a credential prompt. Display-only methods are never inspected.
  if (ev.method !== undefined && DISPLAY_ONLY_UI_METHODS.has(ev.method)) return false;
  const parts: string[] = [ev.method ?? ""];
  for (const value of [ev.title, ev.message, ev.placeholder]) {
    if (value !== undefined) parts.push(value);
  }
  return SENSITIVE_UI_REQUEST.test(parts.join(" "));
}

/** One extension UI option list, bounded in both entry count and entry length. */
export function boundedExtensionUiOptions(options: BoundaryValue[], maxLength: number): string[] {
  return options
    .slice(0, 100)
    .map((item) => sanitizeExtensionUiText(String(item).slice(0, maxLength)));
}

/**
 * Sanitize and bound every renderable field of an extension UI request.
 *
 * `maxLength` bounds each individual string; `EXTENSION_UI_RAW_INPUT_KEYS` records
 * the published field set this mirrors.
 */
export function extensionUiRawInput(
  ev: PiExtensionUiRequestEvent,
  maxLength: number,
): ExtensionUiRawInput {
  const rawInput: ExtensionUiRawInput = {
    method: sanitizeExtensionUiText(ev.method ?? "ui"),
  };
  if (ev.title !== undefined) {
    rawInput.title = sanitizeExtensionUiText(ev.title.slice(0, maxLength));
  }
  if (ev.message !== undefined) {
    rawInput.message = sanitizeExtensionUiText(ev.message.slice(0, maxLength));
  }
  if (ev.options !== undefined) {
    rawInput.options = boundedExtensionUiOptions(ev.options, maxLength);
  }
  if (ev.placeholder !== undefined) {
    rawInput.placeholder = sanitizeExtensionUiText(ev.placeholder.slice(0, maxLength));
  }
  if (ev.prefill !== undefined) {
    rawInput.prefill = sanitizeExtensionUiText(ev.prefill.slice(0, maxLength));
  }
  return rawInput;
}

export function boundedExtensionUiRawInput(ev: PiExtensionUiRequestEvent): ExtensionUiRawInput {
  return extensionUiRawInput(ev, MAX_EXTENSION_UI_FALLBACK_LENGTH);
}

export function extensionUiFallbackMessage(ev: PiExtensionUiRequestEvent): string {
  const method = sanitizeExtensionUiText(ev.method ?? "unknown");
  const detail = extensionUiMessage(ev).slice(0, MAX_EXTENSION_UI_FALLBACK_LENGTH);
  return `Pi ${method} UI request is not supported; cancelling it. Open a Terminal Thread to use the interactive Pi UI. ${detail}`;
}

export function extensionUiToolCall(
  id: string,
  ev: PiExtensionUiRequestEvent,
): ExtensionUiToolCall {
  const method = sanitizeExtensionUiText(ev.method ?? "ui");
  const title = sanitizeExtensionUiText(ev.title ?? `Pi ${method}`);
  const rawInput = extensionUiRawInput(ev, MAX_EXTENSION_UI_TEXT_LENGTH);
  rawInput.method = method;

  return {
    toolCallId: `pi-ui-${id}`,
    title,
    kind: "other",
    status: "pending",
    rawInput,
  };
}

export function boundedExtensionUiString(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  return value === undefined ? undefined : sanitizeExtensionUiText(value.slice(0, maxLength));
}

export function optionIndex(optionId: string): number | null {
  if (!optionId.startsWith(CHOICE_OPTION_PREFIX)) {
    return null;
  }

  const rawIndex = optionId.slice(CHOICE_OPTION_PREFIX.length);
  if (!rawIndex) {
    return null;
  }

  const index = Number(rawIndex);
  return Number.isSafeInteger(index) && index >= 0 && String(index) === rawIndex ? index : null;
}

/** The session state and output channel an extension UI bridge reads and writes. */
export type ExtensionUiHost = {
  readonly sessionId: string;
  readonly conn: AcpConnection;
  readonly proc: PiRpcProcessLike;
  /** Shared with the session, which clears it when extension UI closes. */
  readonly pendingExtensionUi: Map<string, PendingExtensionUi>;
  readonly settledExtensionUi: BoundedRequestIdTombstones;
  /** Whether the session still accepts extension UI requests. */
  isActive(): boolean;
  /** The session's current extension UI generation; closing bumps it. */
  generation(): number;
  emit(update: SessionUpdate): void;
};

/**
 * Answers one session's Pi extension UI requests through ACP: elicitation forms when the
 * client supports them, permission prompts otherwise, and display-only updates for the rest.
 */
export class ExtensionUiBridge {
  private readonly host: ExtensionUiHost;

  constructor(host: ExtensionUiHost) {
    this.host = host;
  }

  async handleExtensionUiRequest(ev: PiExtensionUiRequestEvent): Promise<void> {
    const id = ev.id;
    const method = ev.method;
    if (
      !id ||
      !this.host.isActive() ||
      this.host.pendingExtensionUi.has(id) ||
      this.host.settledExtensionUi.has(id)
    ) {
      return;
    }

    const generation = this.host.generation();
    const timeoutMs = extensionUiTimeoutMs(ev);
    const timer = setTimeout(() => {
      void this.settleExtensionUi(id, generation, { id, cancelled: true });
    }, timeoutMs);
    timer.unref?.();
    let release!: () => void;
    const cancelled = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });
    this.host.pendingExtensionUi.set(id, { generation, timer, cancelled, release });

    try {
      if (isSensitiveUiRequest(ev)) {
        this.host.emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: SENSITIVE_UI_REQUEST_WARNING } satisfies ContentBlock,
          // Marks the adapter's own warning; extension text can repeat its words, not this.
          _meta: { piAcp: { sensitiveUiRequest: true } },
        });
        await this.settleExtensionUi(id, generation, { id, cancelled: true });
        return;
      }

      if (method === "select") {
        await this.handleExtensionSelect(ev, id, generation);
        return;
      }

      if (method === "confirm") {
        await this.handleExtensionConfirm(ev, id, generation);
        return;
      }

      if (method === "input" || method === "editor") {
        await this.handleExtensionText(ev, id, generation, method);
        return;
      }

      if (method === "notify") {
        // A validated envelope renders as native diffs; a malformed one is dropped with a
        // one-line error. Either way it is display-only, like every other notification.
        if (ev.message?.startsWith(NATIVE_DIFF_NOTIFY_PREFIX)) {
          this.emitNativeDiff(ev.message);
          await this.settleExtensionUi(id, generation, { id, cancelled: true });
          return;
        }
        this.host.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: sanitizeExtensionUiText(ev.message ?? "Pi notification"),
          } satisfies ContentBlock,
          _meta: {
            piAcp: {
              notify: {
                level: sanitizeExtensionUiText(ev.notifyType ?? "info"),
              },
            },
          },
        });
        await this.settleExtensionUi(id, generation, { id, cancelled: true });
        return;
      }

      if (method === "setTitle") {
        const title = extensionUiTitle(ev);
        const update: SessionInfoNotification = {
          sessionUpdate: "session_info_update",
          _meta: { piAcp: { extensionUi: boundedExtensionUiRawInput(ev) } },
        };
        // An empty or unusable title must leave the client's current title untouched.
        if (title) update.title = title;
        this.host.emit(update);
        await this.settleExtensionUi(id, generation, { id, cancelled: true });
        return;
      }

      if (method === "setStatus" || method === "setWidget") {
        this.host.emit({
          sessionUpdate: "session_info_update",
          _meta: { piAcp: { extensionUi: boundedExtensionUiRawInput(ev) } },
        });
        await this.settleExtensionUi(id, generation, { id, cancelled: true });
        return;
      }

      this.emitExtensionUiMessage(extensionUiFallbackMessage(ev));
      await this.settleExtensionUi(id, generation, { id, cancelled: true });
    } catch {
      await this.settleExtensionUi(id, generation, { id, cancelled: true });
    }
  }

  private async handleExtensionSelect(
    ev: PiExtensionUiRequestEvent,
    id: string,
    generation: number,
  ): Promise<void> {
    const rawOptions = ev.options ?? [];
    const options = rawOptions
      .slice(0, 100)
      .map((option) => String(option).slice(0, MAX_EXTENSION_UI_TEXT_LENGTH));
    const displayOptions = options.map(sanitizeExtensionUiText);
    if (!options.length) {
      await this.settleExtensionUi(id, generation, { id, cancelled: true });
      return;
    }

    if (this.host.conn.unstable_createElicitation === undefined) {
      const permissionOptions: PermissionOption[] = displayOptions.map((name, index) => ({
        optionId: `${CHOICE_OPTION_PREFIX}${index}`,
        name,
        kind: "allow_once",
      }));
      const selected = await this.requestLegacyExtensionPermission(
        id,
        generation,
        ev,
        permissionOptions,
      );
      if (!this.isCurrentExtensionUi(id, generation)) return;
      const selectedOptionId =
        selected?.outcome.outcome === "selected" ? selected.outcome.optionId : null;
      const index = selectedOptionId === null ? null : optionIndex(selectedOptionId);
      const value = index === null ? null : (options.at(index) ?? null);
      await this.settleExtensionUi(
        id,
        generation,
        value === null ? { id, cancelled: true } : { id, value },
      );
      return;
    }

    const message = extensionUiMessage(ev);
    const response = await this.requestExtensionPermission(id, generation, {
      mode: "form",
      sessionId: this.host.sessionId,
      message,
      requestedSchema: {
        type: "object",
        properties: {
          value: {
            type: "string",
            ...extensionUiFieldTitle("Choose one", message),
            oneOf: displayOptions.map((title, index) => ({
              const: `${CHOICE_OPTION_PREFIX}${index}`,
              title,
            })),
          },
        },
        required: ["value"],
      },
    });
    if (!this.isCurrentExtensionUi(id, generation)) return;
    let selectedIndex: number | undefined;
    for (const candidate of acceptedElicitationValues(response, "value", ["optionId"])) {
      if (!isString(candidate)) continue;
      const indexed = optionIndex(candidate);
      const displayIndex = displayOptions.indexOf(candidate);
      const index = indexed ?? (displayIndex >= 0 ? displayIndex : options.indexOf(candidate));
      if (index >= 0 && index < options.length) {
        selectedIndex = index;
        break;
      }
    }
    const value = selectedIndex === undefined ? null : (options[selectedIndex] ?? null);
    await this.settleExtensionUi(
      id,
      generation,
      value === null ? { id, cancelled: true } : { id, value },
    );
  }

  private async handleExtensionConfirm(
    ev: PiExtensionUiRequestEvent,
    id: string,
    generation: number,
  ): Promise<void> {
    if (this.host.conn.unstable_createElicitation === undefined) {
      const selected = await this.requestLegacyExtensionPermission(
        id,
        generation,
        ev,
        CONFIRM_PERMISSION_OPTIONS,
      );
      if (!this.isCurrentExtensionUi(id, generation)) return;
      await this.settleExtensionUi(
        id,
        generation,
        selected?.outcome.outcome === "selected"
          ? { id, confirmed: selected.outcome.optionId === "yes" }
          : { id, cancelled: true },
      );
      return;
    }

    const message = extensionUiMessage(ev);
    const response = await this.requestExtensionPermission(id, generation, {
      mode: "form",
      sessionId: this.host.sessionId,
      message,
      requestedSchema: {
        type: "object",
        properties: {
          confirmed: {
            type: "boolean",
            ...extensionUiFieldTitle("Confirm", message),
          },
        },
        required: ["confirmed"],
      },
    });
    if (!this.isCurrentExtensionUi(id, generation)) return;
    const confirmed = acceptedElicitationValues(response, "confirmed").find(isBoolean);
    await this.settleExtensionUi(
      id,
      generation,
      confirmed === undefined ? { id, cancelled: true } : { id, confirmed },
    );
  }

  private async requestExtensionPermission(
    id: string,
    generation: number,
    request: CreateElicitationRequest,
  ): Promise<CreateElicitationResponse | null> {
    const pending = this.host.pendingExtensionUi.get(id);
    if (!pending || pending.generation !== generation) return null;
    const conn = this.host.conn;
    const createElicitation = conn.unstable_createElicitation;
    if (createElicitation === undefined) return null;
    const cancelled = pending.cancelled;
    try {
      return await Promise.race([createElicitation.call(conn, request), cancelled]);
    } catch {
      return null;
    }
  }

  private async requestLegacyExtensionPermission(
    id: string,
    generation: number,
    ev: PiExtensionUiRequestEvent,
    options: PermissionOption[],
  ): Promise<PermissionResponse | null> {
    const pending = this.host.pendingExtensionUi.get(id);
    if (!pending || pending.generation !== generation) return null;
    const conn = this.host.conn;
    const sessionId = this.host.sessionId;
    const toolCall = extensionUiToolCall(id, ev);
    const cancelled = pending.cancelled;
    try {
      return await Promise.race([
        conn.requestPermission({ sessionId, toolCall, options }),
        cancelled,
      ]);
    } catch {
      return null;
    }
  }

  private async handleExtensionText(
    ev: PiExtensionUiRequestEvent,
    id: string,
    generation: number,
    method: "input" | "editor",
  ): Promise<void> {
    if (this.host.conn.unstable_createElicitation === undefined) {
      this.emitExtensionUiMessage(
        `Pi ${method} UI request is not supported in ACP yet; cancelling it.`,
      );
      await this.settleExtensionUi(id, generation, { id, cancelled: true });
      return;
    }

    const message = extensionUiMessage(ev);
    const response = await this.requestExtensionPermission(id, generation, {
      mode: "form",
      sessionId: this.host.sessionId,
      message,
      requestedSchema: {
        type: "object",
        properties: {
          value: {
            type: "string",
            ...extensionUiFieldTitle(method === "editor" ? "Edit text" : "Your answer", message),
            description: boundedExtensionUiString(ev.placeholder, MAX_EXTENSION_UI_TEXT_LENGTH),
            default: boundedExtensionUiString(ev.prefill, MAX_EXTENSION_UI_TEXT_LENGTH),
            maxLength: MAX_EXTENSION_UI_TEXT_LENGTH,
            _meta: method === "editor" ? { piAcp: { multiline: true } } : undefined,
          },
        },
        required: ["value"],
      },
    });
    if (!this.isCurrentExtensionUi(id, generation)) return;
    const value = acceptedElicitationValues(response, "value").find(isString);
    await this.settleExtensionUi(
      id,
      generation,
      value === undefined
        ? { id, cancelled: true }
        : { id, value: value.slice(0, MAX_EXTENSION_UI_TEXT_LENGTH) },
    );
  }

  private isCurrentExtensionUi(id: string, generation: number): boolean {
    const pending = this.host.pendingExtensionUi.get(id);
    return (
      this.host.isActive() &&
      this.host.generation() === generation &&
      pending?.generation === generation
    );
  }

  private async settleExtensionUi(
    id: string,
    generation: number,
    response: ExtensionUiResponse,
  ): Promise<void> {
    const pending = this.host.pendingExtensionUi.get(id);
    if (!pending || pending.generation !== generation) return;
    this.host.pendingExtensionUi.delete(id);
    this.host.settledExtensionUi.add(id);
    clearTimeout(pending.timer);
    pending.release();
    const proc = this.host.proc;
    try {
      await proc.sendExtensionUiResponse?.(response);
    } catch {
      // A disconnected subprocess cannot receive the response; do not retry it.
    }
  }

  private emitExtensionUiMessage(text: string): void {
    this.host.emit({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: sanitizeExtensionUiText(text) } satisfies ContentBlock,
    });
  }

  /**
   * Render choco-pi's `/diff` notification as a display-only, already completed tool
   * call carrying native ACP diff content. Pi has no matching tool call or session
   * entry, so the model's context and the persisted transcript are unchanged.
   */
  private emitNativeDiff(message: string): void {
    const presentation = decodeNativeDiff(message);
    if (!presentation) {
      this.emitExtensionUiMessage(
        "The /diff presentation from Pi was malformed and was not shown.",
      );
      return;
    }
    const { content, locations } = nativeDiffContent(presentation, sanitizeExtensionUiText);
    this.host.emit({
      sessionUpdate: "tool_call",
      toolCallId: `choco-pi-diff-${crypto.randomUUID()}`,
      title: sanitizeExtensionUiText(presentation.title),
      kind: "read",
      status: "completed",
      content,
      locations,
      _meta: { piAcp: { nativeDiff: { displayOnly: true } } },
    });
  }
}
