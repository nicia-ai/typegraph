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
