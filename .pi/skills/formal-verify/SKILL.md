---
name: formal-verify
description: Check an ordering or state promise in the code with a small TLA+ model and the TLC model checker.
---

# Formal Verification with TLA+

Use this when a claim about concurrency or state-machine behaviour needs proof rather than a reviewer's opinion. You write a small TLA+ model of the code, TLC explores every state of it within bounds, and a broken rule comes back as a concrete trace. It works in any project and for code in any language; only the drift check's per-symbol hashing is limited to TypeScript and JavaScript.

## When a model is worth writing

Write one for a promise the code makes about ordering or state, where a break harms users and ordinary tests rarely reach the bad interleaving: a run that must settle exactly once, a lock or lease that must never be held twice, a queue that must not lose or replay work across a restart or cancellation, a lifecycle whose stale callbacks must not act on a new generation.

Do not write one for pure input-to-output logic, formatting, or anything a unit test already reaches. Do not write one to restate what the code obviously does. For questions about every input rather than every interleaving (a parser, a reducer, path normalisation), use property-based tests of the real code instead.

Pick the strongest target, not the easiest: the path with the most awaits, retries, cancellations and concurrent callers, and the rule users depend on ("a completed run is reported once"), not a helper's local detail.

## Building the model

- **Correspondence.** Every variable and every action points to code a reader can open: a file and a symbol. What the model treats as one indivisible step must be one indivisible step in the code. Each suspension point (`await`, `yield`, a callback boundary, a lock release) ends a step, so a function with two awaits is at least three actions, and code that runs straight through without suspending is one action even across function calls. Callbacks, timers and other callers interleave at every suspension point; model them as separate actions.
- **Bounds.** Keep constants small (two callers, two runs, a retry limit of 2). Most ordering bugs show up with two of everything. Put the constants in the `.cfg`, not the spec, and say in the README why each value is enough.
- **Rules.** Safety rules go under `INVARIANT`. Liveness rules ("eventually settles") go under `PROPERTY` and need fairness (`WF_vars(Action)`) in the `SPECIFICATION`; state which fairness the code actually provides, for example that a timer always fires. A rule about history ("no attempt starts after cancel") needs a history variable the code does not have; say so in the README.
- **Mutations.** Each invariant must be shown to fail. Add a `Mutation` constant to the spec (`"none"` in the base config), guard each deliberate mistake with it (`IF registry = j \/ Mutation = "unconditionalDelete" THEN ...`), and give each mutation its own config in `mutations/` that sets it. Each mirrors a plausible code mistake (a missing guard, a check moved after an await, a flag cleared too early) and must make TLC report a named invariant violated. An invariant no mutation can break proves nothing.

## What a result means

`pass` means TLC explored the whole model within the stated bounds and every rule held. It covers the model, not the code: it is only as good as the correspondence table and the constants. `inconclusive` means a state or time bound stopped the run; shrink the model or raise the bound. It is never a pass.

A violation is a trace through the model, not yet a defect in the code. Before calling it a bug, turn the trace into a deterministic test of the real code that forces the same interleaving (hold a promise or future open, start and resolve tasks in the traced order) and watch it fail. If the test cannot reproduce it, the model is wrong; fix the model and record why. After fixing the code, model the fix and keep the old behaviour as a mutation.

## Layout and what to commit

Commit everything under `formal/tla/<name>/` and the reproducing tests. Never commit the TLA+ tools or `--out` directories.

- `<Name>.tla`, `<Name>.cfg`, `mutations/*.cfg`: the spec, its config and the mutation configs. Keep every module the spec extends in the same directory.
- `README.md`: the claim; the correspondence table (model variable or action, file and symbol, the code step); the constants and why they suffice; the mutations (mutation, the code mistake it mirrors, the invariants it breaks); the fairness assumptions; what was left out.
- `check.json`, read by `check-all.ts`: `{ "schema": 1, "name", "spec", "config", "expect": "pass", "bounds": { "maxStates", "timeoutMs" }, "mutations": [{ "name", "spec", "config", "expectViolated": [rules] }] }`, paths relative to the model directory. A mutation passes only if it violates exactly its `expectViolated` set. `"expect": "violated"` with `"expectViolated"` records a known defect in the base model.
- `coverage.json`, read by `drift.ts`: the code the model covers.

