---
title: Graph Algorithms
description: Shortest path (weighted and unweighted), reachability, neighborhoods, degree, and weakly connected components on store.algorithms
---

Graph queries like "are Alice and Bob connected?" or "who is within two hops
of this node?" are common enough that writing them as recursive CTEs by hand
gets repetitive. TypeGraph exposes the high-utility algorithms as a small
facade on the store:

```typescript
store.algorithms.shortestPath(alice, bob, { edges: ["knows"] });
store.algorithms.weightedShortestPath(alice, bob, {
  edges: ["knows"],
  weightProperty: "strength",
});
store.algorithms.reachable(alice, { edges: ["knows"] });
store.algorithms.canReach(alice, bob, { edges: ["knows"] });
store.algorithms.neighbors(alice, { edges: ["knows"], depth: 2 });
store.algorithms.degree(alice, { edges: ["knows"] });
store.algorithms.weaklyConnectedComponents({
  edges: ["knows"],
  nodeKinds: ["Person"],
});
```

Traversal calls use a set-based breadth-first frontier. Each level expands the
current `(id, kind)` set with a bind-limit-aware SQL query. Transactional
backends keep the visited set in a temporary working table; backends without a
pinned transaction use a chunked inline working relation. Each node is admitted
only at its minimum depth. Reachability rounds deduplicate edge targets before
checking target-node visibility and do not compute unused predecessors.
`shortestPath` and `canReach` search from both endpoints, retain predecessors for
path reconstruction, and stop when the frontiers meet.
`degree` remains a single `COUNT` query. The algorithms work identically on
SQLite and PostgreSQL.

## When to Reach for Algorithms

| You want to... | Use |
|----------------|-----|
| Find the fewest-hop route between two nodes | `shortestPath` |
| Find the cheapest route by a numeric edge property | `weightedShortestPath` |
| List every node reachable from a source | `reachable` |
| Check whether a node is reachable at all | `canReach` |
| Get the k-hop neighborhood of a node | `neighbors` |
| Count incident edges (in, out, or both) | `degree` |
| Partition all visible nodes by undirected connectivity | `weaklyConnectedComponents` |
| Filter, sort, or project over traversal results | `.query().traverse()` / `.recursive()` |
| Hydrate an entity plus all its relationships | `store.subgraph()` |

Traversal algorithms return lightweight `{ id, kind, depth }` records rather
than fully hydrated nodes. WCC returns one
`{ id, kind, componentId, componentKind, size }` membership per visible node.
Use `store.nodes.<Kind>.getByIds(...)` when you need the full node data.

## Shared Options

