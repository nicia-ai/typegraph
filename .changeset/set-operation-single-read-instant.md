---
"@nicia-ai/typegraph": patch
---

Fix: a set operation now binds one "current" read instant across all of its
operands.

`UNION` / `INTERSECT` / `EXCEPT` compile each operand independently, and each
operand compiled its own temporal-validity filter from a fresh `nowIso()`
sample. A compound `SELECT` is evaluated against a single snapshot, so two
samples microseconds apart let the two halves of an `INTERSECT` or `EXCEPT`
disagree about whether a row created between them is current — a row could
satisfy the left operand's `valid_from <= now` and not the right's.

Compilation of a set operation (including nested ones) now runs under a single
pinned instant. Ordinary single-leaf queries were already consistent — they bind
one instant per compile — and are unaffected.
