# How `tlc.ts check` decides a verdict

## Runs

1. The config is read for its `INVARIANT`, `PROPERTY` and `CHECK_DEADLOCK` sections; every other section goes to TLC as written. A rule list that is not plain operator names separated by spaces is an error.
2. Every `.tla` file in the spec's directory is copied into a private temporary directory. SANY parses the copy. A parse or semantic error is status `error`.
3. TLC runs on the copy with `-tool -workers 1 -fp 0 -lncheck final`, its own `-metadir`, and `java.io.tmpdir` inside the temporary directory, so nothing is written next to the spec. The directory is removed afterwards.
4. The state bound always applies. A generated module extends the spec and adds `CONSTRAINT TLCGet("distinct") < maxStates`. If a run ends with at least `maxStates` distinct states, the state space may have been cut, so its rules are `not_checked` and the status is `inconclusive`.
5. The time bound covers the whole check. When it expires, the Java process is killed with SIGKILL and the wrapper waits for it to exit. Rules without a verdict are `not_checked`.

## Isolating violations

TLC stops at the first violation. The first run checks every rule together. When a rule breaks, it is recorded with TLC's trace and the remaining rules run again. With one worker TLC searches breadth-first, so each violated invariant's trace is a shortest path to a state that breaks it.

- A deadlock is reported by TLC as a violation; later runs pass `-deadlock` to turn deadlock checking off.
- A `[]P` property is reported by TLC as "Invariant P is violated"; the wrapper maps it back to the property.
- "Temporal properties were violated" does not name the property. If the run checked one property, that property is violated. Otherwise each property runs alone, and the invariants run again without properties.
- A liveness violation in a run that reached the state bound is discarded: cutting the state space can create false liveness counterexamples.

Liveness traces are not guaranteed to be shortest. They end in a `loop`: `{ "kind": "stuttering" }` (the system stops taking steps) or `{ "kind": "back", "toIndex": n, "action": "A" }` (action A returns to state n).

## Failing closed

A run counts as complete only if TLC exits 0, reports "Model checking completed. No error has been found." (message 2193) and "Finished" (2186), and states how many distinct states it found. A violation counts only if the exit code matches its kind (11 deadlock, 12 or 13 for a named invariant or property, 13 for an unnamed liveness violation), the message names a rule that run checked, and a trace parses with consecutive state numbers. Any other combination, any error-level TLC message (for example an invariant that fails to evaluate), output that ends inside a message, or more than 64 MiB of output is status `error`.

The overall status is `error` if anything errored, else `violated` if any rule broke or a deadlock was found, else `inconclusive` if any rule is `not_checked` or the deadlock check did not finish, else `pass`.

## Trace values

Each trace step is `{ index, action, state }`. `index` is TLC's state number (1 is the initial state; `action` is then `"Initial predicate"`). Each state maps variable names to values:

| TLA+                                        | JSON                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `TRUE`, `3`, `"s"`                          | `true`, `3`, `"s"`                                                                                    |
| model value `r1`                            | `{ "kind": "model", "name": "r1" }`                                                                   |
| `{1, 2}`                                    | `{ "kind": "set", "members": [1, 2] }`                                                                |
| `1..3`                                      | `{ "kind": "interval", "lo": 1, "hi": 3 }`                                                            |
| `<<a, b>>`, `[f \|-> 1]`, `(k :> v @@ ...)` | `{ "kind": "function", "printedAs": "tuple" \| "record" \| "pairs", "keys": [...], "values": [...] }` |
| anything else                               | `{ "kind": "raw", "text": "<TLC's text>" }`                                                           |

A raw value is wrapped so it cannot be mistaken for a TLA+ string.

## Tools

The pinned release is tla2tools v1.7.4 (TLC 2.19), the newest stable tlaplus release; v1.8.0 is still marked as a prerelease. Its classes target Java 8, and the tlaplus project supports it on Java 11 or newer. A jar given with `--jar` or `CHOCO_PI_TLA2TOOLS` may differ from the pin; the output then carries a note saying so. A jar found in the tools directory must match the pin.
