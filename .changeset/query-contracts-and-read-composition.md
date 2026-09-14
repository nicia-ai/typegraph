---
"@nicia-ai/typegraph": minor
---

Add query `count()` and `exists()` terminals and selected-query `first()`. Scalar terminals count or test the current SQL relation, including grouping, limits, and offsets, without invoking result selectors. Chained `having()` conditions now accumulate with AND. Offset-only queries compile consistently on SQLite and PostgreSQL.

Allow `batchOnce()` to accept runtime-sized readonly arrays, singleton tuples, and empty arrays. Nonempty batches execute one statement or refuse before execution; empty batches execute no statement. Independent subgraphs retain their own roots, projections, traversal windows, and results. Batches now validate graph and execution-target provenance, window-function support, the request count, and the backend's declared bind budget.

Introduce schema-aware database expressions for SQL projection, predicates, ordering, grouping, and aggregates. `project()` builds SQL once, while `map()` transforms decoded rows; legacy `select()` keeps its compatibility behavior, including callback probing; keep selectors pure. Expressions include nested JSON paths, metadata, parameters, arithmetic, coalescing, conditions, and typed correlated `$exists()` / `$scalar()` subqueries with scope and temporal validation. Explicit projections support scalar terminals, preparation, and one-statement batching. Document `batchOnce(read => roots.map(root => read.subgraph(root.id, options)))` as the recommended pattern for reducing round trips across several independent, bounded subgraphs.

Add explicit SQL relation composition for projected and aggregated results. Combine visible columns with set operations, filter and aggregate derived results, deduplicate whole projections, order output columns, and execute prepared or batched relations through shared infrastructure. Typed preparation declarations preserve binding names and values across composition boundaries. Grouped relations apply input distinctness, ordering, limits, and offsets before grouping; repeated `groupBy()` calls accumulate. Identity-only `distinctNodes()` deduplicates node identities, and relation paging and streaming require a proven unique order.

Add scoped `where()` filters for completed graph matches, independently of optional-match and recursive hop constraints. Add `stopExpansion()` with an explicit stopping-node emission policy. Preserve these stages in prepared queries, batches, and logical plans, and document ranked candidates, fanout, and distinct-entity counting.

Ranked candidate `k` no longer implicitly caps completed rows after traversal fanout, including set-operation operands. Use an explicit query `limit()` to bound the final row count.

Add opt-in shared subgraph hydration with `batchOnce(build, { shareSubgraphs: true })`. Compatible reads share a multi-root traversal and hydrated entities while preserving per-request membership, projections, temporal coordinates, edge windows, and independent result objects. Default batching retains independent plans; benchmark overlapping, payload-heavy roots before enabling sharing. All current-time reads built inside a batch use one pinned instant.

Add qualified recursive paths with `path: { format: "qualified", alias: "route" }`. The output alternates kind-qualified node references and edge references with traversal direction. Existing `path: true` and string aliases still return node-ID arrays.

Compose multiple recursive traversal stages with separate depth, path, cycle, and stop state. Later stages expand upstream source identities and preserve prior row multiplicity; final filters and ranges apply after composition. Fixed-hop stages compose before and after recursion, retaining fixed-edge properties. The first recursive stage can be optional and preserves roots without eligible endpoints. Scalar recursive-edge projections remain unsupported. Ordered recursive reads now retain their sort columns when embedded in `batchOnce()`.

Add transaction-bound `query()`, `neighbors()`, `countNeighbors()`, `subgraph()`, and `batchOnce()` reads. Every read executes through the open transaction and observes earlier writes in the callback; `tx.subgraph()` and `tx.batchOnce()` each execute as exactly one statement.

### Upgrade notes

Equality and membership predicates now require compatible operands, and invalid dynamic literals are rejected before SQL execution. Aggregate results preserve scalar field types and represent empty-input SQL NULL as `undefined`; handle absent sum, average, minimum, and maximum results. `countDistinct` accepts only string, number, Boolean, and date operands; replace structured JSON or array distinct counts with an explicit portable scalar projection. Query sources cannot be replaced mid-chain, aliases must be unique across nodes, edges, and recursive outputs, and limits and offsets must be non-negative safe integers. Cursor pagination refuses query-level limits/offsets and conflicting direction options instead of ignoring them. Subgraph depths must be integers from 0 through 1000; unsupported traversal directions and cycle policies are refused. Build batch reads from the executing Store or transaction context, and split requests explicitly if a single statement exceeds its planning budget.

Custom objects exposing only `toAst()` are no longer accepted as legacy set-operation operands: operands must also supply execution provenance. Use queries created by the same Store or transaction so graph and execution-target compatibility can be verified.

Staged `whereNode()` and `whereEdge()` predicates now refuse cross-alias references instead of compiling incorrect comparisons; use completed-row `where()` for those conditions, accounting for its optional-row filtering behavior. Raw composed `resultPredicate` ASTs must use database-expression predicates, optionally combined with AND/OR/NOT.
