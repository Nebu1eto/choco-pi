/**
 * choco-pi's startup header and startup-detail policy.
 *
 * The header replaces Pi's: the choco-pi logo drawn in half blocks, the
 * choco-pi and Pi versions, the key hints, and a one-line description. It
 * shows wherever Pi would show its own header, so `quietStartup: true` still
 * hides it and `--verbose` still forces it.
 *
 * Pi prints the model scope and the loaded-resource listing (`[Context]`,
 * `[Skills]`, ...) whenever `quietStartup` is `false`, its default, and it
 * decides that inside `InteractiveMode` before any `session_start` handler
 * runs. No extension API reaches that decision, so this module patches the
 * host's `shouldShowStartupDetails` to answer only `--verbose`. Diagnostics
 * such as skill collisions still show: Pi renders them even when quiet.
 */
import { readFile } from "node:fs/promises";
import {
  InteractiveMode,
  VERSION,
  keyHint,
  keyText,
  rawKeyHint,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { compile, obj, str } from "@earendil-works/pi-schema";
import {
  backgroundAnsi,
  foregroundAnsi,
  isAppleTerminalSession,
  rgbColor,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type RgbColorValue,
  type TerminalColorMode,
} from "@earendil-works/pi-tui";
import { isFunction, reinterpretHostValue, type RuntimeValue } from "./lib/runtime-values.ts";

export const CHOCO_PI_DESCRIPTION = "choco-pi is an opinionated coding agent harness built on Pi.";

const ROOT_MANIFEST_URL = new URL("../../package.json", import.meta.url);
const isVersionedManifest = compile(obj({ version: str() }, { open: true })).check;

/** The checkout's own version from its root `package.json`, or undefined when unreadable. */
export async function readHarnessVersion(
  manifestUrl: URL = ROOT_MANIFEST_URL,
): Promise<string | undefined> {
  let parsed: RuntimeValue;
  try {
    parsed = reinterpretHostValue<RuntimeValue>(JSON.parse(await readFile(manifestUrl, "utf8")));
  } catch {
    return undefined;
  }
  return isVersionedManifest(parsed) && parsed.version.length > 0 ? parsed.version : undefined;
}

/** `v<choco-pi> (pi v<pi>)`, or just the Pi part when the choco-pi version is unknown. */
export function versionLabel(harnessVersion: string | undefined, piVersion: string): string {
  return harnessVersion === undefined
    ? `(pi v${piVersion})`
    : `v${harnessVersion} (pi v${piVersion})`;
}

/**
 * The logo as square pixels, two per terminal cell (upper and lower half
 * block): a chocolate dome with a drizzle and a highlight, drips over the cake,
 * a cream layer, and the dark base. `.` is transparent.
 */
const LOGO_PIXELS = [
  "....BBBBBB....",
  "..BBWBBHHHBB..",
  ".BBBBHHHBBBHB.",
  "BBBBBBBBBBBBBB",
  "BYBYYYBYYYYBYB",
  "BCCCCCCCCCCCCB",
  "BYYYYYYYYYYYYB",
  ".DDDDDDDDDDDD.",
];

/** Brand colors from `assets/choco-pi-logo.svg`; fixed across themes like Pi's own logo. */
const LOGO_COLORS = {
  B: rgbColor(107, 53, 25),
  D: rgbColor(82, 40, 18),
  H: rgbColor(142, 81, 48),
  W: rgbColor(200, 170, 150),
  Y: rgbColor(234, 176, 74),
  C: rgbColor(255, 248, 234),
} satisfies Record<string, RgbColorValue>;

function isLogoPixel(code: string): code is keyof typeof LOGO_COLORS {
  return Object.hasOwn(LOGO_COLORS, code);
}

function pixelColor(code: string | undefined): RgbColorValue | undefined {
  return code !== undefined && isLogoPixel(code) ? LOGO_COLORS[code] : undefined;
}

/** The theme methods the header uses; Pi passes its live theme. */
export type HeaderTheme = Pick<Theme, "fg" | "bold" | "getColorMode">;

const RESET = "\u001b[0m";

/** The logo's terminal lines, each `LOGO_WIDTH` cells wide. */
export function logoLines(mode: TerminalColorMode): string[] {
  const lines: string[] = [];
  for (let row = 0; row < LOGO_PIXELS.length; row += 2) {
    const upper = LOGO_PIXELS[row] ?? "";
    const lower = LOGO_PIXELS[row + 1] ?? "";
    let line = "";
    for (let column = 0; column < upper.length; column += 1) {
      const top = pixelColor(upper[column]);
      const bottom = pixelColor(lower[column]);
      if (top === undefined)
        line += bottom === undefined ? " " : `${foregroundAnsi(bottom, mode)}▄${RESET}`;
      else if (bottom === undefined) line += `${foregroundAnsi(top, mode)}▀${RESET}`;
      else if (top === bottom) line += `${foregroundAnsi(top, mode)}█${RESET}`;
      else line += `${foregroundAnsi(top, mode)}${backgroundAnsi(bottom, mode)}▀${RESET}`;
    }
    lines.push(line);
  }
  return lines;
}

export const LOGO_WIDTH = LOGO_PIXELS[0]?.length ?? 0;

/** Pi's startup key hints: compact (one group of segments) or expanded (one hint per line). */
function keyHints(theme: HeaderTheme, expanded: boolean): HeaderLine[] {
  if (!expanded) {
    return [
      {
        segments: [
          keyHint("app.interrupt", "interrupt"),
          rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
          rawKeyHint("/", "commands"),
          rawKeyHint("!", "bash"),
          keyHint("app.tools.expand", "more"),
        ],
        separator: theme.fg("muted", " · "),
      },
    ];
  }
  return [
    keyHint("app.interrupt", "to interrupt"),
    keyHint("app.clear", "to clear"),
    rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
    keyHint("app.exit", "to exit (empty)"),
    keyHint("app.suspend", "to suspend"),
    keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
    keyHint("app.thinking.cycle", "to cycle thinking level"),
    rawKeyHint(
      `${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`,
      "to cycle models",
    ),
    keyHint("app.model.select", "to select model"),
    keyHint("app.tools.expand", "to expand tools"),
    keyHint("app.thinking.toggle", "to expand thinking"),
    keyHint("app.editor.external", "for external editor"),
    rawKeyHint("/", "for commands"),
    rawKeyHint("!", "to run bash"),
    rawKeyHint("!!", "to run bash (no context)"),
    keyHint("app.message.followUp", "to queue follow-up"),
    keyHint("app.message.dequeue", "to edit all queued messages"),
    keyHint("app.clipboard.pasteImage", "to paste files on macOS, images, or text"),
    rawKeyHint("drop files", "to attach"),
  ].map(plain);
}

export interface StartupHeaderContent {
  /** Logo lines; empty where the terminal cannot draw half blocks. */
  logo: readonly string[];
  /** Text lines; the first holds the versions. */
  lines: readonly HeaderLine[];
}

/**
 * Segments joined by `separator` that wrap only between segments, so a key
 * hint never splits across rows; a segment wider than the column still wraps.
 */
export interface HeaderLine {
  segments: readonly string[];
  separator: string;
}

function plain(text: string): HeaderLine {
  return { segments: [text], separator: "" };
}

/** The header's left and right margin, matching Pi's own header. */
const MARGIN = 1;
/** The gap between the logo and the text column. */
const GAP = 1;
/** Below this text-column width the logo is dropped so the text stays readable. */
export const MIN_TEXT_COLUMN = 30;

/** The text column's width beside the logo at terminal `width`. */
export function textColumnWidth(width: number, withLogo: boolean): number {
  return width - 2 * MARGIN - (withLogo ? LOGO_WIDTH + GAP : 0);
}

/** Whether the logo fits at terminal `width` with a readable text column beside it. */
export function logoFits(width: number): boolean {
  return textColumnWidth(width, true) >= MIN_TEXT_COLUMN;
}

/** Wraps one header line to `width` cells. */
function wrapLine(line: HeaderLine, width: number): string[] {
  const rows: string[] = [];
  let current = "";
  for (const segment of line.segments) {
    const joined = current === "" ? segment : `${current}${line.separator}${segment}`;
    if (current !== "" && visibleWidth(joined) > width) {
      rows.push(current);
      current = segment;
    } else current = joined;
  }
  if (current !== "") rows.push(current);
  if (rows.length === 0) return [""];
  return rows.flatMap((row) => (visibleWidth(row) > width ? wrapTextWithAnsi(row, width) : [row]));
}

/**
 * Lays the header out at terminal `width`: text wrapped inside its column
 * beside the logo, rows past the logo indented to the column, and every row
 * at most `width` cells, so Pi never re-wraps a row and splits the logo.
 */
export function layoutHeader(content: StartupHeaderContent, width: number): string[] {
  const withLogo = content.logo.length > 0;
  const column = Math.max(1, textColumnWidth(width, withLogo));
  const text = content.lines.flatMap((line) => wrapLine(line, column));
  const margin = " ".repeat(MARGIN);
  const indent = withLogo ? " ".repeat(LOGO_WIDTH + GAP) : "";
  const rows = Math.max(content.logo.length, text.length);
  const out: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    const logo = content.logo[row];
    const line = text[row] ?? "";
    const left = logo === undefined ? indent : `${logo}${" ".repeat(GAP)}`;
    const composed = line === "" ? (logo ?? "") : `${left}${line}`;
    out.push(composed === "" ? "" : truncateToWidth(`${margin}${composed}`, width));
  }
  return out;
}

