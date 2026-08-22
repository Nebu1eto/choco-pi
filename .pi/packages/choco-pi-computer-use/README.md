# choco-pi-computer-use

Vendored, private fork of [`@injaneity/pi-computer-use`](https://github.com/injaneity/pi-computer-use) for the choco-pi harness. It keeps the upstream tool names and TypeScript source layout, and pi loads `extensions/computer-use.ts` directly without a build step.

## Platform support

This fork supports native helper installation on macOS only. The Linux and Windows TypeScript backends remain for dispatch compatibility, but their native helpers, prebuilts, and build paths are not included.

The arm64 and x64 macOS helper binaries are committed under `prebuilt/macos/`. At runtime, a UI session setup or tool operation checks the helper. If it is missing, `src/platform/macos/helper.ts` launches `scripts/setup-helper.mjs`, which installs the matching binary as an app bundle. Set `PI_COMPUTER_USE_ALLOW_BUILD=1` to permit the retained Swift-source fallback.

The installer may modify `/Applications` or `~/Applications`, register the app with LaunchServices, and codesign it. Do not run it during static validation.

See `VENDORED.md` for provenance and fork divergences.
