import { arr, bool, int, lit, num, obj, opt, str, union } from "@earendil-works/pi-schema";

import { compactDescription, stringEnum, type SchemaDescribe } from "../json-schema.ts";
import { hostParams } from "../schema-bridge.ts";
import {
  ELECTRON_DISCOVERY_DEFAULT_MAX_RESULTS,
  ELECTRON_DISCOVERY_MAX_RESULTS,
} from "../electron/discovery-constants.ts";
import { AGENT_BROWSER_SCRIPT_CODE_MAX_BYTES } from "./schema-constants.ts";
import {
  AGENT_BROWSER_ELECTRON_HANDOFFS,
  AGENT_BROWSER_ELECTRON_TARGET_TYPES,
  AGENT_BROWSER_JOB_STEP_ACTIONS,
  AGENT_BROWSER_JOB_TYPE_DELAYED_TEXT_MAX_CHARACTERS,
  AGENT_BROWSER_QA_LOAD_STATES,
  AGENT_BROWSER_SEMANTIC_ACTIONS,
  AGENT_BROWSER_SEMANTIC_LOCATORS,
  DEFAULT_SESSION_MODE,
  SOURCE_LOOKUP_MAX_WORKSPACE_FILES,
} from "./types.ts";

// Keep descriptions terse: Pi sends this schema every turn; workflows belong in prompt guidance and docs.

