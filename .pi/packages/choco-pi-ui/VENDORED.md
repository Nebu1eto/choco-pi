# Vendored: choco-pi-ui

`choco-pi-ui` is choco-pi's local TUI package. It is not original work: it
combines a pinned fork of the upstream **pi-zentui** extension with the theme
files of the upstream **@maddeye/pi-nord** theme package. Both upstreams are
MIT-licensed and keep their own copyright.

## 1. Extension sources — fork of `pi-zentui`

- Original source code: https://github.com/lmilojevicc/pi-zentui
- Package on npm: https://www.npmjs.com/package/pi-zentui
- Base version: `0.20.1` (see `version` in `package.json`)
- License: MIT — upstream copyright retained in `LICENSE`
- Local history: pinned as a path package in `1bb734b2`, first vendored in
  `dd5b26cb` (then under `.pi/packages/pi-zentui`)

Everything under `extensions/zentui/` is upstream code with choco-pi changes on
top. The directory name, the `/zentui` command, the `zentui` selector-border
style ID, and the `Symbol.for("pi-zentui.*")` interop keys are deliberately
unchanged: the symbols are a cross-extension protocol shared with
`.pi/extensions/prompt-editor.ts` and `.pi/extensions/model-controls.ts`, and
the style IDs are user-config values on disk.

### choco-pi change: config file name

`extensions/zentui/config.ts` now resolves its config file as
`<agent dir>/choco-pi-ui.json`, falling back first to
`<agent dir>/pi-choco-ui.json` and then to `<agent dir>/zentui.json`. Reads and
saves always use the same resolved file, so existing legacy files keep working
untouched.

### choco-pi change: mergeable host sections

`PreferencesExtraSection` in `extensions/zentui/settings-command.ts` gained an
optional `mergeInto`. A section that sets it contributes no tab: its rows are
appended to the named section, built-in or host-provided. Supporting that
needed three further edits in the same file:

- `buildSectionItems` no longer takes the host sections; the new
  `collectSectionItems` wraps it, appends every merged section's rows, and
  records the owning section per row id.
- `sectionOrder` and `sectionLabel` skip merged sections through
  `standaloneExtras`, so a merged section never appears in the tab strip.
- the settings-list `onChange` dispatches a row to its owner by row id before
  the built-in id chain, replacing the trailing lookup that matched the active
  section. Host rows must therefore keep ids distinct from the built-in ones.

choco-pi uses this to spread Pi's and the Codex adapter's settings over the
topical tabs instead of parking them in two catch-all sections.

## 2. Themes — vendored copy of `@maddeye/pi-nord`

- Original source code: https://github.com/maddeye/pi-nord
- Package on npm: https://www.npmjs.com/package/@maddeye/pi-nord
- Vendored version: `1.0.0`
- Tarball: `maddeye-pi-nord-1.0.0.tgz`, shasum
  `e73a83fabe3780bf0ae00afc26c352b4aadf85e4`, integrity
  `sha512-6kp1GLdS3akX7AEh4+1/7OrCW3PXU5dXr8snz57cELYQrh79GV1MUdPjjMmENKQW1Rt/vAoKXrZK+u+pFXBlWw==`
- Obtained: 2026-08-20 via `npm pack @maddeye/pi-nord@1.0.0`
- License: MIT — upstream copyright retained in `LICENSE.pi-nord`
- Palette credit: [Nord](https://www.nordtheme.com/); contrast direction from
  Zed's Nord theme

`themes/nord.json`, `themes/nord-dark.json`, and `themes/nord-light.json` are
byte-identical to the published tarball; no patch is applied. `package.json`
declares them through `pi.themes: ["./themes"]`, so Pi loads them from this
package and the `npm:@maddeye/pi-nord@1.0.0` entry in `.pi/settings.json` is no
longer needed. Theme names are unchanged (`nord`, `nord-dark`, `nord-light`),
so `"theme": "nord-dark"` resolves exactly as before.

## Updating

- Extension: pull the wanted `pi-zentui` release, diff it against
  `extensions/zentui/`, and re-apply the config-file-name and host-section
  changes above.
- Themes: `npm pack @maddeye/pi-nord@<version>`, replace `themes/*.json` and
  `LICENSE.pi-nord`, and record the new version, shasum, and date here.
