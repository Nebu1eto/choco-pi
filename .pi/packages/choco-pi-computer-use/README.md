# choco-pi-computer-use

Vendored, private fork of [`@injaneity/pi-computer-use`](https://github.com/injaneity/pi-computer-use) for the choco-pi harness. It keeps the upstream tool names and TypeScript source layout, and pi loads `extensions/computer-use.ts` directly without a build step.

## Platform support

This fork supports native helper installation on macOS only. The Linux and Windows TypeScript backends remain for dispatch compatibility, but their native helpers, prebuilts, and build paths are not included.

The arm64 and x64 macOS helper binaries are committed under `prebuilt/macos/`. At runtime, a UI session setup or tool operation checks the helper. If it is missing, `src/platform/macos/helper.ts` launches `scripts/setup-helper.mjs`, which installs the matching binary as an app bundle. Set `PI_COMPUTER_USE_ALLOW_BUILD=1` to permit the retained Swift-source fallback.

The installer may modify `/Applications` or `~/Applications`, register the app with LaunchServices, and codesign it. Do not run it during static validation.

## Helper protocol and test environment

The TypeScript client requires helper protocol 7: request cancellation, cross-process session ownership, and native enforcement of the foreground grant. The committed prebuilts report protocol 7. A daemon that reports another protocol is shut down and relaunched once. Cancelling a browser tool call stops the remaining actions in its batch and releases any pressed key or mouse button.

- `PI_CU_SOCKET_PATH` points the client at another helper socket. With it set, the client never installs or launches the helper app.
- `PI_COMPUTER_USE_HELPER_APP_PATH` overrides the helper app bundle whose executable `diagnostics.executablePath` must match.
- `tests/helpers/fake-helper-daemon.ts` serves the protocol without touching Accessibility, screen capture, or input: `node --experimental-strip-types tests/helpers/fake-helper-daemon.ts --socket <path> --script <s1-ok|s2-foreground-required|s3-didnt|s4-slow-type|s5-stale|s6-grant|s7-ownership> [--log <requests.jsonl>] [--executable-path <path>] [--protocol-version <n>]`. Tests import `startFakeHelperDaemon` from the same file.

## Foreground grants

Input goes to the target app in the background. Pointer input that has no accessibility route (a click on a native element without `AXPress`, or a coordinate click, scroll, or drag) is first posted to the app's process without activating it or moving the cursor. The helper then watches a settle window of at most about 400 ms for a change: the element's value and selection, the focused window, sheets, the onscreen windows, the frontmost app, and, with Screen Recording, the target window's pixels (a downsampled capture compared with one taken just before the input). If it sees a change, the action succeeds as `pid_pointer` delivery (`evidence.pixelChange: true` when only the pixels changed). If not, it is refused with `foreground_required` and the evidence `pidPointerAttempted: true`, `observableChange: false`, and `pixelCheck` (`compared` or `unavailable`). Other actions that need focus (pointer input on web content, some keyboard input) are refused before any delivery. A refused action needs the user to grant foreground delivery for that app. No tool parameter can grant it. Grants come from:

- `foreground_grant` (bundle IDs or `"*"`) in `~/.pi/agent/extensions/pi-computer-use.json` or `<cwd>/.pi/computer-use.json`, or `PI_COMPUTER_USE_FOREGROUND_GRANT`. File edits apply on the next tool call.
- Session grants, decided by `foreground_prompt` (`PI_COMPUTER_USE_FOREGROUND_PROMPT`) when the helper refused a background attempt and either proved nothing was delivered or saw no change after a background pointer attempt:
  - `ask` (default): in an interactive TUI session, Pi asks once per app per session: **Allow for this session**, **Always allow (saves to user config)**, or **Not now**. "Always allow" also appends the bundle ID to `foreground_grant` in the user file and keeps every other key; if saving fails, the grant still applies for the session and Pi says so. "Not now" stops further prompts for that app this session. Other host modes are never prompted.
  - `always`: explicit opt-in to full approval. The app is granted for the session without a dialog, in every host mode, even after an earlier "Not now".
  - `off`: never prompts.

After a grant, a refusal that proved nothing was delivered is retried once in the foreground. The trace records `escalationReason`: `foreground_required` (a file, env, or earlier session grant), `user_grant` (the dialog), or `auto_grant` (`always`).

A refusal after a background pointer attempt is never retried in the same call, whatever the grant, dialog answer, or `always` says: the input already reached the app, and a change the helper could not see would otherwise happen twice. The grant is still recorded (and "Always allow" still saved). The result carries `details.nextStep: "observe_then_retry"`, `refusal.grantedForNextCall`, and `execution.retryDeferred`, and tells the model to call `observe_ui` before acting again. With a grant, the next pointer-only click, coordinate click or scroll, or drag on that app goes to the foreground directly, without a background attempt first.

With `restore_focus` (`PI_COMPUTER_USE_RESTORE_FOCUS`, default `true`), after an `act_ui` call that delivered granted foreground input and left the target frontmost, the helper's `restoreUserFocus` gives focus back to the app that was frontmost before. It is skipped when the target was already frontmost or you switched to another app, and its result (`focusRestored`, `focusRestoreReason`) never changes the act outcome.

`/computer-use` shows the settings, sources, and this session's grants and denials. `/computer-use grant ask|always|off` sets the prompt mode for the session and saves it to the user file.

See `VENDORED.md` for provenance and fork divergences.
