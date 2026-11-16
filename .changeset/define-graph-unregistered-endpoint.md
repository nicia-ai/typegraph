---
"@nicia-ai/typegraph": minor
---

`defineGraph` now refuses an edge whose `from` or `to` names a node kind that is not registered in `nodes`. This covers explicit registrations, the values of a source-to-target map, and an `EdgeType`'s own endpoints. It throws a `ConfigurationError` naming the edge, the endpoint and the kind (`details.code: "EDGE_ENDPOINT_KIND_NOT_REGISTERED"`, with `edge`, `endpoint`, `kind` and `availableKinds`). Before this release such a graph defined without error, no row could ever be written through the edge, and every query or traversal over it returned nothing.

### Breaking

- Changed: a graph definition whose edge names an unregistered node kind throws at `defineGraph` time. Register the kind in `nodes`, or remove it from the edge's `from` / `to`.
