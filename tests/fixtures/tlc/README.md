# TLC fixtures

- `specs/`: small models that `tests/formal/tlc-run.test.ts` checks with real TLC.
- `recorded/`: TLC 2.19 (tla2tools v1.7.4) `-tool` output recorded on macOS with Java 21 and used by
  `tests/formal/tlc-output.test.ts`. `invariant.out`, `deadlock.out` and `temporal-stuttering.out` are runs 1, 3 and 4
  of `specs/violated/Transfer.tla`. `invariant-initial.out` (config `INVARIANT I`), `temporal-back.out`
  (`PROPERTY P`) and `action-property.out` (`PROPERTY A`) come from `recorded/Loop.tla`. Temporary paths are
  replaced with `/spec` and `/work`.
- `pstack/`: three recorded outputs copied unchanged from pstack's `statechart` test corpus
  (`skills/statechart/scripts/test/corpus/{TwoPhase/verdict-1.out,TypeGuard/verdict-2.out,CounterLoop/verdict-1.out}`),
  Copyright (c) 2026 Lauren Tan, MIT licence; the licence text is in
  `.pi/skills/formal-verify/THIRD_PARTY.md`.
