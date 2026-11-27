# Set up computer use (macOS)

[한국어](../ko/computer-use.md)

This page covers installing the native helper that the computer-use tools need, granting its macOS permissions, configuring it, and removing it.

The computer-use tools (`observe_ui`, `act_ui`, and related tools) work through a native helper app, `pi-computer-use.app`, which reads accessibility trees, captures windows, and delivers input. The repository contains no helper binary. On every install, the setup script compiles the Swift sources in `packages/choco-pi-computer-use/native/macos` for your Mac's architecture; it downloads nothing. The helper cannot be installed on other operating systems.

## Requirements

- macOS 14 or later
- An interactive Pi session for the first permission grant
- Xcode or the Command Line Tools, which provide `xcrun swiftc` (`xcode-select --install`)

## 1. Install the helper

If `pi-computer-use.app` is missing when an interactive Pi session starts, Pi builds and installs it, which takes tens of seconds. To install it ahead of time, or to reinstall it, run this from the checkout:

```sh
node packages/choco-pi-computer-use/scripts/setup-helper.ts
```

The script prints the path it installed to. It:

- Installs to `~/Applications/pi-computer-use.app`. If `/Applications/pi-computer-use.app` already exists and `/Applications` is writable, it updates that copy in place. To install somewhere else, set `PI_COMPUTER_USE_HELPER_APP_PATH`, and set the same variable for Pi.
- Wraps the binary in an app bundle with the identifier `com.injaneity.pi-computer-use`, code-signs it, and registers it with LaunchServices.
- Signs with the first of these identities that is available:
  1. the identity named in `PI_COMPUTER_USE_CODESIGN_IDENTITY`;
  2. a "Developer ID Application" identity in your keychain;
  3. a self-signed identity named `pi-computer-use Local Signing (com.injaneity.pi-computer-use)`, which the script creates with `openssl` and imports into your login keychain;
  4. an ad-hoc signature. macOS may drop permission grants after an update signed this way.

  `PI_COMPUTER_USE_NO_SIGN=1` skips signing.

- Leaves an installed helper unchanged when it is already current, and only registers it again.

## 2. Grant permissions

The helper needs two macOS permissions: Screen Recording lets the agent see windows, and Accessibility lets it act on them. When either is missing, Pi shows the current status and this menu:

- **Open Accessibility Settings (missing)**
- **Open Screen Recording Settings (missing)**
- **Recheck (restarts helper)**
- **Cancel**

Open each settings pane and turn on `pi-computer-use.app` under System Settings → Privacy & Security, in both Accessibility and Screen Recording. Then choose **Recheck**. Pi restarts the helper, because a running process can hold on to an outdated permission answer, and reports `pi-computer-use is ready.` once both permissions are granted.

Grant the permissions to `pi-computer-use.app`, not to your terminal. If Pi warns that the helper is not running as the installed `pi-computer-use.app`, restart Pi before you grant anything; a grant made while that warning shows would go to the app that launched the helper. In a non-interactive run, such as print mode, setup stops with instructions instead of showing the menu, so grant the permissions once from an interactive session.

## 3. Verify

Run `/computer-use` to see the effective configuration and which configuration files were loaded. Pi checks the permissions again when a session starts and before each computer-use tool call, so a missing grant brings back the menu from step 2.

## Update the helper

- Pi installs the helper only when the app is missing; it never replaces an existing one. After you pull a change under `native/macos`, run the setup script again. The script skips the build when the installed helper was built from the same sources.
- The helper daemon keeps running after Pi exits. When Pi connects, it compares the daemon's protocol version (currently 7), executable path, and start time with the installed app. A daemon older than the installed binary is relaunched once, so a reinstalled helper takes effect on the next tool call without a Pi restart. If the relaunched daemon still does not match, Pi stops with a "helper mismatch after relaunch" error that names the reason; run the setup script again.
- Replacing the helper re-signs the app, and macOS may invalidate earlier grants. If Pi reports a missing permission while its toggle in System Settings is on, turn the toggle off and on again.
- When only ad-hoc signing is available, the script refuses to replace an installed helper, because macOS may reset its permissions. Install a Developer ID identity, or set `PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1` and grant the permissions again.

## Build from source

The script always compiles the helper with `xcrun swiftc` for the host architecture. It prints compiler warnings and carries on. Pass `--arch arm64` or `--arch x64` to cross-compile (untested), or `--build-only --out <dir>` to write `<dir>/bridge` without installing or signing anything.

## Configure computer use

Settings are read from `~/.pi/agent/extensions/pi-computer-use.json`, then from the project's `.pi/computer-use.json`, then from environment variables; a later source overrides an earlier one, except for `blocked_apps` and `unblocked_apps` (see **Blocked apps** below). Neither file exists until you create it. This example shows the default values:

```json
{
  "browser_use": true,
  "managed_browser": "chrome",
  "headless": false,
  "cursor_overlay": true,
  "foreground_grant": [],
  "foreground_prompt": "ask",
  "restore_focus": true,
  "blocked_apps": [],
  "unblocked_apps": []
}
```