Every traversal algorithm takes the same base options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `edges` | `readonly EdgeKinds<G>[]` | *(required)* | Edge kinds to follow |
| `maxHops` | `number` | `10` | Maximum traversal depth (1 – 1000) |
| `direction` | `"out" \| "in" \| "both"` | `"out"` | Edge direction |
| `cyclePolicy` | `"prevent" \| "allow"` | `"prevent"` | Compatibility option; both values use set-based node de-duplication |
| `temporalMode` | `TemporalMode` | `graph.defaults.temporalMode` | Filter applied to nodes and edges along the traversal — see [Temporal Behavior](#temporal-behavior) |
| `asOf` | `string` (ISO-8601) | *(none)* | Snapshot timestamp, required when `temporalMode: "asOf"` |
| `workingMemory` | `string` | *(inherits server `work_mem`)* | Opt-in, transaction-scoped `work_mem` override for iterative rounds on PostgreSQL (`SET LOCAL` semantics); validated as `<digits>kB\|MB\|GB` within 64kB–2147483647kB, ignored by SQLite |

`direction: "both"` treats edges as undirected. `cyclePolicy` remains accepted
for compatibility with recursive query-builder traversals, but it does not
change these algorithms: their node-set results and shortest paths never need
to revisit a node.

## shortestPath

Finds the fewest-hop path from `from` to `to`. Returns `undefined` when no
path exists within `maxHops`.

```typescript
const path = await store.algorithms.shortestPath(alice, bob, {
  edges: ["knows"],
  maxHops: 6,
});

if (path) {
  console.log(`${path.depth} hops:`, path.nodes.map((n) => n.id));
}
```

The result contains the ordered sequence of nodes (endpoints inclusive) and
the hop count:

```typescript
type ShortestPathResult = Readonly<{
  nodes: readonly Readonly<{ id: string; kind: string }>[];
  depth: number;
}>;
```

Source equal to target returns a zero-length path containing just that
node. Endpoints that don't pass the resolved temporal filter return
`undefined` — see [Temporal Behavior](#temporal-behavior).

## weightedShortestPath

Finds the minimum-total-weight path from `from` to `to`, weighting each
traversed edge by a numeric property stored on it. This is the shape of
LDBC's "trusted connection paths" query (Interactive IC14): the cheapest
route where each hop's cost reflects, say, interaction strength — which is
usually not the fewest-hop route.

```typescript
const path = await store.algorithms.weightedShortestPath(alice, bob, {
  edges: ["knows"],
  weightProperty: "interactionCost",
  direction: "both",
});

if (path) {
  console.log(`weight ${path.totalWeight} over ${path.depth} hops`);
}
```

```typescript
type WeightedShortestPathResult = Readonly<{
  nodes: readonly Readonly<{ id: string; kind: string }>[];
  depth: number; // hop count, nodes.length - 1
  totalWeight: number; // sum of traversed edge weights
}>;
```

Options differ from the unweighted traversals:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `edges` | `readonly EdgeKinds<G>[]` | *(required)* | Edge kinds to follow |
| `weightProperty` | `string` | *(required)* | Top-level edge property holding each edge's non-negative numeric weight |
| `defaultWeight` | `number` | *(none)* | Substituted for edges missing the property; must be finite and non-negative |
| `direction` | `"out" \| "in" \| "both"` | `"out"` | Edge direction |
| `maxIterations` | `number` | `1000` | Relaxation-round backstop; exceeding it throws `GraphAlgorithmConvergenceError` |
| `temporalMode` / `asOf` / `workingMemory` | | | Same as the shared options above |

There is no `maxHops`: cost-ordered search does not settle nodes in hop
order, so a hop bound is not a natural stopping rule here. The algorithm
relaxes frontier nodes round by round (with parallel edges collapsing to
their cheapest member), prunes any candidate that already costs at least as
much as a known path to the target, and stops when no distance improves.

**Weights are validated up front.** Before any traversal rounds run, every
visible edge of the selected kinds is audited; the call throws a typed
`InvalidEdgeWeightError` naming the offending edge when a weight is:

- **negative** — the pruning that makes the search terminate early assumes
  non-negative weights, so they are rejected rather than silently mis-answered;
- **non-numeric** — a JSON string like `"5"` does not count; the property
  must be stored as a JSON number;
- **missing** without a configured `defaultWeight`.

The audit covers the selected edge kinds globally (not just edges the
traversal happens to reach), so a data problem fails deterministically no
matter which endpoints you query. Weight arithmetic uses IEEE 754 double
precision on both backends, so paths and totals are backend-identical.

## reachable

Returns every node reachable from `from` within `maxHops`, annotated with
the shortest depth at which it was discovered.

```typescript
const reachable = await store.algorithms.reachable(alice, {
  edges: ["knows"],
  maxHops: 3,
});
// [{ id, kind, depth: 0 }, { id, kind, depth: 1 }, ...]
```

Pass `excludeSource: true` to drop the zero-depth source entry. Results are
sorted by ascending depth.

## canReach

Fast boolean check that uses the same balanced bidirectional BFS as
`shortestPath` and stops as soon as the two visited sets meet.

```typescript
const connected = await store.algorithms.canReach(alice, bob, {
  edges: ["knows"],
  maxHops: 6,
});
```

Use this when you only care whether a path exists. It shares the same search
cost as `shortestPath` but does not return the reconstructed path.

## neighbors

The k-hop neighborhood of a node, with the source always excluded. `depth`
defaults to `1`, so `neighbors(alice)` returns Alice's immediate
connections.

```typescript
const immediate = await store.algorithms.neighbors(alice, {
  edges: ["knows"],
});

const twoHop = await store.algorithms.neighbors(alice, {
  edges: ["knows"],
  depth: 2,
});
```

Semantically equivalent to `reachable({ maxHops: depth, excludeSource: true })`,
but the name reads more naturally for neighborhood queries.

## degree

Counts edges incident to a node under the resolved temporal filter.
Self-loops contribute once when `direction` is `"both"`.

```typescript
const friends = await store.algorithms.degree(alice, {
  edges: ["knows"],
  direction: "out",
});

const connections = await store.algorithms.degree(alice, {
  edges: ["knows"],
  // direction: "both" is the default
});

const everything = await store.algorithms.degree(alice);
// No `edges` option counts all edge kinds in the graph
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `edges` | `readonly EdgeKinds<G>[]` | all kinds | Edge kinds to count (empty array returns 0) |
| `direction` | `"out" \| "in" \| "both"` | `"both"` | Count outgoing, incoming, or either |
| `temporalMode` | `TemporalMode` | `graph.defaults.temporalMode` | Filter applied to the counted edges |
| `asOf` | `string` (ISO-8601) | *(none)* | Snapshot timestamp, required when `temporalMode: "asOf"` |

`degree` runs a single `COUNT` query, not a recursive CTE, so it's
efficient even for hub nodes with thousands of edges.

## weaklyConnectedComponents

Computes an exact partition over the undirected projection of the selected edge
kinds. By default every visible node is returned. `nodeKinds` restricts the
operation to the induced subgraph over those kinds; an in-scope node with no
selected incident edge forms a singleton component.

```typescript
const memberships =
  await store.algorithms.weaklyConnectedComponents({
    edges: ["knows", "worksAt"],
    nodeKinds: ["Person", "Company"], // optional; all kinds by default
    maxIterations: 1000, // default
  });
// [{ id, kind, componentId, componentKind, size }, ...]
```

The component identity is the smallest `(id, kind)` member under portable
binary ordering. Results and representatives are therefore deterministic on
SQLite and PostgreSQL even when the PostgreSQL database uses a linguistic
default collation. Edges are always treated as undirected—WCC has no
`direction` option.

WCC is iterative and runs multiple SQL rounds in one repeatable snapshot. It
requires `backend.capabilities.graphAnalytics?.supported === true`; built-in
transactional SQLite and PostgreSQL backends advertise support. Other backends
throw `UnsupportedBackendCapabilityError` before temporary state is created. If
propagation has not converged after `maxIterations`, TypeGraph throws
`GraphAlgorithmConvergenceError` rather than returning a partial partition.

PostgreSQL refreshes planner statistics for a sufficiently large temporary
working table and refreshes them again after multiplicative growth. This avoids
plans based on PostgreSQL's initial one-row estimate for a new temporary table.
The policy is automatic, applies to WCC and growing traversal frontiers, and is
a no-op on SQLite.

Iterative operations (WCC and the working-table traversals) accept an opt-in
`workingMemory` override of the session's `work_mem` for their rounds. When
set, it is applied with `SET LOCAL work_mem` semantics inside the operation's
own transaction — the session and server settings are never modified, and the
override ends with the transaction. When omitted (the default), operations
inherit the server's configured `work_mem`.

Note that `work_mem` is a threshold each sort/hash operator (and each parallel
worker) may allocate up to, **not** a per-operation budget: a single round can
allocate several multiples of it, and concurrent algorithm calls multiply
again. Raise it deliberately — for example `workingMemory: "64MB"` keeps
whole-graph rounds from spilling their sorts to disk on large single-tenant
analytical runs (such as LDBC SNB SF1-scale benchmarks) — rather than as a
blanket setting on a shared cluster. The value must be a plain integer with a
`kB`, `MB`, or `GB` suffix within PostgreSQL's accepted `work_mem` range
(64kB to 2147483647kB) — both backends reject malformed or out-of-range
values with the same error. SQLite validates and otherwise ignores it.

Without `nodeKinds`, WCC seeds every visible node, so unrelated nodes still
appear as singleton components. On heterogeneous graphs, pass the kinds that
define the graph being analyzed. For example, `{ edges: ["knows"], nodeKinds:
["Person"] }` avoids seeding posts and comments while retaining isolated people.

Temporal views expose the same facade with the coordinate sealed:

```typescript
const historical = await store
  .asOf("2024-01-01T00:00:00.000Z")
  .algorithms.weaklyConnectedComponents({ edges: ["knows"] });
```

## Passing Nodes or IDs

Every node-oriented algorithm accepts either a raw ID string or any object with
an `id: string` field — `Node`, `NodeRef`, the lightweight records returned by
traversals, and `store.subgraph()` results all work. WCC is a whole-graph
operation and does not take a node identifier.

```typescript
const alice = await store.nodes.Person.getById(aliceId);

// All equivalent
store.algorithms.canReach(alice, bobId, { edges: ["knows"] });
store.algorithms.canReach(alice.id, bobId, { edges: ["knows"] });
store.algorithms.canReach(aliceId, { kind: "Person", id: bobId }, {
  edges: ["knows"],
});
```

## Direction and Cycles

`direction: "both"` lets you treat a directed edge kind as undirected for
reachability questions:

```typescript
// Did Dave ever know Alice, regardless of who "added" whom first?
const knew = await store.algorithms.canReach(dave, alice, {
  edges: ["knows"],
  direction: "both",
});
```

Cycles cannot multiply work: a node enters the visited set once, at its minimum
depth. This differs from `.recursive()`, whose path-returning semantics use the
per-path behavior described in
[Cycle Detection](/queries/recursive#cycle-detection). The algorithm
`cyclePolicy` option is therefore compatibility-only.

## Depth Limits

`maxHops` is capped at `MAX_EXPLICIT_RECURSIVE_DEPTH` (1000). The default of 10
covers typical connectivity questions on most graphs. Within that bound,
single-source traversal examines each reached node once and each incident edge
at most once per direction, rather than enumerating paths.

Each expanded level costs a database round trip (inline working relations are
split to respect the backend bind limit). Transactional backends keep those
statements in one snapshot and drop their temporary working table in a
`finally` cleanup; non-transactional backends use their normal best-effort
multi-statement behavior. The application-clock valid-time instant is pinned
once for the whole traversal, and recorded-time views remain pinned to their
requested recorded coordinate.

## Temporal Behavior

Algorithms honor the same temporal model as the rest of the store. The
default temporal mode is `graph.defaults.temporalMode` (typically
`"current"`), and every algorithm accepts per-call `temporalMode` and
`asOf` options.

```typescript
// Default: uses graph.defaults.temporalMode — typically "current".
await store.algorithms.shortestPath(alice, bob, { edges: ["knows"] });

// Snapshot at a specific point in time. Both nodes and edges must have
// been valid at that timestamp to participate in the traversal.
await store.algorithms.shortestPath(alice, bob, {
  edges: ["knows"],
  temporalMode: "asOf",
  asOf: "2023-01-15T00:00:00.000Z",
});

// Include validity-ended (but not soft-deleted) rows — useful for
// historical traversal without needing a specific timestamp.
await store.algorithms.reachable(alice, {
  edges: ["knows"],
  temporalMode: "includeEnded",
});

// Include soft-deleted rows too. Traversal can cross through tombstones.
await store.algorithms.canReach(alice, ghost, {
  edges: ["knows"],
  temporalMode: "includeTombstones",
});
```

**Semantic rules:**

- The temporal filter applies to **both nodes and edges** along the
  traversal. An edge can only be traversed if it passes the filter *and*
  its endpoint node passes too.
- `asOf` is required when `temporalMode: "asOf"` and rejected (throws
  `ValidationError`) in every other mode — pinning an instant is only
  meaningful in `"asOf"` mode.
- Temporal filtering is orthogonal to `cyclePolicy` — cycle detection
  operates on path membership, not on time. A node that was valid → ended
  → re-valid is not treated as "visited" just because it appears in two
  validity periods.
- The shortest-path self-path short-circuit also respects the resolved
  mode: calling `shortestPath(a, a, ...)` returns `undefined` if node `a`
  does not pass the temporal filter, and a zero-hop result otherwise.

## End-to-End Example

The runnable example
[`examples/14-research-copilot.ts`](https://github.com/nicia-ai/typegraph/blob/main/packages/typegraph/examples/14-research-copilot.ts)
combines every algorithm with semantic search and ontology-expanded topic
matching over a corpus of landmark ML papers. It produces an
explainable literature-review digest in one run against a single SQLite
file — a good starting point for your own RAG + graph workloads.

## What's Not Included

These algorithms cover shortest path (weighted and unweighted),
reachability, neighborhoods, degree, and weakly connected components. They
do **not** cover:

- Strongly connected components
- Topological sort
- Centrality measures beyond degree (betweenness, closeness, eigenvector)
- PageRank or community detection

For those, export edges via `.query().traverse()` or `store.subgraph()` and
use a specialized library such as
[graphology](https://graphology.github.io/) in memory. See
[Limitations](/limitations#graph-analytics-limits) for the full list
of excluded analytics.
