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
