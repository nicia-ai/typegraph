---
"@nicia-ai/typegraph": minor
---

The edge registration option `endpointExistence` (`"notDeleted" | "currentlyValid" | "ever"`) is removed (#945). It was validated, written into the stored schema document, diffed by schema migration and reported by introspection, but no edge write ever read it: an edge onto a soft-deleted endpoint was refused whatever it said, and `"currentlyValid"` added no validity check. How edge writes check their endpoints does not change.

- `EdgeRegistration` has no `endpointExistence` property, and the `EndpointExistence` type is no longer exported from `@nicia-ai/typegraph/core` or `@nicia-ai/typegraph/backend`.
- `defineGraph` refuses a registration that still states `endpointExistence` (an untyped caller, or code compiled against an earlier release), whatever the value, with `ConfigurationError` code `EDGE_INTEGRITY_OPTION_INVALID` and `details.option: "endpointExistence"`, rather than dropping it silently.
- `store.introspect()` no longer reports `endpointExistence` on an edge, `SerializedEdgeDef` no longer has it, and a schema diff no longer reports a change to it.
- A schema document keeps carrying the field on every edge, fixed at `"notDeleted"`, the value every registration that did not state the option wrote. It is a document-format constant that nothing reads and the schema types no longer declare; keeping it means a graph that never stated the option serializes and hashes exactly as before, so no stored or attested hash moves: not the stored schema version hash, the fork-time definition hash of a durable working copy, a merge base version or a graph-template registration. A document an earlier release stored with `"currentlyValid"` or `"ever"` is read as `"notDeleted"` when it is compared with the graph, so it too opens as `unchanged` on that stored version, with no diff, no new version, no migration and the row left as written.

### Breaking

Delete `endpointExistence` from every edge registration that states it, and remove any import of the `EndpointExistence` type. Stored schemas need nothing: an existing store opens on its stored schema version unchanged, whatever value that version recorded. One case cannot be carried over: a durable working copy forked while its graph stated `"currentlyValid"` or `"ever"` was attested with a definition hash that included that value; the graph without the option hashes differently, so reattaching that working copy is refused as a different graph definition. Merge or discard such a working copy before upgrading.
