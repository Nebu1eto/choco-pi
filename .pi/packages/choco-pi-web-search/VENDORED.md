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

## 2026-10-09 choco-pi patch: Pi SDK 1.2.0

Pi SDK peer and development pins move from `1.0.4` to exactly `1.2.0`.

## 2026-10-16 choco-pi patch: Pi SDK target 1.3.0

Pi SDK peer and development pins move from `1.2.0` to exactly `1.3.0`.
Verification: `node --test tests/pi-sdk-target.test.ts` and `pnpm typecheck` pass.

## 2026-10-16 choco-pi patch: xAI provider family

`searchProviderFamilies` appends `xai` as the last family, so the default order is OpenAI,
Exa, Kagi, Synthetic, Brave, xAI and `auto` reaches xAI only after every earlier family.
The core still imports no backend; the adapter lives in `.pi/extensions/lib/xai-search.ts`.

Follow-up (same day): `SearchAdapter.explicitOnly?: boolean` is added because the router
treats a `disabled` adapter as a route miss even under explicit selection. Plans built from
the default order (`auto` without routing, and `all`) skip explicit-only adapters, record
them as `disabled` attempts with reason "explicit selection only", and drop families whose
registered adapters are all explicit-only. Explicit family selection, request provider
lists, and `routing.providers` that name the family still reach them. The xAI adapter is
explicit-only, so `auto` never reaches xAI despite its last-place order.

## 2026-10-22 choco-pi patch: Pi SDK target 1.4.0

Pi SDK peer and development pins move from `1.3.0` to exactly `1.4.0`.
Verification: `node --test tests/pi-sdk-target.test.ts` and `pnpm typecheck` pass.
