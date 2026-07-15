---
"@nicia-ai/typegraph": minor
---

Add the opt-in TypeGraph Identity Profile with typed store, transaction, and
temporal-view APIs; same-ID folding; assertion history; interchange and graph
merge propagation; identity-expanded traversal; cross-backend closure storage;
and fail-fast capability errors for non-transactional D1 and neon-http drivers.

Harden ontology construction and reload validation: propagate disjointness
through subclass closure, validate inverse endpoint compatibility and partner
uniqueness, reject unresolved extension endpoint names while retaining absolute
external IRIs, recompute serialized closures, and deprecate the type-level
`sameAs` and `differentFrom` factories in favor of Operational Identity.

**Behavior changes.** Ontology and registry validation is now stricter and runs
both at graph construction and when a persisted schema is loaded, so a few
patterns earlier versions silently accepted now throw a `ConfigurationError`:
duplicate ontology relations, hierarchical self-loops, disjointness
contradictions (a kind disjoint with itself, with a subclass ancestor, a common
subclass of two disjoint parents, or a kind declared both `equivalentTo` and
`disjointWith`), multiple distinct `inverseOf` partners for one edge, inverse
endpoint incompatibility, and unresolved extension-ontology endpoint names. To
recover, fix the graph definition; for a persisted extension document, correct
the stored document before upgrading (or rewrite it through the previous minor,
which still accepts it). Interchange documents remain readable across versions —
`1.0` documents are still accepted on import, and exports write `2.0`. On an
identity-enabled graph, `create()`/`upsert` of a soft-deleted same-`(kind, id)`
row now resurrects that row (properties replaced, validity window reset so
`validFrom` becomes the resurrection instant) rather than erroring. These are
additive-strictness and semantics-pinning changes on top of the new opt-in
profile, hence the minor bump.
