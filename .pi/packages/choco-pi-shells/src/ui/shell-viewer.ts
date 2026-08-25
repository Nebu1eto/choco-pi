import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  matchesKey,
  stripTerminalSequences,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import type {
  ShellStreamChunk,
  ShellSummary,
  ShellsManager,
  ShellViewerKeybindings,
} from "./shells-overlay.ts";

const POLL_MS = 200;
const DRAIN_POLL_MS = 10;
const READ_BYTES = 262_144;
export const SHELL_VIEWER_MAX_LINES = 2_000;
export const SHELL_VIEWER_MAX_CHARS = 262_144;
const TERMINAL_ESCAPE_PATTERN = new RegExp(
  String.raw`\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*?(?:\u0007|\u001B\\)|[PX^_][\s\S]*?\u001B\\|[@-_])`,
  "g",
);

type StreamName = "stdout" | "stderr";

interface StreamState {
  lines: string[];
  partial: string;
  retainedChars: number;
  hasOutput: boolean;
  truncated: boolean;
  cursor: number | undefined;
  endOffset: number;
  dropped: boolean;
  scroll: number;
  follow: boolean;
}

interface ViewerStreams {
  stdout: StreamState;
  stderr: StreamState;
}

function detachedTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, delay);
  timer.unref?.();
  return timer;
}

function duration(shell: ShellSummary): string {
  const milliseconds = Math.max(0, (shell.endedAt ?? Date.now()) - shell.startedAt);
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

export function sanitizeShellText(line: string): string {
  const stripped = stripTerminalSequences(line).replace(TERMINAL_ESCAPE_PATTERN, "");
  let visible = "";
  for (const character of stripped) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x20 && !(code >= 0x7f && code <= 0x9f)) visible += character;
  }
  return visible;
}

export class ShellOutputViewer implements Component {
  private stream: StreamName = "stdout";
  private streams: ViewerStreams = {
    stdout: {
      lines: [],
      partial: "",
      retainedChars: 0,
      hasOutput: false,
      truncated: false,
      cursor: undefined,
      endOffset: 0,
      dropped: false,
      scroll: 0,
      follow: true,
    },
    stderr: {
      lines: [],
      partial: "",
      retainedChars: 0,
      hasOutput: false,
      truncated: false,
      cursor: undefined,
      endOffset: 0,
      dropped: false,
      scroll: 0,
      follow: true,
    },
  };
  private shell: ShellSummary;
  private stopArmed = false;
  private closed = false;
  private evicted = false;
  private readNotice: string | undefined;
  private actionNotice: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling = false;
  private viewportRows = 3;

  private tui: TUI;
  private manager: ShellsManager;
  private requesterId: string;
  private theme: Theme;
  private done: (result: undefined) => void;
  private keybindings: ShellViewerKeybindings | undefined;

