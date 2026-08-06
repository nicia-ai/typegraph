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

The edge fold and the node cluster union were affected in the same way, and their
worst outcome was a committed function. For a property the SURVIVING row does not
carry, both ask that row's bag for the value to keep, so under `in` they took the
inherited `Object.prototype` member and wrote that function into the merged row
instead of the value a member actually carried. The cluster union additionally
routed such a property through the separate base-property-conflict policy on the
strength of a base member that does not carry it, so the wrong policy decided the
committed value. The edge fold's claim filter separately counted a member that says
NOTHING about such a field as having AUTHORED it; the shared value collector
discarded that phantom claim, so the two agreed only by one absorbing the other's
mistake.

Two guards were quietly weakened rather than corrupted. Graph-extension validation
accepted a unique constraint on an undeclared field named after a prototype
member — it answered "declared" against the prototype — and went on to index a
field that does not exist. The evolve guard that refuses re-adding a kind whose
data cleanup is still pending never counted such a kind as added, so it skipped
the refusal.

The convention now has one owner, `hasOwnKey`, applied across graph-merge node and
edge property resolution, schema-diff property classification, schema-removal
reconciliation, interchange unknown-property stripping, graph-extension document
validation, query and index schema-field validation, and the evolve
pending-removal guard. `in` remains correct, and still in use, when both the key
and membership question are internal: a discriminated union's tag, a capability
probe, a brand check, and the deliberate `Object.prototype` lookup in selective
projection. A user-supplied field name is always checked as an own key, even when
the schema shape itself is statically known, so names such as `__proto__` and
`constructor` cannot masquerade as declared fields through `Object.prototype`.

`__proto__`, the case originally reported, is the NARROW variant. Every VALIDATED
write path blocks it: Zod drops an own `__proto__` key, and `bag["__proto__"] = value`
assigns a prototype rather than creating a key, so an assignment-built bag cannot
carry one either. It is still reachable through `trustedImportGraph`, which by
contract does not validate properties and writes a caller's bag verbatim — the
stored JSON parses back with `__proto__` as an own key on both dialects. Recorded
here so the two are not confused: a prototype-named field needs nothing unusual at
all, while `__proto__` needs the trusted path.
