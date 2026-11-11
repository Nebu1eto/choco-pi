---- MODULE Turnstile ----
\* A coin turnstile with a coin counter that resets at Limit. Every rule holds.
EXTENDS Naturals
CONSTANT Limit
VARIABLES gate, coins
vars == <<gate, coins>>

Init == gate = "locked" /\ coins = 0
Coin == gate = "locked" /\ coins < Limit /\ gate' = "unlocked" /\ coins' = coins + 1
Push == gate = "unlocked" /\ gate' = "locked" /\ UNCHANGED coins
Reset == gate = "locked" /\ coins = Limit /\ coins' = 0 /\ UNCHANGED gate
Next == Coin \/ Push \/ Reset
Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

TypeOK == gate \in {"locked", "unlocked"} /\ coins \in 0..Limit
Bounded == coins <= Limit
LocksAgain == []<>(gate = "locked")
====
