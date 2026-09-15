---
"@nicia-ai/typegraph": minor
---

Add `expr.collect(value, { orderBy: [...] })` for ordered scalar collection aggregation. Project a relation, group by its parent columns, and collect string, number, Boolean, or date values into typed readonly arrays. Collection ordering is explicit and independent of result-row ordering; duplicates and nullable elements are preserved. Empty ungrouped collection aggregates return `[]`.

Export `CollectOptions<Scope>` for reusable helpers and expose collection expressions as their own `kind: "collect"` node. Ordinary aggregate nodes do not carry collection-only options.

Collection results compose with preparation, projection, and one-statement batching. Structured equality restrictions continue to apply, and collections are materialized without implicit truncation. Object elements and aggregate-local limits are outside this scalar API.

Custom dialect adapters must implement `orderedScalarJsonArray()` with ordering and empty-input semantics. Collection reads require `capabilities.orderedAggregates: true`; bundled PostgreSQL declares support, and supported preparable synchronous SQLite clients and the async libSQL factory probe for support at construction. Other unprobed SQLite connections remain unsupported unless their capability is explicitly declared after verification. Existing reads are unaffected.
