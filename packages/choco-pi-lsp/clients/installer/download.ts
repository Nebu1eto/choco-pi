/**
 * HTTPS download with redirect handling, GitHub API auth headers, and command execution.
 */
import { spawn } from "node:child_process";
import https from "node:https";

// --- Installation Functions

/**
 * Authorization header for the GitHub REST API, when a token is available.
 * Unauthenticated GitHub API is 60 req/hr per IP — exhausted constantly on
 * shared-IP CI runners, which silently fails every github-strategy install.
 * Authenticated is 5000 req/hr. Used ONLY for the `api.github.com` metadata
 * call, never the asset download (see installGitHubTool) — the release CDN must
 * not receive the token.
 */
export function githubApiAuthHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

/**
 * Fetch a URL, following up to `maxRedirects` redirects.
 * Returns the raw Buffer of the response body. Any caller-supplied headers are
 * dropped when a redirect crosses to a different host, so an Authorization
 * header can never leak to a redirect target (e.g. a release CDN).
 */
export function httpsGet(
  url: string,
  maxRedirects = 5,
  headers: Record<string, string> = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "choco-pi-lsp/1.0", ...headers } }, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          if (maxRedirects === 0) return reject(new Error("Too many redirects"));
          const location = res.headers.location;
          const nextHeaders = sameHost(url, location)
            ? headers
            : (() => {
                const { Authorization: _drop, ...rest } = headers;
                return rest;
              })();
          return resolve(httpsGet(location, maxRedirects - 1, nextHeaders));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

/**
 * Run a shell command and return true on exit code 0.
 */
export function runCommand(command: string, args: string[], cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(command, args, {
        cwd,
        stdio: "ignore",
        shell: process.platform === "win32",
      });
    } catch {
      // SYNCHRONOUS spawn throw (Windows `spawn UNKNOWN`/EINVAL, the pidusage
      // bug class, #533) — resolve false rather than reject/crash.
      resolve(false);
      return;
    }
    proc.on("exit", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}
