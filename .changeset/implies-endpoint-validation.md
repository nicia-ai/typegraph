---
"@nicia-ai/typegraph": minor
---

Fixes `implies(edgeA, edgeB)` silently accepting endpoint-incompatible edge
pairs. Previously an ontology declaration like `implies(about, writes)` — where
`about` connects `Paper -> Topic` and `writes` connects `Author -> Paper` —
was accepted without complaint, and `expand: "implying"` query traversal
would then silently fold `about` rows into a `writes` traversal even though
the two edges connect entirely different node kinds.

`implies()` relations are now validated wherever a query-capable
`KindRegistry` is built — `createStore()`/`createStoreWithSchema()` for a
live graph definition, and `deserializeSchema(...).buildRegistry()` for a
persisted schema — including relations authored through
`store.evolve({ ontology })`. A relation is accepted when every kind the
implying edge allows on a side (`from`/`to`) is assignable — equal, or a
`subClassOf` descendant — to at least one kind the implied edge allows on
that same side; otherwise construction throws a `ConfigurationError`
describing the incompatible kinds and how to fix the declaration.

**Breaking change — two things to know before upgrading.**

*It breaks the load path, not just graph definition.* `deserializeSchema(...)`
runs the same endpoint check inside `buildRegistry()`, so a schema **already
persisted** under 0.34 that carries a now-rejected `implies()` relation throws
at the first `buildRegistry()` after the upgrade — no code change of yours
required to trigger it. Audit persisted schemas before rolling out, not only
the graph definitions in source.

*It rejects superset domains, not only disjoint ones.* A relation is accepted
only when every kind the implying edge allows on a side is assignable to at
least one kind the implied edge allows on that side. So `implies(a, b)` where
`a` is declared `from: [Person]` and `b` is declared `from: [Employee]` (with
`Employee subClassOf Person`) is **rejected**, even though every `a` row on
disk might in fact start at an `Employee`: `Person` is not assignable to
`Employee`. The declaration, not the data, is what the traversal folds on, and
a `Person`-rooted `a` row folded into a `b` traversal would be unsound. The
same rule is what makes the previously-silent disjoint case (`Paper -> Topic`
implying `Author -> Paper`) an error.

Fix such relations by narrowing the implying edge's endpoints, adding a
`subClassOf` relation to bridge the mismatch, or removing the `implies()`
declaration.
