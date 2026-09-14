# Query DSL consolidation plan

Status: phases 1–4 implemented in the working tree on 2026-09-14. Phases 5–6 remain proposals.

## Objective

Make graph matching, relational expressions, result shaping, and read execution compose predictably. Preserve the
existing fluent traversal API and the simplified `batchOnce(read => [...])` surface. Fix incorrect contracts before
building new capabilities on them.

Success means callers can retrieve several independent subgraphs in one statement, filter and aggregate with
schema-aware expressions, distinguish traversal constraints from result filters, and combine projected queries without
losing their execution capabilities.

## Baseline before phases 1 and 2

- `batchOnce()` already embeds fluent queries, neighbors, neighbor counts, and subgraphs in one statement. Results
  remain separate and preserve input order.
- Its public input was a tuple with at least two members, which does not naturally accept a runtime-sized array.
- Batched subgraphs execute independent recursive plans. One statement does not imply shared traversal or shared
  hydration across roots.
- Direct and batched subgraphs share semantic planning, projection, and result assembly. Direct execution retains
  backend-tuned hydration: two statements on SQLite and three on PostgreSQL.
- Subgraphs already have `edgeWindows` for bounded, ordered relationships per endpoint. This is not a missing feature.
- The current transaction-read changes expose transaction-bound queries and graph reads. Build on that work; do not
  reintroduce another transaction API.
- Aggregation and subqueries still expose untyped string references. Aggregate and combined builders still differ from
  ordinary queries in preparation and execution capabilities.

## Design decisions

1. Keep `batchOnce()` as the public composition point for independent reads. Do not add `subgraphQuery()`,
   `neighborsQuery()`, or a second batching API.
2. Distinguish a database relation from a JavaScript result mapper. SQL operations consume typed expressions; arbitrary
   JavaScript runs after database execution.
3. Keep graph aliases and projected result columns as explicit scopes. Derived relations can be filtered and aggregated;
   graph traversal requires a graph-node binding, not an arbitrary projected object.
4. Preserve existing matching semantics. Introduce an explicit result-filter operation rather than silently changing
   `whereNode()` or `whereEdge()`.
5. Express a decision once in the shared compiler. Dialect differences stay in token-level adapter members; unsupported
   capabilities fail before execution.
6. A nonempty `batchOnce()` executes exactly one statement, or refuses. Empty batches execute zero statements. No
   automatic chunking, retries that rerun a read, or sequential fallback behind that contract.
7. Carry graph, execution-target, and temporal provenance with compiled reads. Composition must validate compatibility;
   compiling a read must not authorize rebinding it to an unrelated transaction.
8. Treat shared multi-root traversal as a measured optimization, not a prerequisite for multi-subgraph retrieval.

## Phase 1: Repair public contracts

### Work

- Make chained `having()` accumulate with AND, matching chained node and edge filters. Keep explicit logical expressions
  available for OR and NOT.
- Audit documentation and examples against actual public methods. Implement ordinary-query `first()`, `count()`, and
  `exists()` through SQL terminal operations; remove examples implying an unselected builder has a general-purpose
  `execute()`.
- Define `first()` as an optional first result, ordered only when ordering is specified. It must preserve a zero limit.
  Define terminal `count()` as the cardinality of the current SQL relation, including distinct/group/limit/offset;
  define `exists()` as whether that relation has any rows. Scalar `count()` and `exists()` terminals do not execute
  JavaScript result mappers; `first()` maps only the returned row.
- Correct equality and membership operand typing, preserving explicit compatible field references and parameters. Add
  runtime validation where dynamic inputs bypass compile-time evidence.
- Correct aggregate typing and decoding: count returns number; sum/average can be absent for empty input;
  minimum/maximum preserve valid scalar operand types. Normalize SQL NULL to undefined consistently.
- Correct impossible error suggestions, notably combined queries recommending an unavailable `prepare()`.
- Audit repeated source calls, alias collisions, limit validation, and accepted options so invalid builder states are
  refused rather than silently rewriting an existing query.

### Completion evidence

Every corrected behavior has a test demonstrated to fail under a reverted fix or a targeted mutation. Documentation
examples compile. Aggregate empty-input and scalar-type behavior is checked in the shared backend suite.

## Phase 2: Finish independent read composition

### Work

- Extend `batchOnce()` overloads to preserve heterogeneous tuple inference while accepting readonly runtime arrays,
  singleton tuples, and empty arrays.
- Preserve each request's root, options, projection, adjacency, and missing-root result. Repeated roots are separate
  requests, not an implicit deduplication instruction.
- Keep the same behavior on Store and transaction-bound reads. Validate the target and supported temporal coordinates
  before issuing SQL.
- Enforce request-count and bind-parameter budgets before execution. Document that JSON envelopes are materialized,
  response size depends on returned data, and there is no automatic response-byte cap or streaming API.
- Make batch compilation an explicit internal capability. Ensure unsupported read shapes are refused before any member
  executes.
