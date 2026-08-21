import { isFunctionValue, isStringValue } from "./protocol-values.ts";

/**
 * The slice of the host theme the footer status needs.
 *
 * Kept in its own module so it loads under Node's strip-only TypeScript mode
 * and can be tested without the extension runtime. `fg` is optional because
 * the theme reaches this code through the owned-UI fence and through host
 * objects whose members are resolved at call time.
 */
export interface StatusTextTheme {
  fg?(color: string, text: string): string;
}

/**
 * Colour footer status text with the accent colour, returning the plain text
 * whenever the host cannot supply a colour. The footer status is decoration:
 * a theme that is missing, fenced off, or unable to resolve the colour must
 * still leave the caller with something to display.
 */
export function formatAccentStatusText(theme: StatusTextTheme | undefined, text: string): string {
  const fg = theme?.fg;
  if (!isFunctionValue(fg)) return text;
  try {
    const colored = fg.call(theme, "accent", text);
    return isStringValue(colored) && colored !== "" ? colored : text;
  } catch {
    return text;
  }
}

/**
 * The slice of the host UI a footer status write touches.
 *
 * `theme` is optional and reached only while writing: the host owns both
 * members, and both are read through the owned-UI fence at call time.
 */
export interface StatusWriterUi {
  theme?: StatusTextTheme;
  setStatus(key: string, content: string | undefined): void;
}

/** Receive an error the host raised while accepting a status write. */
export type StatusWriteFailureReporter = <BoundaryValue>(error: BoundaryValue) => void;

/**
 * Run a status write against the host UI and hand any failure to the reporter.
 *
 * The guard covers exactly the host interaction — resolving a member on the UI
 * object and the call itself — because that is the part this package does not
 * control. Deciding *what* to display is ordinary logic over local state, so it
 * stays outside: a throw from there is a defect here and must stay loud.
 */
function guardStatusWrite(write: () => void, reportFailure: StatusWriteFailureReporter): void {
  try {
    write();
  } catch (error) {
    reportFailure(error);
  }
}

/** Write already-formatted footer status text. Never throws. */
export function writeStatus(
  ui: StatusWriterUi,
  key: string,
  content: string | undefined,
  reportFailure: StatusWriteFailureReporter,
): void {
  guardStatusWrite(() => ui.setStatus(key, content), reportFailure);
}

/**
 * Write footer status text coloured with the host accent colour. Never throws.
 *
 * The theme read happens inside the guard: the host exposes it as a property
 * whose resolution can fail on its own, before `formatAccentStatusText` ever
 * sees a value.
 */
export function writeAccentStatus(
  ui: StatusWriterUi,
  key: string,
  text: string,
  reportFailure: StatusWriteFailureReporter,
): void {
  guardStatusWrite(() => ui.setStatus(key, formatAccentStatusText(ui.theme, text)), reportFailure);
}

/**
 * How many distinct status-write failures are remembered before the record is
 * dropped and reporting starts over. A host that refuses status writes usually
 * refuses them the same way every time, so the bound only exists to keep a
 * message carrying varying detail from growing the record without limit.
 */
const STATUS_FAILURE_MEMORY = 16;

/**
 * Build a reporter that logs each distinct status-write failure once.
 *
 * `updateStatusBar` runs on every server state change, so an unusable host UI
 * would otherwise repeat the same warning for the whole session and bury the
 * events worth reading. `describe` turns the error into the reported message,
 * which doubles as the identity of the failure.
 */
export function createStatusWriteFailureReporter(
  describe: <BoundaryValue>(error: BoundaryValue) => string,
  report: (message: string) => void,
): StatusWriteFailureReporter {
  const reported = new Set<string>();
  return (error) => {
    const message = describe(error);
    if (reported.has(message)) return;
    if (reported.size >= STATUS_FAILURE_MEMORY) reported.clear();
    reported.add(message);
    report(message);
  };
}
