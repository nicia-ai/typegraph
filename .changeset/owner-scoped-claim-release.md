---
"@nicia-ai/typegraph": minor
---

Scope uniqueness-claim releases to the node that owns the claim.

A `typegraph_node_uniques` row records both the axis it fences on (`node_kind`) and the node that owns it (`concrete_kind`, `node_id`). Releases keyed on the axis alone could not tell those apart: a soft delete gave up whatever row sat at the node's own kind, and a kind removal deleted every claim whose *axis* was the removed kind. Both readings are wrong the moment an axis and a concrete kind differ — they leak a claim that blocks its key forever, and they delete a surviving sibling's claim.

Release now has three explicitly different shapes, each with one owner: a **lifecycle** release gives up every claim the node holds for a constraint and key at whatever axis it sits on (soft delete, an update's key-change release, the resurrect diff); a **compensating** release undoes exactly the row a failed write claimed, at the axis it claimed on; and **kind reaping** removes every claim the removed kind's nodes own, through the new `buildHardDeleteUniquesByConcreteKind` builder that `materializeRemovals` and the new optional `hardDeleteUniquesByConcreteKind` backend member both compile.

`DeleteUniqueParams` gains the owner pair `concreteKind` / `nodeId`, and its `nodeKind` becomes optional — present selects the compensating shape, absent the lifecycle one. A third-party `GraphBackend` that implements `deleteUnique` must make BOTH changes: add `concrete_kind` and `node_id` to its predicate, and make the `node_kind` term *conditional* on `params.nodeKind` being present. Doing neither does not leave the old behavior in place: the lifecycle release now passes no `nodeKind`, so a predicate that still spells `node_kind = :nodeKind` unconditionally compares against NULL, matches zero rows, and releases nothing — every soft delete and every key-change release leaks its claim, and the key stays blocked forever. TypeScript cannot catch it either, since an `undefined` bound into a SQL template is accepted silently.
