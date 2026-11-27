import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageUrl = new URL("../", import.meta.url).href;
const extractUrl = new URL("../extract.ts", import.meta.url).href;

const childScript = `
import { registerHooks } from "node:module";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const packageUrl = ${JSON.stringify(packageUrl)};
const extractUrl = ${JSON.stringify(extractUrl)};
const configPath = join(process.env.PI_CODING_AGENT_DIR, "web-search.json");
let generation = 0;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (
      generation === 0 ||
      !resolved.url.startsWith(packageUrl) ||
      resolved.url.includes("/node_modules/")
    ) {
      return resolved;
    }
    return { ...resolved, url: resolved.url.split("?")[0] + "?reload=" + generation };
  },
});

await writeFile(configPath, "{}");
generation = 1;
const first = await import(extractUrl);
const firstScope = first.getWebAccessScope();
const firstHttp = firstScope.getFetchTransport("http");
const firstKagiAvailable = await firstScope.getFetchTransport("kagi").available();
const thirdPartyTransport = {
  id: "third-party",
  hosted: false,
  available: () => true,
  fetch: async () => null,
};
const thirdPartyExtractor = {
  id: "third-party-extractor",
  priority: 50,
  match: () => false,
  extract: async () => null,
};
first.registerFetchTransport(thirdPartyTransport);
first.registerContentExtractor(thirdPartyExtractor);

await writeFile(configPath, JSON.stringify({ kagiApiKey: "kagi-reloaded" }));
generation = 2;
const second = await import(extractUrl);
const secondScope = second.getWebAccessScope();
console.log(
  JSON.stringify({
    sameScope: secondScope === firstScope,
    firstKagiAvailable,
    secondKagiAvailable: await secondScope.getFetchTransport("kagi").available(),
    httpReplaced: secondScope.getFetchTransport("http") !== firstHttp,
    thirdPartyTransportIntact: secondScope.getFetchTransport("third-party") === thirdPartyTransport,
    thirdPartyExtractorIntact:
      secondScope.extractors.get("third-party-extractor") === thirdPartyExtractor,
    builtinExtractors: ["github", "pdf", "readability", "rsc"].every((id) =>
      secondScope.extractors.has(id),
    ),
  }),
);
`;

test("a reloaded module copy rebinds built-in fetch entries and keeps third-party registrations", async () => {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-fetch-reload-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: root };
    delete env.KAGI_API_KEY;
    delete env.CHOCO_PI_HOME;
    delete env.CHOCO_PI_STANDALONE;
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", childScript],
      { env, encoding: "utf8" },
    );
    assert.deepEqual(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"), {
      sameScope: true,
      firstKagiAvailable: false,
      secondKagiAvailable: true,
      httpReplaced: true,
      thirdPartyTransportIntact: true,
      thirdPartyExtractorIntact: true,
      builtinExtractors: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