  constructor(
    tui: TUI,
    manager: ShellsManager,
    requesterId: string,
    shell: ShellSummary,
    theme: Theme,
    done: (result: undefined) => void,
    keybindings?: ShellViewerKeybindings,
  ) {
    this.tui = tui;
    this.manager = manager;
    this.requesterId = requesterId;
    this.shell = shell;
    this.theme = theme;
    this.done = done;
    this.keybindings = keybindings;
    this.poll();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.close();
      return;
    }
    if (matchesKey(data, "tab")) {
      this.stopArmed = false;
      this.stream = this.stream === "stdout" ? "stderr" : "stdout";
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "x")) {
      if (this.shell.state !== "running") return;
      if (!this.stopArmed) {
        this.stopArmed = true;
        this.tui.requestRender();
        return;
      }
      this.stopArmed = false;
      void this.manager
        .stop({ requesterId: this.requesterId, isAdmin: true, shellId: this.shell.shellId })
        .then((shell) => {
          this.shell = shell;
          this.actionNotice = undefined;
        })
        .catch((error) => {
          this.actionNotice = `Stop failed: ${error instanceof Error ? error.message : String(error)}`;
        })
        .finally(() => this.tui.requestRender());
      return;
    }
    if (this.stopArmed) this.stopArmed = false;

    const state = this.streams[this.stream];
    const lines = this.contentLines(state);
    const maxScroll = Math.max(0, lines.length - this.viewportRows);
    const up = this.key("tui.select.up", "up", data) || matchesKey(data, "k");
    const down = this.key("tui.select.down", "down", data) || matchesKey(data, "j");
    if (up) {
      state.scroll = Math.max(0, state.scroll - 1);
      state.follow = false;
    } else if (down) {
      state.scroll = Math.min(maxScroll, state.scroll + 1);
      state.follow = state.scroll >= maxScroll;
    } else if (this.key("tui.select.pageUp", "pageUp", data) || matchesKey(data, "shift+up")) {
      state.scroll = Math.max(0, state.scroll - this.viewportRows);
      state.follow = false;
    } else if (
      this.key("tui.select.pageDown", "pageDown", data) ||
      matchesKey(data, "shift+down")
    ) {
      state.scroll = Math.min(maxScroll, state.scroll + this.viewportRows);
      state.follow = state.scroll >= maxScroll;
    } else if (matchesKey(data, "home")) {
      state.scroll = 0;
      state.follow = false;
    } else if (matchesKey(data, "end")) {
      state.scroll = maxScroll;
      state.follow = true;
    } else {
      return;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width < 8) return [];
    const inner = width - 4;
    const state = this.streams[this.stream];
    const content = this.contentLines(state);
    const notice = this.actionNotice ?? this.readNotice;
    this.viewportRows = Math.max(
      3,
      Math.floor((this.tui.terminal.rows * 70) / 100) - (notice || this.evicted ? 8 : 7),
    );
    const maxScroll = Math.max(0, content.length - this.viewportRows);
    if (state.follow) state.scroll = maxScroll;
    state.scroll = Math.min(state.scroll, maxScroll);

    const lines = [this.theme.fg("border", `╭${"─".repeat(width - 2)}╮`)];
    const name = sanitizeShellText(this.shell.name ?? this.shell.shellId);
    const pid = this.shell.pid === undefined ? "pid —" : `pid ${this.shell.pid}`;
    const exit = this.shell.exitCode === undefined ? "" : ` · exit ${this.shell.exitCode}`;
    lines.push(
      this.row(`${this.shell.state} · ${name} · ${pid}${exit} · ${duration(this.shell)}`, inner),
    );
    lines.push(
      this.row(
        `${this.stream === "stdout" ? this.theme.fg("accent", "stdout") : "stdout"}  ${this.stream === "stderr" ? this.theme.fg("accent", "stderr") : "stderr"}`,
        inner,
      ),
    );
    lines.push(this.row(this.theme.fg("dim", "─".repeat(inner)), inner));
    for (let index = 0; index < this.viewportRows; index++) {
      lines.push(this.row(content[state.scroll + index] ?? "", inner));
    }
    if (this.evicted)
      lines.push(this.row(this.theme.fg("warning", "Shell record evicted; output frozen."), inner));
    else if (notice) lines.push(this.row(this.theme.fg("error", notice), inner));
    lines.push(this.row(this.theme.fg("dim", "─".repeat(inner)), inner));
    let stop = "";
    if (this.shell.state === "running") {
      stop = this.stopArmed ? this.theme.fg("error", "x again to STOP") : "x stop";
    }
    lines.push(
      this.row(
        [
          stop,
          `Tab ${this.stream === "stdout" ? "stderr" : "stdout"}`,
          "↑↓/kj · PgUp/PgDn · End follow · Esc/q back",
        ]
          .filter(Boolean)
          .join(" · "),
        inner,
      ),
    );
    lines.push(this.theme.fg("border", `╰${"─".repeat(width - 2)}╯`));
    return lines;
  }

  invalidate(): void {}

  dispose(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private poll(): void {
    if (this.closed || this.evicted || this.polling) return;
    const previousStdoutCursor = this.streams.stdout.cursor;
    const previousStderrCursor = this.streams.stderr.cursor;
    this.polling = true;
    try {
      const result = this.manager.read({
        requesterId: this.requesterId,
        isAdmin: true,
        shellId: this.shell.shellId,
        stdoutOffset: this.streams.stdout.cursor,
        stderrOffset: this.streams.stderr.cursor,
        maxBytes: READ_BYTES,
      });
      this.shell = result.shell;
      this.append("stdout", result.stdout);
      this.append("stderr", result.stderr);
      this.readNotice = undefined;
      this.tui.requestRender();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not found|unknown shell|missing/i.test(message)) {
        this.evicted = true;
      } else {
        this.readNotice = `Read failed: ${message}`;
      }
      this.tui.requestRender();
    } finally {
      this.polling = false;
    }
    const hasUnread = Object.values(this.streams).some(
      (state) => state.cursor !== undefined && state.cursor < state.endOffset,
    );
    const madeProgress =
      this.streams.stdout.cursor !== previousStdoutCursor ||
      this.streams.stderr.cursor !== previousStderrCursor;
    if (!this.closed && !this.evicted && (hasUnread || this.shell.state === "running")) {
      this.timer = detachedTimeout(
        () => {
          this.timer = undefined;
          this.poll();
        },
        hasUnread && madeProgress ? DRAIN_POLL_MS : POLL_MS,
      );
    }
  }

  private append(stream: StreamName, chunk: ShellStreamChunk): void {
    const state = this.streams[stream];
    if (chunk.dropped) state.dropped = true;
    state.cursor = chunk.nextOffset;
    state.endOffset = chunk.endOffset;
    if (chunk.data.length === 0) return;

    state.hasOutput = true;
    const text = state.partial + chunk.data;
    state.retainedChars -= state.partial.length;
    state.partial = "";

    let start = 0;
    for (;;) {
      const newline = text.indexOf("\n", start);
      if (newline < 0) break;
      this.retainLine(state, sanitizeShellText(text.slice(start, newline)));
      start = newline + 1;
    }
    state.partial = text.slice(start);
    if (state.partial.length > SHELL_VIEWER_MAX_CHARS) {
      state.partial = state.partial.slice(-SHELL_VIEWER_MAX_CHARS);
      state.truncated = true;
    }
    state.retainedChars += state.partial.length;
    this.trimRetained(state);
  }

  private contentLines(state: StreamState): string[] {
    const lines = state.hasOutput
      ? [...state.lines, sanitizeShellText(state.partial)]
      : [this.theme.fg("dim", "(no output)")];
    if (state.truncated)
      lines.unshift(this.theme.fg("warning", "[earlier output omitted from viewer]"));
    if (state.dropped)
      lines.unshift(this.theme.fg("warning", "[earlier output dropped from buffer]"));
    return lines;
  }

  private retainLine(state: StreamState, line: string): void {
    const retained =
      line.length > SHELL_VIEWER_MAX_CHARS ? line.slice(-SHELL_VIEWER_MAX_CHARS) : line;
    if (retained.length !== line.length) state.truncated = true;
    state.lines.push(retained);
    state.retainedChars += retained.length;
  }

  private trimRetained(state: StreamState): void {
    let remove = 0;
    while (
      remove < state.lines.length &&
      (state.lines.length - remove > SHELL_VIEWER_MAX_LINES ||
        state.retainedChars > SHELL_VIEWER_MAX_CHARS)
    ) {
      state.retainedChars -= state.lines[remove]?.length ?? 0;
      remove += 1;
    }
    if (remove === 0) return;
    state.lines.splice(0, remove);
    state.scroll = Math.max(0, state.scroll - remove);
    state.truncated = true;
  }

  private key(
    id: "tui.select.up" | "tui.select.down" | "tui.select.pageUp" | "tui.select.pageDown",
    fallback: "up" | "down" | "pageUp" | "pageDown",
    data: string,
  ): boolean {
    return this.keybindings ? this.keybindings.matches(data, id) : matchesKey(data, fallback);
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.done(undefined);
  }

  private row(content: string, inner: number): string {
    const clipped = truncateToWidth(content, inner, "…", true);
    return `${this.theme.fg("border", "│")} ${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))} ${this.theme.fg("border", "│")}`;
  }
}