export function startupHeaderContent(
  theme: HeaderTheme,
  options: { expanded: boolean; harnessVersion: string | undefined; showLogo: boolean },
): StartupHeaderContent {
  const versions = theme.fg("dim", versionLabel(options.harnessVersion, VERSION));
  const first = options.showLogo ? versions : `${theme.bold("choco-pi")} ${versions}`;
  const description = theme.fg("dim", CHOCO_PI_DESCRIPTION);
  const lines: HeaderLine[] = options.expanded
    ? [plain(first), ...keyHints(theme, true), plain(""), plain(description)]
    : [
        plain(first),
        ...keyHints(theme, false),
        plain(theme.fg("dim", `Press ${keyText("app.tools.expand")} to show full startup help.`)),
        plain(description),
      ];
  return { logo: options.showLogo ? logoLines(theme.getColorMode()) : [], lines };
}

/**
 * The header component; laid out on every render so it follows theme and
 * width changes. The logo shows only where the terminal can draw it and the
 * width leaves a readable text column beside it.
 */
export class StartupHeader implements Component {
  private readonly theme: HeaderTheme;
  private readonly harnessVersion: string | undefined;
  private readonly showLogo: boolean;
  private expanded = false;

  constructor(theme: HeaderTheme, harnessVersion: string | undefined, showLogo: boolean) {
    this.theme = theme;
    this.harnessVersion = harnessVersion;
    this.showLogo = showLogo;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const content = startupHeaderContent(this.theme, {
      expanded: this.expanded,
      harnessVersion: this.harnessVersion,
      showLogo: this.showLogo && logoFits(width),
    });
    return layoutHeader(content, width);
  }
}

