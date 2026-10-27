# choco-pi-computer-use

Vendored, private fork of [`@injaneity/pi-computer-use`](https://github.com/injaneity/pi-computer-use) for the choco-pi harness. It keeps the upstream tool names and TypeScript source layout, and pi loads `extensions/computer-use.ts` directly without a build step.

## Platform support

This fork supports native helper installation on macOS only. The Linux and Windows TypeScript backends remain for dispatch compatibility, but their native helpers, prebuilts, and build paths are not included.

No helper binaries are tracked. `scripts/setup-helper.mjs` compiles `native/macos/{agent_cursor,agent_cursor_motion,bridge}.swift` for the host architecture with `xcrun swiftc -target <arm64|x86_64>-apple-macosx14.0 -O` into a scratch directory under the system temporary directory, then wraps, signs, and registers the app bundle. At runtime, a UI session setup or tool operation checks the helper; if it is missing, `src/platform/macos/helper.ts` launches the script.

### Installing

- Requires the Xcode Command Line Tools (or Xcode), which provide `xcrun swiftc`; install them with `xcode-select --install`. Without `swiftc`, the script fails and says so.
- A build takes tens of seconds (about 13 s on Apple silicon with a cold module cache). Compiler warnings are printed and do not fail the build.
- The bundle's `Contents/Resources/source.sha256` is `helperSourceHash` from `src/platform/macos/helper-source.mjs`: sha256 over the scheme tag, the architecture, and each compiled Swift source's relative path, byte length, and contents. When it and `Info.plist` match, the script skips the build and leaves the installed helper unchanged.
- `--arch arm64|x64` overrides the host architecture. Cross-compilation (x64 on Apple silicon or the reverse) is untested.
- `--build-only --out <dir>` writes `<dir>/bridge` and installs, signs, and registers nothing.

The installer may modify `/Applications` or `~/Applications`, register the app with LaunchServices, and codesign it. Do not run it during static validation.

## Helper protocol and test environment

The TypeScript client requires helper protocol 7: request cancellation, cross-process session ownership, and native enforcement of the foreground grant. The Swift sources implement protocol 7. A daemon that reports another protocol is shut down and relaunched once. The daemon outlives Pi and reinstalls, so it is also relaunched once when it runs from another executable path, reports no `startedAt` (a helper built before that field existed), or started before the installed executable's last modification (a same-protocol rebuild); the error names the reason if the relaunched daemon is still stale. Cancelling a browser tool call stops the remaining actions in its batch and releases any pressed key or mouse button.

- `PI_CU_SOCKET_PATH` points the client at another helper socket. With it set, the client never installs or launches the helper app.
- `PI_COMPUTER_USE_HELPER_APP_PATH` overrides the helper app bundle whose executable `diagnostics.executablePath` must match.
- `tests/helpers/fake-helper-daemon.ts` serves the protocol without touching Accessibility, screen capture, or input: `node --experimental-strip-types tests/helpers/fake-helper-daemon.ts --socket <path> --script <s1-ok|s2-foreground-required|s3-didnt|s4-slow-type|s5-stale|s6-grant|s7-ownership> [--log <requests.jsonl>] [--executable-path <path>] [--protocol-version <n>] [--started-at <epoch-seconds|none>]`. Tests import `startFakeHelperDaemon` from the same file.

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

## Action results

`act_ui` validates every action before it sends any. An invalid action (a stale ref, coordinates outside the image, a scroll without target, keyboard x/y, headless keyboard input without ref, and so on) rejects the call before delivery, and the stateId stays usable. In a multi-action call the error is prefixed `act_ui action N (<action>):` and ends with `Nothing was sent.`

When an action fails during delivery after earlier actions ran, the result has `details.status: "partial"` and a fresh successor state. `execution.steps` lists the delivered actions and the failed one (with request ids), `execution.stoppedAt` is the failed action's index, and `execution.error` carries the helper's code, message, and `effectPossible`. Focus is restored as after a complete call. A failure of the first action still rejects the call. A cancellation or ownership refusal after earlier actions ran reports them in `execution.steps` with the transaction index in `stoppedAt`; focus is not restored while the helper may still be sending. Any result after which the UI may have changed (a partial call, a cancellation after delivery, or a refusal that followed delivered actions or may itself have taken effect) invalidates the base stateId.

See `VENDORED.md` for provenance and fork divergences.