| Key                 | Environment variable                                 | Effect                                                                                                                                             |
| ------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_use`       | `PI_COMPUTER_USE_BROWSER_USE`                        | Allows the agent to control browser windows.                                                                                                       |
| `managed_browser`   | `PI_COMPUTER_USE_MANAGED_BROWSER`                    | The browser Pi starts when it needs a managed browser: `chrome` or `helium`.                                                                       |
| `headless`          | `PI_COMPUTER_USE_HEADLESS`                           | Delivers actions through Accessibility only, without pointer or keyboard events.                                                                   |
| `cursor_overlay`    | `PI_COMPUTER_USE_CURSOR_OVERLAY`                     | Shows the agent's cursor on screen while it acts.                                                                                                  |
| `foreground_grant`  | `PI_COMPUTER_USE_FOREGROUND_GRANT` (comma-separated) | Bundle IDs, or `"*"`, of apps the agent may activate, raise, and send keyboard and mouse events to. No tool call can change this list. See below.  |
| `foreground_prompt` | `PI_COMPUTER_USE_FOREGROUND_PROMPT`                  | What happens when an app needs focus and no grant covers it: `ask` (default), `always`, or `off`. See below.                                       |
| `restore_focus`     | `PI_COMPUTER_USE_RESTORE_FOCUS`                      | After granted foreground input takes focus, gives focus back to the app you had in front, unless you have switched to another app in the meantime. |
| `blocked_apps`      | `PI_COMPUTER_USE_BLOCKED_APPS` (comma-separated)     | Bundle IDs of further apps the agent may not observe or operate. Entries from every source add up. See below.                                      |
| `unblocked_apps`    | none; the user file only                             | Bundle IDs to remove from the built-in blocked list. Ignored in the project file and in `PI_COMPUTER_USE_UNBLOCKED_APPS`. See below.               |

**Foreground grants.** Without a grant, input goes to the app in the background. Pointer input that has no accessibility route is first tried in the background: it is sent to the app's process without taking focus, and the helper watches the target for a short settling period. A change at the target itself (its value, its window, or the pixels around it) counts as success. A change only elsewhere in the window is reported as an unverified effect, and the agent is told to confirm it in the returned state. If nothing changes, the action is refused with `foreground_required` and is not sent again in that call. For a granted app, such pointer input goes straight to the foreground. Foreground input is sent only after the helper confirms that the app and its window came to the front; otherwise nothing is sent and the call says so. If the app is no longer in front when a mouse button or key is released, the call stops and says that input may have reached another app.

**Foreground prompt.** `foreground_prompt` applies when an app needs focus and no grant covers it. If the helper confirmed that nothing was delivered, a grant retries the action once in the foreground. If the input was already tried in the background with no visible change, the grant applies to the next call only, and the agent is told to observe the app before it tries again. The values are:

- `ask` (default): in an interactive TUI session, Pi asks once per app per session, offering **Allow for this session**, **Always allow** (which adds the bundle ID to `foreground_grant` in the user file), or **Not now**.
- `always`: an explicit opt-in that lets the agent activate and send input to any app without asking. Each such app stays granted for the rest of the session, in every host mode.
- `off`: never ask; only `foreground_grant` applies.

**Blocked apps.** Computer use never observes or operates some apps, so the agent cannot type into the terminal running Pi or read your passwords outside Pi's shell approval. A blocked app is refused on every tool (`observe_ui`, `search_ui`, `expand_ui`, `inspect_ui`, `read_text`, `wait_for`, `act_ui`) and every delivery path, including Accessibility-only input, before anything is captured or sent. The tool fails with `app_blocked`. `find_roots` still lists the app's windows, marked `BLOCKED` (`blocked: true` and `block_reason` in the details). Browser pages that Pi controls through its managed browser are not affected; a browser app's own windows follow the same rules as any app. Blocked by default:

- The app hosting Pi: any app whose process is Pi's process or one of its parent processes, and the app whose bundle ID macOS passes to Pi in `__CFBundleIdentifier`. Pi looks up its parent processes with `ps`. If that fails, Pi blocks its own process and its direct parent, shows the failure in `/computer-use`, and tries the lookup again on the next tool call. The helper also looks up Pi's parent processes itself and refuses all of them, so the app hosting Pi stays blocked while Pi's own lookup fails.
- Terminals: Terminal (`com.apple.Terminal`), iTerm2 (`com.googlecode.iterm2`), Warp (`dev.warp.Warp-Stable`), kitty (`net.kovidgoyal.kitty`, `net.kovidgoyal.kitty-quick-access`), Ghostty (`com.mitchellh.ghostty`), Alacritty (`org.alacritty`), WezTerm (`com.github.wez.wezterm`), Hyper (`co.zeit.hyper`), and Tabby (`org.tabby`).
- Password managers: 1Password 7 (`com.agilebits.onepassword7`), 1Password 8 (`com.1password.1password`), Bitwarden (`com.bitwarden.desktop`), Passwords (`com.apple.Passwords`), and Keychain Access (`com.apple.keychainaccess`).
- The macOS authentication dialog (`com.apple.SecurityAgent`) and the helper itself (`com.injaneity.pi-computer-use`).

Any source can add apps with `blocked_apps`, and a block added there always applies. Only `unblocked_apps` in the user file can lift a built-in block. The project file and the environment cannot unblock anything: such an entry is ignored, and `/computer-use` lists it as ignored. The app hosting Pi and the helper can never be unblocked. Bundle IDs match exactly, ignoring case; there are no wildcards. A terminal that reaches Pi through a detached `tmux` or `screen` server, or over SSH, is not one of Pi's parent processes, so only its bundle ID protects it: add an unlisted terminal to `blocked_apps`.

File edits take effect on the next tool call; environment variables are read when Pi starts. `/computer-use` shows the active settings and this session's grants. `/computer-use grant ask|always|off` sets `foreground_prompt` for the current session and saves it to the user file.

## Remove the helper

1. Quit Pi. If the helper is still running, stop it with `pkill -f pi-computer-use.app/Contents/MacOS/bridge`.
2. Delete `~/Applications/pi-computer-use.app` (or `/Applications/pi-computer-use.app`).
3. Remove `pi-computer-use` from the Accessibility and Screen Recording lists in System Settings.
4. Optionally, delete the `pi-computer-use Local Signing` identity from your login keychain in Keychain Access.
