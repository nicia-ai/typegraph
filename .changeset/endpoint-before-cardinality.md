---
"@nicia-ai/typegraph": patch
---

An edge write onto an endpoint that is no longer live now raises `EndpointNotFoundError` on every backend when the same write would also exceed a `cardinality` or `targetCardinality` bound (#946). Before, the refusal depended on the backend and the edge kind. On SQLite and libSQL, `create()` and `getOrCreateByEndpoints()` on a kind declaring one constrained axis raised `CardinalityError`, because the claim statement ran ahead of the endpoint-guarded INSERT; on PostgreSQL, where one statement evaluates both, they raised `EndpointNotFoundError`. On every backend, the same two methods on a durable-identity kind with a declared cardinality probed the axis without reading the endpoints and raised `CardinalityError`. The bulk forms and import already reported the endpoint.

The cardinality decision now checks the endpoints before it refuses, whenever the write had not already checked them, so the endpoint reads happen only on the refusal path. A successful create runs the same statements as before. A taken axis with live endpoints still raises `CardinalityError`. For a one-axis kind on SQLite and libSQL, and for a durable-identity kind on every backend, that refusal now costs one extra locked endpoint read. A `getOrCreateByEndpoints()` onto a non-live endpoint no longer retries: the endpoint refusal is not one of the races its retry exists for.