export function createAgentBrowserParamsSchema(describe: SchemaDescribe = compactDescription) {
  return obj(
    {
      script: opt(
        str({
          ...describe(
            "One-shot JavaScript orchestration with async browser({ args, stdin?, timeoutMs? }) and emit(value); isolated session and no host access.",
          ),
          maxLength: AGENT_BROWSER_SCRIPT_CODE_MAX_BYTES,
        }),
      ),
      args: opt(
        arr(str(), {
          ...describe(
            "Raw agent-browser argv only: no binary, shell operators, or --json. Start with open → snapshot -i → act on current @refs; re-snapshot after page changes.",
          ),
          minItems: 1,
        }),
      ),
      semanticAction: opt(
        obj(
          {
            action: stringEnum(AGENT_BROWSER_SEMANTIC_ACTIONS),
            locator: opt(
              stringEnum(AGENT_BROWSER_SEMANTIC_LOCATORS, {
                ...describe("Locator for check/click/fill; select supports role or label."),
              }),
            ),
            value: opt(
              str({
                ...describe(
                  "Locator value or one select option; for select by label, this is the label text.",
                ),
              }),
            ),
            values: opt(
              arr(str(), {
                ...describe("Select options; required for select by label."),
                minItems: 1,
              }),
            ),
            selector: opt(str({ ...describe("Direct selector or @ref.") })),
            text: opt(str({ ...describe("Fill text.") })),
            role: opt(str({ ...describe("Role locator; alternative to value.") })),
            name: opt(str({ ...describe("Accessible name.") })),
            session: opt(str({ ...describe("Upstream session name.") })),
          },
          { ...describe("Stable locator or direct-selector action.") },
        ),
      ),
      qa: opt(
        union(
          [
            obj({
              attached: lit(true),
              expectedText: opt(union([str(), arr(str())])),
              expectedSelector: opt(str()),
              screenshotPath: opt(str()),
              checkConsole: opt(bool()),
              checkErrors: opt(bool()),
              checkNetwork: opt(bool()),
              loadState: opt(stringEnum(AGENT_BROWSER_QA_LOAD_STATES)),
            }),
            obj({
              url: str(),
              attached: opt(lit(false)),
              expectedText: opt(union([str(), arr(str())])),
              expectedSelector: opt(str()),
              screenshotPath: opt(str()),
              checkConsole: opt(bool()),
              checkErrors: opt(bool()),
              checkNetwork: opt(bool()),
              loadState: opt(stringEnum(AGENT_BROWSER_QA_LOAD_STATES)),
            }),
          ],
          {
            ...describe(
              "QA a URL or current session (attached=true). Default readiness: domcontentloaded; use networkidle only without long-lived requests. URL diagnostics default on, attached diagnostics off.",
            ),
          },
        ),
      ),
      sourceLookup: opt(
        obj(
          {
            selector: opt(str({ ...describe("Visible selector or @ref.") })),
            reactFiberId: opt(
              str({ ...describe("React fiber id; requires --enable react-devtools.") }),
            ),
            componentName: opt(str({ ...describe("Component for local source search.") })),
            includeDomHints: opt(bool({ ...describe("Inspect DOM source hints; default true.") })),
            maxWorkspaceFiles: opt(
              num({
                ...describe("Source scan cap; default 2000."),
                minimum: 1,
                maximum: SOURCE_LOOKUP_MAX_WORKSPACE_FILES,
              }),
            ),
          },
          {
            ...describe("EXPERIMENTAL UI-to-source candidates; not guaranteed mappings."),
          },
        ),
      ),
      networkSourceLookup: opt(
        obj(
          {
            filter: opt(str({ ...describe("Network request filter.") })),
            namespace: opt(str()),
            requestId: opt(str({ ...describe("Request id to inspect.") })),
            session: opt(str()),
            url: opt(str({ ...describe("Failed URL or fragment.") })),
            maxWorkspaceFiles: opt(
              num({
                ...describe("Source scan cap; default 2000."),
                minimum: 1,
                maximum: SOURCE_LOOKUP_MAX_WORKSPACE_FILES,
              }),
            ),
          },
          {
            ...describe("EXPERIMENTAL failed-request-to-source candidates; not proof."),
          },
        ),
      ),
      electron: opt(
        union(
          [
            obj({
              action: stringEnum(["list"] as const),
              query: opt(str({ ...describe("Case-insensitive app filter."), minLength: 1 })),
              maxResults: opt(
                int({
                  ...describe(
                    `Result cap; default ${ELECTRON_DISCOVERY_DEFAULT_MAX_RESULTS}, values over ${ELECTRON_DISCOVERY_MAX_RESULTS} are clamped.`,
                  ),
                  minimum: 1,
                }),
              ),
            }),
            obj({
              action: stringEnum(["launch"] as const),
              appPath: opt(str({ ...describe("macOS .app path."), minLength: 1 })),
              appName: opt(str({ ...describe("Name from electron.list."), minLength: 1 })),
              bundleId: opt(str({ ...describe("Bundle id from electron.list."), minLength: 1 })),
              executablePath: opt(str({ ...describe("Executable path."), minLength: 1 })),
              appArgs: opt(arr(str({ minLength: 1 }))),
              handoff: opt(stringEnum(AGENT_BROWSER_ELECTRON_HANDOFFS)),
              targetType: opt(stringEnum(AGENT_BROWSER_ELECTRON_TARGET_TYPES)),
              timeoutMs: opt(int({ minimum: 1 })),
              allow: opt(arr(str({ minLength: 1 }))),
              deny: opt(arr(str({ minLength: 1 }))),
            }),
            obj({
              action: stringEnum(["status", "cleanup"] as const),
              launchId: str({ ...describe("Tracked launch id."), minLength: 1 }),
              timeoutMs: opt(int({ minimum: 1 })),
            }),
            obj({
              action: stringEnum(["status", "cleanup"] as const),
              all: lit(true),
              timeoutMs: opt(int({ minimum: 1 })),
            }),
            obj({
              action: stringEnum(["status", "cleanup"] as const),
              timeoutMs: opt(int({ minimum: 1 })),
            }),
            obj({
              action: stringEnum(["probe"] as const),
              launchId: opt(str({ ...describe("Tracked launch id."), minLength: 1 })),
              timeoutMs: opt(int({ minimum: 1 })),
            }),
          ],
          {
            ...describe(
              "Electron discovery, isolated-profile launch, status, probe, or cleanup. Launch defaults: handoff=snapshot, targetType=page; deny wins over allow; lifecycle/debug appArgs rejected.",
            ),
          },
        ),
      ),
      job: opt(
        obj(
          {
            failFast: opt(bool({ ...describe("Stop on first failure; default true.") })),
            steps: arr(
              obj({
                action: stringEnum(AGENT_BROWSER_JOB_STEP_ACTIONS),
                url: opt(str({ ...describe("Open URL or assertUrl glob.") })),
                loadState: opt(
                  stringEnum(AGENT_BROWSER_QA_LOAD_STATES, {
                    ...describe("Readiness wait after open."),
                  }),
                ),
                selector: opt(str({ ...describe("Selector or @ref.") })),
                locator: opt(
                  stringEnum(AGENT_BROWSER_SEMANTIC_LOCATORS, {
                    ...describe("Locator when selector is omitted."),
                  }),
                ),
                role: opt(str({ ...describe("Role locator.") })),
                name: opt(str({ ...describe("Accessible name.") })),
                text: opt(str({ ...describe("Fill text or assertText target.") })),
                value: opt(str({ ...describe("Select option or locator value.") })),
                values: opt(arr(str(), { ...describe("Select options."), minItems: 1 })),
                path: opt(str({ ...describe("Download or screenshot path.") })),
                delayMs: opt(
                  int({
                    ...describe(
                      `Per-character type delay; text is capped at ${AGENT_BROWSER_JOB_TYPE_DELAYED_TEXT_MAX_CHARACTERS} characters.`,
                    ),
                    minimum: 1,
                  }),
                ),
                press: opt(str({ ...describe("Key for press, or to press after typing.") })),
                milliseconds: opt(num({ ...describe("Wait duration in milliseconds.") })),
              }),
              { minItems: 1 },
            ),
          },
          { ...describe("Constrained multi-step batch.") },
        ),
      ),
      stdin: opt(
        str({
          ...describe(
            "Raw stdin for batch, eval --stdin, or auth save --password-stdin; unavailable with structured modes and electron.",
          ),
        }),
      ),
      outputPath: opt(
        str({
          ...describe(
            "Workspace-relative or absolute result-data path; keep it distinct from screenshot, download, recording, and other browser artifact destinations.",
          ),
          minLength: 1,
        }),
      ),
      timeoutMs: opt(
        int({
          ...describe(
            "Wrapper timeout in ms; exceed explicit waits. Electron uses electron.timeoutMs.",
          ),
          minimum: 1,
        }),
      ),
      sessionMode: opt(
        stringEnum(["auto", "fresh"] as const, {
          ...describe(
            "auto reuses the managed session; fresh starts one for launch-only flags, then makes it the managed session.",
          ),
          default: DEFAULT_SESSION_MODE,
        }),
      ),
    },
    {
      ...describe(
        "Choose one input mode: script, args, semanticAction, job, qa, sourceLookup, networkSourceLookup, or electron.",
      ),
    },
  );
}

export const AGENT_BROWSER_PARAMS = createAgentBrowserParamsSchema();

/** Registration form: Pi 1.5.1 still requires a TypeBox-shaped parameter schema. */
export const AGENT_BROWSER_HOST_PARAMS = hostParams(AGENT_BROWSER_PARAMS);
