import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  matchesKey,
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
const READ_BYTES = 262_144;

type StreamName = "stdout" | "stderr";

interface StreamState {
  text: string;
  cursor: number | undefined;
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

export class ShellOutputViewer implements Component {
  private stream: StreamName = "stdout";
  private streams: ViewerStreams = {
    stdout: { text: "", cursor: undefined, dropped: false, scroll: 0, follow: true },
    stderr: { text: "", cursor: undefined, dropped: false, scroll: 0, follow: true },
  };
  private shell: ShellSummary;
  private stopArmed = false;
  private closed = false;
  private evicted = false;
  private notice: string | undefined;
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
          this.notice = undefined;
        })
        .catch((error) => {
          this.notice = `Stop failed: ${error instanceof Error ? error.message : String(error)}`;
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
    this.viewportRows = Math.max(
      3,
      Math.floor((this.tui.terminal.rows * 70) / 100) - (this.notice || this.evicted ? 7 : 6),
    );
    const maxScroll = Math.max(0, content.length - this.viewportRows);
    if (state.follow) state.scroll = maxScroll;
    state.scroll = Math.min(state.scroll, maxScroll);

    const lines = [this.theme.fg("border", `╭${"─".repeat(width - 2)}╮`)];
    const name = this.shell.name ?? this.shell.shellId;
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
    else if (this.notice) lines.push(this.row(this.theme.fg("error", this.notice), inner));
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
      this.notice = undefined;
      this.tui.requestRender();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not found|unknown shell|missing/i.test(message)) {
        this.evicted = true;
      } else {
        this.notice = `Read failed: ${message}`;
      }
      this.tui.requestRender();
    } finally {
      this.polling = false;
    }
    if (!this.closed && !this.evicted && this.shell.state === "running") {
      this.timer = detachedTimeout(() => {
        this.timer = undefined;
        this.poll();
      }, POLL_MS);
    }
  }

  private append(stream: StreamName, chunk: ShellStreamChunk): void {
    const state = this.streams[stream];
    if (chunk.dropped) state.dropped = true;
    state.text += chunk.data;
    state.cursor = chunk.nextOffset;
  }

  private contentLines(state: StreamState): string[] {
    const lines =
      state.text.length === 0 ? [this.theme.fg("dim", "(no output)")] : state.text.split("\n");
    if (state.dropped)
      return [this.theme.fg("warning", "[earlier output dropped from buffer]"), ...lines];
    return lines;
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
