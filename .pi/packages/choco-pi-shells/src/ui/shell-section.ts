import type {
  ShellSectionProvider,
  ShellSectionRegistration,
  ShellSectionRow,
  ShellViewerHost,
} from "../../../choco-pi-subagents/src/ui/shell-section-contract.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ShellChangeEvent } from "../shell-manager.ts";
import type { ShellsManager, ShellSummary } from "./shells-overlay.ts";
import { sanitizeShellText, ShellOutputViewer } from "./shell-viewer.ts";

const SUBAGENT_MANAGER_KEY = Symbol.for("pi-subagents:manager");
const DEFAULT_LINGER_MS = 4_000;
const MAX_LABEL_LENGTH = 52;
const MAX_COMMAND_LENGTH = 52;
const MAX_OWNER_LENGTH = 32;
const MAX_DETAIL_LENGTH = 80;
const MAX_ERROR_LENGTH = 40;

export interface ShellSectionManager extends ShellsManager {
  onChange(listener: (event: ShellChangeEvent) => void): () => void;
}

interface ShellSectionHost {
  registerShellSection(provider: ShellSectionProvider): ShellSectionRegistration;
}

interface ShellSectionRegistry {
  [key: symbol]: Partial<ShellSectionHost> | undefined;
}

interface DisplayShell {
  shell: ShellSummary;
  settledAt?: number;
}

export function createShellSectionProvider(options: {
  manager: ShellSectionManager;
  rootSessionId: string;
  now?: () => number;
  lingerMs?: number;
}): ShellSectionProvider & { dispose(): void } {
  const { manager, rootSessionId } = options;
  const currentTime = options.now ?? Date.now;
  const lingerMs = options.lingerMs ?? DEFAULT_LINGER_MS;
  const shells = new Map<string, DisplayShell>();
  const listeners = new Set<() => void>();
  let disposed = false;

  for (const shell of manager.list({ requesterId: rootSessionId, isAdmin: true }).shells) {
    if (shell.state === "running") shells.set(shell.shellId, { shell });
  }

  const unsubscribe = manager.onChange((event) => {
    if (disposed) return;
    const previous = shells.get(event.shell.shellId);
    const settledAt =
      event.shell.state === "running" ? undefined : (previous?.settledAt ?? currentTime());
    shells.set(event.shell.shellId, { shell: event.shell, settledAt });
    for (const listener of listeners) listener();
  });

  return {
    rows(now) {
      const rows: ShellSectionRow[] = [];
      for (const [shellId, display] of shells) {
        if (display.settledAt !== undefined && now - display.settledAt >= lingerMs) {
          shells.delete(shellId);
          continue;
        }
        rows.push(toSectionRow(display.shell, rootSessionId));
      }
      return rows;
    },
    onChange(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop(shellId) {
      return manager
        .stop({ requesterId: rootSessionId, isAdmin: true, shellId })
        .then(() => undefined);
    },
    async openViewer(shellId, ui: ShellViewerHost, onOpened) {
      const summary = manager
        .list({ requesterId: rootSessionId, isAdmin: true })
        .shells.find((shell) => shell.shellId === shellId);
      if (!summary) {
        const safeShellId = truncateText(sanitizeShellText(shellId).trim(), MAX_DETAIL_LENGTH);
        throw new Error(`Shell not found: ${safeShellId}`);
      }
      await ui.custom<undefined>(
        (tui, theme, keybindings, done) => {
          // SAFETY: Pi owns ui.custom and supplies its full Theme; the cross-package
          // panel contract intentionally exposes only the rendering methods it uses.
          const viewer = new ShellOutputViewer(
            tui,
            manager,
            rootSessionId,
            summary,
            theme as Theme,
            done,
            keybindings,
          );
          onOpened(() => done(undefined));
          return viewer;
        },
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: "90%", maxHeight: "70%" },
        },
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      listeners.clear();
      shells.clear();
    },
  };
}

export function findShellSectionHost(): ShellSectionHost | undefined {
  // SAFETY: The optional process-global entry is a structural cross-extension seam.
  const entry = (globalThis as typeof globalThis & ShellSectionRegistry)[SUBAGENT_MANAGER_KEY];
  if (!(entry?.registerShellSection instanceof Function)) return undefined;
  return { registerShellSection: entry.registerShellSection };
}

function toSectionRow(shell: ShellSummary, rootSessionId: string): ShellSectionRow {
  const label = shell.name
    ? truncateText(sanitizeShellText(shell.name).trim(), MAX_LABEL_LENGTH)
    : truncateCommand(shell.command);
  const ownerId = truncateText(sanitizeShellText(shell.ownerId).trim(), MAX_OWNER_LENGTH);
  const error = shell.error
    ? truncateText(sanitizeShellText(shell.error), MAX_ERROR_LENGTH)
    : undefined;
  return {
    shellId: shell.shellId,
    label,
    ownerTag: shell.ownerId === rootSessionId ? "" : `[owner:${ownerId}]`,
    state: shell.state,
    pid: shell.pid,
    startedAt: shell.startedAt,
    endedAt: shell.endedAt,
    exitCode: shell.exitCode,
    error,
    command: truncateCommand(shell.command),
    cwd: truncateText(sanitizeShellText(shell.cwd).trim(), MAX_DETAIL_LENGTH),
  };
}

function truncateCommand(command: string): string {
  return truncateText(sanitizeShellText(command).replace(/\s+/g, " ").trim(), MAX_COMMAND_LENGTH);
}

function truncateText(text: string, length: number): string {
  if (text.length <= length) return text;
  return text.slice(0, length - 1) + "…";
}
