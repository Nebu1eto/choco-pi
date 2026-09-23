# choco-pi-computer-use

Vendored, private fork of [`@injaneity/pi-computer-use`](https://github.com/injaneity/pi-computer-use) for the choco-pi harness. It keeps the upstream tool names and TypeScript source layout, and pi loads `extensions/computer-use.ts` directly without a build step.

## Platform support

This fork supports native helper installation on macOS only. The Linux and Windows TypeScript backends remain for dispatch compatibility, but their native helpers, prebuilts, and build paths are not included.

The arm64 and x64 macOS helper binaries are committed under `prebuilt/macos/`. At runtime, a UI session setup or tool operation checks the helper. If it is missing, `src/platform/macos/helper.ts` launches `scripts/setup-helper.mjs`, which installs the matching binary as an app bundle. Set `PI_COMPUTER_USE_ALLOW_BUILD=1` to permit the retained Swift-source fallback.

The installer may modify `/Applications` or `~/Applications`, register the app with LaunchServices, and codesign it. Do not run it during static validation.

## Helper protocol and test environment

The TypeScript client requires helper protocol 7: request cancellation, cross-process session ownership, and native enforcement of the foreground grant. A daemon that reports another protocol is shut down and relaunched once; the committed prebuilts still report protocol 6 until they are rebuilt.

- `PI_CU_SOCKET_PATH` points the client at another helper socket. With it set, the client never installs or launches the helper app.
- `PI_COMPUTER_USE_HELPER_APP_PATH` overrides the helper app bundle whose executable `diagnostics.executablePath` must match.
- `tests/helpers/fake-helper-daemon.ts` serves the protocol without touching Accessibility, screen capture, or input: `node --experimental-strip-types tests/helpers/fake-helper-daemon.ts --socket <path> --script <s1-ok|s2-foreground-required|s3-didnt|s4-slow-type|s5-stale|s6-grant|s7-ownership> [--log <requests.jsonl>] [--executable-path <path>] [--protocol-version <n>]`. Tests import `startFakeHelperDaemon` from the same file.

See `VENDORED.md` for provenance and fork divergences.
