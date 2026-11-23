# choco-pi-shared — working rules

First-party stateless foundation package for choco-pi workspace packages and profile extensions.

## Hard constraints

- **Stateless only.** Pi loads each extension through jiti with `moduleCache: false`, so every extension receives its own module evaluation. Never store mutable cross-extension singletons in module scope; export only types, constants, pure functions, stateless compiled `pi-schema` validators, and `globalThis[Symbol.for(...)]` typed accessors.
- **Zero upward dependencies.** Never import from any other `packages/*` member or `profile/`. `tests/architecture-boundaries.test.ts` enforces this.
- **No `pi` manifest key.** This is a library package, not a Pi extension package.
- **Erasable Node 24+ TypeScript** with explicit `.ts` relative imports and zero blocking `*Sync` calls.
- **Do not rename `Symbol.for(...)` protocol strings.** They are live cross-extension runtime contracts.
