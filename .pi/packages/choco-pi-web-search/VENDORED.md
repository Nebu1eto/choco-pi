# Provenance

First-party provider-neutral unified web-search routing core. This package has no vendored runtime dependencies or generated output. Pi SDK and TypeBox are supplied by the host as peer dependencies.

The cross-loader identity directory is a first-party process-local protocol. It stores only versioned weak owner mappings and object brands; it stores no credentials, current context, backend singleton, or adapter list.

Canonical frontend activation is a per-scope, load-order-independent two-party handshake: the core requests integration and the enabled frontend confirms successful registration. No process-global activation marker is used.

Cancellation settlement and the 120-second attempt/360-second total deadline defaults are enforced in this first-party router at the adapter execution boundary. Backends remain responsible for any tighter transport limits.

## 2026-10-07 choco-pi patch: Pi SDK 1.0.4

Pi SDK peer and development pins move from `0.87.1` to exactly `1.0.4`,
matching the harness target. Other dependency contracts are unchanged.

## 2026-10-07 choco-pi patch: Pi SDK 1.0.4 test fixtures

The cross-loader test fixture's `ExtensionActions` implement `getSettings()`
from the in-memory `SettingsManager` given to its resource loader. Runtime code
is unchanged.
