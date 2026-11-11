---- MODULE Undefined ----
\* Parses, but uses an undefined name: SANY reports a semantic error and still exits 0.
VARIABLE x
Init == x = y
Next == x' = x
====