- Add coverage for two or more subgraphs, including overlap, duplicate and missing roots, different projections, edge
  windows, temporal modes, and transaction-visible writes.

### Target use

```ts
const graphs = await store.batchOnce((read) =>
  roots.map((root) =>
    read.subgraph(root.id, {
      edges: ["knows"],
      maxDepth: 2,
    }),
  ),
);
```

This is a signature and contract extension of the existing implementation, not a new subgraph engine.

## Phase 3: Introduce typed database expressions

### Work

- Introduce expressions carrying value type, nullability, and scope. Use them for predicates, ordering, grouping,
  aggregate arguments, and projection.
- Add callback overloads for grouping, aggregates, and ordering. Keep legacy string helpers as adapters to the same
  expression representation during migration.
- Unify metadata, properties, nested JSON paths, parameters, and outer references. Callers should not need to spell
  internal `props` paths or provide raw ASTs for ordinary subqueries.
- Start with fields, literals, parameters, comparisons, Boolean composition, existing aggregates, arithmetic,
  coalescing, and conditional expressions. Give division-by-zero and numeric conversion explicit portable semantics.
- Add typed scalar and existence subqueries. Validate one-column scalar projections and use scoped outer references to
  prevent alias capture.
- Introduce explicit SQL projection (`project()`) and post-execution transformation (`map()`). Keep `select()` as the
  compatibility result-mapping surface initially; do not silently reinterpret existing callbacks as SQL.
- Make the explicit projection path independent of synthetic callback probing. Document purity requirements and
  execution behavior for legacy selectors.

### Completion evidence

Compile-time tests reject wrong operands, nonexistent fields, out-of-scope references, and incompatible subqueries.
Shared backend tests verify null, date, Boolean, JSON, and arithmetic semantics. Existing callbacks preserve their
behavior.

### Implemented boundaries

Explicit projections support execution, SQL inspection, scalar terminals, preparation, and `batchOnce()`. Prepared
binding names and values are validated at runtime; phase 4 adds typed preparation declarations on relations. Boolean
combinators conservatively include `undefined` in their result type. Scalar subqueries require one projected column
and an explicit limit of at most one row, unless the projection is an ungrouped aggregate. Existence subqueries
require a nonempty SQL projection. Both inherit and validate the enclosing temporal coordinate. JSON properties
that collide with expression members are accessible through `$get(key)`.

## Phase 4: Make relations compose across query stages

### Work

- Build a common internal relation representation for explicit projections, aggregates, set operations, and derived
  sources. Preserve specialized public types where they improve inference.
- Add output-column ordering and preparation for combined and aggregate relations. Carry these relations through
  `batchOnce()` without special execution implementations per builder.
- Apply UNION/INTERSECT/EXCEPT to explicit database projections, not hidden hydrated columns. Preserve operand result
  meaning and verify compatible column types and nullability.
- Support derived sources for filter-after-aggregate, aggregate-of-aggregate, and composition after set operations.
  Introduce graph traversal from derived results only with explicit node identity/type evidence.
- Add whole-projection `distinct()` before limiting or pagination. Deduplicating entities uses `(kind, id)` within graph
  scope; it must not silently choose one of several differing projected rows.
- Add an explicit node-identity deduplication operation only with a defined representative-row policy. Refuse ambiguous
  edge/path projections rather than selecting an arbitrary match.
- Expose common terminals and SQL inspection through shared execution infrastructure. Add pagination/streaming only for
  relations with a deterministic unique ordering; refuse unsupported shapes explicitly.
- Preserve prepared parameter types, null ordering, temporal pins, and projection decoding through every composition
  boundary.

### Completion evidence

Exercise union-then-order, union-then-limit, aggregate-then-filter, count-after-distinct, nullable aggregate ordering,
prepared composition, and batched derived queries on each backend. Check duplicate sort keys and empty results.

### Implemented boundaries

`asRelation()` enters output-column scope from explicit projections and compatibility aggregate queries. The shared
structural relation tree supports derived filters, projections and aggregates, scalar set equality, ordering, terminals,
preparation and one-statement batching. Legacy hydrated `select()` set operations retain their compatibility behavior.

`prepare(parameters)` infers binding names and values from a declaration of reused typed parameter expressions; it
validates that declaration against all source and derived parameters. Automatic recovery of binding types from every
earlier callback is not implemented. Undeclared `prepare()` retains its runtime-validated compatibility type.

`distinctNodes()` admits only proven kind/id projections from one node alias, with an identity-only representative
policy. It refuses extra payload, edge and path columns. Derived results do not introduce implicit graph traversal.
`page()` and `stream()` require whole-projection distinctness and direct ordering by every scalar output column exactly
once. They use bounded offset pages; stable results across concurrent writes require an appropriate transaction snapshot.

Checked relation execution is explicitly refused. Recorded coordinates survive direct execution and preparation, while
recorded one-statement batches retain their existing refusal. Structured or unresolved equality keys are refused for
distinct set operations and grouping; `unionAll()` can preserve structured values without comparing them.

## Phase 5: Clarify graph matching and result semantics

