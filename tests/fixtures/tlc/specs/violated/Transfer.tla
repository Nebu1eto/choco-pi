---- MODULE Transfer ----
\* Moves money from a to b in two steps. Conserved breaks after one step,
\* NotDrained after three, and the model deadlocks once a is empty.
EXTENDS Naturals
VARIABLES a, b, pc
vars == <<a, b, pc>>

Init == a = 2 /\ b = 0 /\ pc = "idle"
Withdraw == pc = "idle" /\ a > 0 /\ a' = a - 1 /\ pc' = "moving" /\ UNCHANGED b
Deposit == pc = "moving" /\ b' = b + 1 /\ pc' = "idle" /\ UNCHANGED a
Next == Withdraw \/ Deposit
Spec == Init /\ [][Next]_vars

TypeOK == a \in 0..2 /\ b \in 0..2 /\ pc \in {"idle", "moving"}
Conserved == a + b = 2
NotDrained == a > 0
AllMoved == <>(b = 2)
====