/**
 * Process-wide patch state on `globalThis`: `/reload` re-imports this module
 * while the patched prototype keeps running.
 */
const STARTUP_POLICY = Symbol.for("choco-pi.startup-policy");

interface StartupPolicy {
  /** Whether the host decided to show its startup header; unset until it decides. */
  headerShown?: boolean;
}

type HostPredicate = (this: RuntimeValue) => RuntimeValue;

function verboseHost(host: RuntimeValue): boolean {
  if (host === undefined || host === null) return false;
  const options = reinterpretHostValue<Record<string, RuntimeValue>>(host)["options"];
  if (options === undefined || options === null) return false;
  return reinterpretHostValue<Record<string, RuntimeValue>>(options)["verbose"] === true;
}

/**
 * Hide Pi's startup details unless `--verbose`, and record whether the host
 * shows its header. Idempotent; leaves the host alone when its methods moved.
 */
export function installStartupPolicy(
  prototype: Record<PropertyKey, RuntimeValue> = reinterpretHostValue<
    Record<PropertyKey, RuntimeValue>
  >(InteractiveMode.prototype),
  store: Record<PropertyKey, RuntimeValue> = reinterpretHostValue<
    Record<PropertyKey, RuntimeValue>
  >(globalThis),
): StartupPolicy {
  const existing = store[STARTUP_POLICY];
  if (existing !== undefined && existing !== null)
    return reinterpretHostValue<StartupPolicy>(existing);
  const policy: StartupPolicy = {};
  const showHeader = prototype["shouldShowStartupHeader"];
  const showDetails = prototype["shouldShowStartupDetails"];
  if (!isFunction(showHeader) || !isFunction(showDetails)) return policy;
  Object.defineProperty(store, STARTUP_POLICY, {
    configurable: true,
    writable: true,
    value: policy,
  });

  const originalShowHeader = reinterpretHostValue<HostPredicate>(showHeader);
  prototype["shouldShowStartupHeader"] = function patchedShouldShowStartupHeader(
    this: RuntimeValue,
  ): boolean {
    const shown = originalShowHeader.call(this) === true;
    policy.headerShown = shown;
    return shown;
  };
  prototype["shouldShowStartupDetails"] = function patchedShouldShowStartupDetails(
    this: RuntimeValue,
  ): boolean {
    return verboseHost(this);
  };
  return policy;
}

export default async function startupHeader(pi: ExtensionAPI): Promise<void> {
  const policy = installStartupPolicy();
  const harnessVersion = await readHarnessVersion();
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || policy.headerShown !== true) return;
    const showLogo = !isAppleTerminalSession();
    ctx.ui.setHeader((_tui, theme) => new StartupHeader(theme, harnessVersion, showLogo));
  });
}