### Work

- Keep `whereNode()` and `whereEdge()` as match constraints. Document optional-target filtering as restricting matches
  while preserving unmatched roots.
- Add an explicit relation-level `where()` using scoped expressions. It filters completed matches, including optional
  and recursive results. On an optional alias, an ordinary comparison removes the absent row; an explicit absence check
  can retain it.
- For recursion, preserve expansion constraints at every hop and use relation-level filters for endpoints. Add
  stop-expansion behavior separately with explicit rules for whether the stopping node is emitted.
- Define row multiplicity throughout: one match row, one distinct entity, or one path. Explain fan-out effects on counts
  and sums and require explicit deduplication when intended.
- Make source alias selection explicit in reusable branching fragments. Document ontology expansion, traversal
  direction, and temporal defaults together.
- Separate ranked candidate generation from Boolean filtering in the plan and public guidance. Preserve current search
  helpers as adapters; do not pretend ranked top-k operations obey arbitrary OR/NOT semantics.
- Support multiple recursive traversals and richer path projections only after expansion/result stages have stable
  semantics. Path entities and edges must carry kind-qualified identities.

### Completion evidence

Use the same small fixture to contrast optional match versus result filtering, intermediate-node pruning versus endpoint
filtering, and row counts versus entity counts. Test top-k, traversal fan-out, explicit ordering, and final limits
together.

### Implemented boundaries

`whereNode()` and `whereEdge()` remain match constraints; recursive target and edge constraints apply at every hop.
Scoped-expression `where()` filters completed match rows after match expansion, including optional and recursive
results, and before grouping, ordering and limiting.

`stopExpansion(alias, predicate, { emitStopNode? })` independently stops a matching recursive branch. Stopping nodes
are emitted by default; `emitStopNode: false` omits them. Stop predicates are limited to ordinary fields on the
recursive target alias. Recursive queries still support one variable-length traversal, node-ID path output, and no
traversed-edge projection. Multiple recursive traversals and richer kind-qualified path entities remain deferred until
these boundaries can be preserved across their additional match rows.

## Phase 6: Measure and optimize multi-root subgraphs

### Work

- Compare direct hydration and the existing one-statement form across root count, depth, branching, neighborhood
  overlap, projections, and payload size. Include remote PostgreSQL latency as well as SQLite execution cost.
- Record statements, database time, total latency, rows/bytes transferred, and memory. One statement alone is not a
  performance result.
- Prototype a multi-root recursive plan for requests with compatible traversal options. Carry request identity and
  per-root depth/cycle state. Preserve separate results for repeated roots.
- Where measurements justify it, hydrate shared entities once and return membership separately. Keep per-request
  projections and temporal coordinates from being accidentally merged.
- Preserve per-endpoint edge windows in traversal and hydration. Never replace per-root reachability with a global union
  that loses root membership.
- Reuse the same semantic subgraph plan for direct, independently batched, and shared-root execution. Retain the tuned
  direct strategy unless evidence supports replacing it.

### Completion evidence

Verify identical results against independent subgraph calls and the existing batch form, including missing roots,
overlapping neighborhoods, cycles, windows, and projections. Measure representative workloads before making a new
strategy the default.

## Follow-on capabilities

After typed expressions and derived relations are established, add collection aggregation/nested relationship results,
window functions, and general top-N-per-group queries. Existing `edgeWindows` remains the bounded graph-read feature; do
not replace it merely to match a relational API shape.

Recorded-time batch composition needs an explicit view-bound builder and compatible recorded coordinates. Do not expose
a raw `recordedAsOf` option or weaken the current recorded-read boundary to make batching convenient.

## Delivery and migration

- Deliver phases 1 and 2 independently; neither requires the expression redesign.
- Deliver phase 3 as a foundation with a small complete expression surface, then extend it in phase 4. Avoid shipping
  partially supported expression nodes.
- Keep existing APIs as adapters during migration. Document any newly rejected invalid calls, corrected aggregate result
  types, and changed terminal availability in upgrade notes.
- Audit every consumer when changing shared return types, predicates, compilation, or decoding contracts. Include raw
  compilation, prepared queries, batch composition, transaction reads, and recorded views.
- Run `pnpm fix && pnpm typecheck && pnpm test` before committing. Run `pnpm test:postgres` for backend/store changes.
  Query semantics belong in shared backend tests; type behavior belongs in compile-time tests. Add mutation/revert
  evidence for regression tests.
- Update API reports, examples, query docs, and changesets in the same implementation change. Preserve unrelated
  working-tree changes.

## Recommended implementation order

1. Contract corrections and truthful documentation.
2. Runtime-array `batchOnce()` and multi-subgraph contract coverage.
3. Typed expressions and explicit SQL projection.
4. Relational composition, deduplication, and shared execution.
5. Match/result filtering and advanced recursion.
6. Measured shared-root execution and richer relational features.

The first two items give immediate value. The expression and relation work supplies the durable foundation; the final
optimization remains conditional on measured benefit.
