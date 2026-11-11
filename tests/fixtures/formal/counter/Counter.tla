---- MODULE Counter ----
\* Tiny fixture for tests/formal/formal-check-all.test.ts: a counter that stops at Limit.
\* Broken lowers the bound Bounded allows, so Bounded (and only it) fails.
EXTENDS Naturals
CONSTANTS Limit, Broken
VARIABLE n

Init == n = 0
Next == n < Limit /\ n' = n + 1
Spec == Init /\ [][Next]_n

Bounded == n <= (IF Broken THEN Limit - 1 ELSE Limit)
NonNegative == n >= 0
====
