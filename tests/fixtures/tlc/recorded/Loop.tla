---- MODULE Loop ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
Next == x' = (x + 1) % 3
Spec == Init /\ [][Next]_x /\ WF_x(Next)
P == <>[](x = 0)
I == x # 0
A == [][x' > x]_x
====
