import { spawn } from "node:child_process";
import https from "node:https";

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
      resolve(false);
      return;
    }
    proc.on("exit", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}
