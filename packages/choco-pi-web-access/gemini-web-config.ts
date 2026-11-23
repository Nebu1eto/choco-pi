import { getCachedWebSearchConfig } from "./config-loader.ts";

export function isBrowserCookieAccessAllowed(): boolean {
  if (
    process.env.PI_ALLOW_BROWSER_COOKIES === "1" ||
    process.env.FEYNMAN_ALLOW_BROWSER_COOKIES === "1"
  ) {
    return true;
  }
  return getCachedWebSearchConfig().allowBrowserCookies === true;
}
