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

This is a behavior change: a graph with a previously-silent
endpoint-incompatible `implies()` relation will now throw when a store is
created or a persisted schema's registry is rebuilt. Fix such relations by
narrowing the implying edge's endpoints, adding a `subClassOf` relation to
bridge the mismatch, or removing the `implies()` declaration.
