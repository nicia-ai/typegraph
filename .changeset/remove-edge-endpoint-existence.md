---
"@nicia-ai/typegraph": minor
---

The edge registration option `endpointExistence` (`"notDeleted" | "currentlyValid" | "ever"`) is removed (#945). It was validated, written into the stored schema document, diffed by schema migration and reported by introspection, but no edge write ever read it: an edge onto a soft-deleted endpoint was refused whatever it said, and `"currentlyValid"` added no validity check. How edge writes check their endpoints does not change.

- `EdgeRegistration` declares `endpointExistence?: never`, and the `EndpointExistence` type is no longer exported from `@nicia-ai/typegraph/core` or `@nicia-ai/typegraph/backend`. Stating the option is a compile error wherever an edge registration is accepted, including an inline `defineGraph` call and a registration held in an inferred variable, which a merely undeclared property would let through because `defineGraph` infers its edges generically. A graph-extension edge (`defineGraphExtension`, `store.evolve`) refuses it at compile time the same way.
- `defineGraph` refuses a registration that still states `endpointExistence` (an untyped caller, or code compiled against an earlier release), whatever the value, with `ConfigurationError` code `EDGE_INTEGRITY_OPTION_INVALID` and `details.option: "endpointExistence"`, rather than dropping it silently. An explicit `endpointExistence: undefined` states nothing, as an explicit `undefined` does for `cardinality`, `targetCardinality` and `acyclic`; it is accepted and the key is dropped from the registration.
- `store.introspect()` no longer reports `endpointExistence` on an edge, `SerializedEdgeDef` no longer has it, and a schema diff no longer reports a change to it.
- A schema document keeps carrying the field on every edge, fixed at `"notDeleted"`, the value every registration that did not state the option wrote. It is a document-format constant that nothing reads and the schema types no longer declare. For a graph that never stated the option nothing changes: it serializes and hashes exactly as before, so every persisted hash taken over it (the stored schema version hash, graph-template registrations, merge plans, candidate write sets, base versions, a durable working copy's attested definition hash and schema anchor, `validateStore` cursors) is still accepted. A document an earlier release stored with `"currentlyValid"` or `"ever"` is read as `"notDeleted"` when it is compared with the graph, so it opens as `unchanged` on that stored version, with no diff, no new version, no migration and the row left as written.

### Breaking

Delete `endpointExistence` from every edge registration that states it, and remove any import of the `EndpointExistence` type.

A graph that never stated the option needs nothing else. A graph that stated `"currentlyValid"` or `"ever"` hashes differently once the option is deleted, so an artefact that recorded a hash of it before the upgrade is refused where it is compared and has to be produced again:

- Stored schema version: nothing to do. The store opens on it unchanged.
- Graph-template registration: nothing to do. Registering the template again under its id matches the stored registration, and instantiation proceeds as before.
- Merge plan: applying it fails with `MergePlanSchemaMismatchError`. Generate the plan again and re-approve it.
- Candidate write set: planning it fails with `CandidateWriteSetError` ("targets a different graph schema"). Capture the target and build the write set again.
- Durable working copy: reattaching it fails with `BranchError` (the definition hashes differently from the attested fork-time definition), and its recorded base version and schema anchor no longer match the target (`BaseVersionMismatchError`). Merge or discard it before upgrading; afterwards, fork it again. Work left on it is not carried over.
- `validateStore` cursor: resuming it fails with `StoreAnalysisCursorStaleError`. Restart the scan without a cursor.