```json
{
  "schema": 1,
  "name": "retry-queue",
  "kind": "tla",
  "artifact": "formal/tla/retry-queue/RetryQueue.tla",
  "command": "node <formal-verify>/scripts/check-all.ts --only retry-queue",
  "covers": [
    { "file": "src/queue.ts", "symbol": "RetryQueue.submit", "hash": "pending" },
    { "file": "app/lease.py", "hash": "pending" }
  ],
  "assumes": [{ "note": "work() never calls back into the queue synchronously" }],
  "checkedAt": { "commit": "pending" }
}
```

`file` is relative to the directory holding `formal/`. `symbol` (`name` or `Class.member`) hashes one declaration and works only in TypeScript and JavaScript files. For any other language omit `symbol`: the entry hashes the whole file, which is coarser, since any edit to the file reports drift. A `symbol` in another language is a declaration error. `kind` is `"tla"`, or `"property"` for a property-based test.

## Commands

`<formal-verify>` is the directory holding this file. Run the scripts with `node` (22.18 or newer; they are TypeScript run directly) from anywhere inside the project. `drift.ts` and `check-all.ts` use the nearest directory, from the current one up to the git repository root, that contains `formal/`; `--root <dir>` overrides it. Setup is explicit; the checker never downloads anything.

```sh
node <formal-verify>/scripts/tlc-setup.ts
node <formal-verify>/scripts/tlc.ts check --spec formal/tla/<name>/<Name>.tla \
  --config formal/tla/<name>/<Name>.cfg [--max-states 1000000] [--timeout-ms 120000] [--out <dir>]
node <formal-verify>/scripts/check-all.ts [--only <name>] [--jobs <n>] [--workers <n>] [--heap-mb <n>]
node <formal-verify>/scripts/drift.ts check | affected --files <paths> | affected --base <rev>
node <formal-verify>/scripts/drift.ts update --file formal/tla/<name>/coverage.json
```

Setup downloads the pinned `tla2tools.jar` (v1.7.4, about 2.2 MB) once per machine into `${XDG_CACHE_HOME:-~/.cache}/choco-pi/formal`, which every project then shares, verifies its SHA-256, and checks for Java 11 or newer. `--dir <dir>` puts the jar elsewhere; then pass `--tools-dir <dir>` to `tlc.ts` and `check-all.ts`, and add the directory to `.gitignore` if it is inside a repository.

`tlc.ts check` prints one JSON document with a verdict per invariant and property, the deadlock result, and a trace for each violation. Exit codes: 0 pass, 3 violated, 4 inconclusive, 2 error (missing tools or Java, parse error, output it cannot read). Other options: `--jar <path>` (or `CHOCO_PI_TLA2TOOLS`), `CHOCO_PI_JAVA` for the Java binary, `--workers <n>` (default 1, which keeps traces shortest), `--heap-mb <n>` (TLC's JVM heap, default 2048; TLC runs with two garbage-collector threads), `--no-deadlock`. See `references/tlc-wrapper.md` for how verdicts are decided.

`check-all.ts` runs each `check.json`'s base model and mutations and prints a JSON summary. It runs `--jobs` checks at once, each with `--workers` TLC threads; both default to 2, or 1 on a machine with fewer than 8 cores or 8 GiB (`--jobs`) or fewer than 4 cores (`--workers`). Neither changes a verdict, since every rule is decided by a complete run; `--heap-mb` is passed to each `tlc.ts`. It exits 0 only if every expectation holds; 3 otherwise, including any inconclusive or errored run; 2 for a malformed manifest, a missing `formal/`, or an `--only` name that matches no model. A `formal/` with no `formal/tla/*/check.json` exits 0 with `"manifests": 0` and a message that nothing was checked; that is not a pass. Anything that stops it looking (an unreadable directory or `check.json`, `formal/tla` that is a file, a dangling symlink) exits 2 naming the path; `drift.ts` likewise rejects an unreadable `formal/` subtree or a symlinked `coverage.json`.

`drift.ts` reports textual change only. `check` exits 0 when every covered entry is unchanged and 3 when any is stale or never recorded; `affected` exits 3 when the given or changed files are covered. Run `update` only after the model has been re-run against the changed code and passed; it records the current hashes and `HEAD`, so the project needs at least one commit. Exit 2 means a malformed declaration, a missing `formal/`, or a tool error.
