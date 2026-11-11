---- MODULE Unbounded ----
\* A counter with no upper limit: TLC can never finish it.
EXTENDS Naturals
VARIABLE n
Init == n = 0
Next == n' = n + 1
NonNegative == n >= 0
====
