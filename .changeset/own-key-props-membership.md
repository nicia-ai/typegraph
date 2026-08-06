---
"@nicia-ai/typegraph": patch
---

Ask props bags whether they carry a key with `Object.hasOwn` rather than `in`.

A props bag is data: its keys come from a JSON column, so a schema may declare a
field named after an `Object.prototype` member — `toString`, `constructor`,
`valueOf` — and such a field is ordinary data that survives Zod validation and
the JSON round-trip untouched. `in` cannot answer "does this row carry this
property" for such a bag, because `"toString" in {}` is `true`: a row that does
not carry the key reads as though it does, and the read that follows yields the
inherited prototype member instead of stored data.

This is a lost-write fix, not only hardening. In a graph merge, a fork's bag is
its full intended state, so a base property absent from it was deleted by that
fork. Under `in` that deletion was never detected for a prototype-named field:
no deletion tombstone was written and the base value survived the merge, silently
discarding the fork's write. The same misclassification credited a branch that
does not carry such a property with the inherited prototype member as if it were
a stored value, letting an invented claim compete in conflict resolution and be
reported to the caller as that branch's value. A schema diff also reported a
removed prototype-named property as an incompatible schema change rather than a
removal, because the absent field resolved to a function that was then compared
as though it were the field's new schema.

The edge fold was affected in the same way, and worse: a member that says NOTHING
about a prototype-named field counted as having AUTHORED a value it never wrote,
so an inherited function entered the property union as a first-class claim and
displaced the surviving row's real value.

Two guards were quietly weakened rather than corrupted. Graph-extension validation
accepted a unique constraint on an undeclared field named after a prototype
member — it answered "declared" against the prototype — and went on to index a
field that does not exist. The evolve guard that refuses re-adding a kind whose
data cleanup is still pending never counted such a kind as added, so it skipped
the refusal.

The convention now has one owner, `hasOwnKey`, applied across graph-merge node and
edge property resolution, schema-diff property classification, schema-removal
reconciliation, interchange unknown-property stripping, graph-extension document
validation, and the evolve pending-removal guard. `in` remains correct, and still
in use, where the key set is statically known: a discriminated union's tag, a
capability probe, a brand check, and the deliberate `Object.prototype` lookup in
selective projection.

`__proto__`, the case originally reported, is the NARROW variant and is already
blocked several times over — Zod drops an own `__proto__` key, `branch()` clones
through the validating interchange import, the base@V fingerprint refuses a base
mutated after the fork, and `bag["__proto__"] = value` assigns a prototype rather
than creating a key, so assignment-built result bags cannot carry one either.
Recorded here so it is not "fixed" again as though it were the reachable case.
