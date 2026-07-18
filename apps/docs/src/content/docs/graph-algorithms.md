---
title: Graph Algorithms
description: Traversal, connectivity, label propagation, and PageRank on store.algorithms
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
store.algorithms.labelPropagation({
  edges: ["knows"],
  nodeKinds: ["Person"],
});
store.algorithms.pageRank({ edges: ["knows"], nodeKinds: ["Person"] });
store.algorithms.personalizedPageRank({
  edges: ["knows"],
  seeds: [{ id: alice.id, kind: "Person" }],
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
`degree` remains a single `COUNT` query. Exact algorithms behave identically on
SQLite and PostgreSQL; PageRank follows the numerical-tolerance contract below.

The inline fallback is intentionally limited to bounded traversals. Whole-graph
iterative algorithms such as WCC, label propagation, and PageRank require a pinned transactional connection and
fail through their typed capability gate when one is unavailable; they never
silently switch to a second full algorithm implementation.

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
| Find deterministic communities by neighbor-label voting | `labelPropagation` |
| Rank nodes by global structural importance | `pageRank` |
| Rank nodes relative to weighted seed nodes | `personalizedPageRank` |
| Filter, sort, or project over traversal results | `.query().traverse()` / `.recursive()` |
| Hydrate an entity plus all its relationships | `store.subgraph()` |

Traversal algorithms return lightweight `{ id, kind, depth }` records rather
than fully hydrated nodes. WCC returns one
`{ id, kind, componentId, componentKind, size }` membership per visible node.
Label propagation returns `{ id, kind, labelId, labelKind }` memberships.
PageRank returns `{ id, kind, score }` records ordered by descending score.
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
When several minimum-hop paths exist, predecessor and meeting-node ties use
the smallest `(id, kind)` identity under portable binary ordering, so the
selected path is identical across backends and execution strategies.

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
| `defaultWeight` | `number` | *(none)* | Substituted for edges missing the property; must be non-negative and within the audit's upper bound (~9.7e289) |
| `direction` | `"out" \| "in" \| "both"` | `"out"` | Edge direction |
| `maxIterations` | `number` | `1000` | Relaxation-round backstop; exceeding it throws `GraphAlgorithmConvergenceError` |
| `temporalMode` / `asOf` / `workingMemory` | | | Same as the shared options above |

There is no `maxHops`: cost-ordered search does not settle nodes in hop
order, so a hop bound is not a natural stopping rule here. The algorithm
relaxes frontier nodes round by round (with parallel edges collapsing to
their cheapest member), prunes any candidate costing strictly more than a
known path to the target — equal-cost candidates stay in play so every
equal-cost route to the target is considered — and stops when no distance
improves.

**Weights are validated up front.** Before any traversal rounds run, every
visible edge of the selected kinds is audited; the call throws a typed
`InvalidEdgeWeightError` naming the offending edge when a weight is:

- **negative** — the pruning that makes the search terminate early assumes
  non-negative weights, so they are rejected rather than silently mis-answered;
- **non-numeric** — a JSON string like `"5"` does not count; the property
  must be stored as a JSON number (a JSON `null` counts as missing, not
  non-numeric);
- **out of range** — a magnitude above ~9.7e289 (bounded so path sums can
  never overflow the double range, on either backend) or a nonzero
  magnitude below the smallest IEEE 754 double. One engine caveat:
  SQLite's JSON parser rounds sub-denormal text like `1e-400` to `0`
  before SQL can observe it, so only PostgreSQL can reject that case;
- **missing** without a configured `defaultWeight`.

The audit covers the selected edge kinds globally (not just edges the
traversal happens to reach), so a data problem fails deterministically no
matter which endpoints you query. Weight arithmetic uses IEEE 754 double
precision on both backends: total weights are always backend-identical,
and — unless a single call's `edges` list exceeds the backend's
bind-parameter budget (hundreds of kinds, where equal-weight predecessor
ties can resolve differently) — so is the returned node sequence.

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

## PageRank and Personalized PageRank

`pageRank` scores every visible node by the stationary probability of a random
walk over the selected edges. `personalizedPageRank` uses the same power
iteration but teleports to weighted seed nodes instead of uniformly across the
graph. Both methods operate on the visible induced graph; `nodeKinds` can narrow
that graph without allowing transitions through excluded nodes.

```typescript
const globalScores = await store.algorithms.pageRank({
  edges: ["knows", "cites"],
  nodeKinds: ["Person", "Paper"],
  direction: "out",
});

const relatedToAlice = await store.algorithms.personalizedPageRank({
  edges: ["knows"],
  direction: "both",
  seeds: [
    { id: alice.id, kind: "Person", weight: 3 },
    { id: bob.id, kind: "Person" }, // weight defaults to 1
  ],
});
// [{ id, kind, score }, ...] — highest score first
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `edges` | `readonly EdgeKinds<G>[]` | *(required)* | Edge kinds defining transitions |
| `nodeKinds` | `readonly NodeKinds<G>[]` | all visible kinds | Induced node subgraph to rank |
| `direction` | `"out" \| "in" \| "both"` | `"out"` | Follow stored, reversed, or undirected transitions |
| `dampingFactor` | `number` in `[0, 1)` | `0.85` | Probability of following an edge rather than teleporting |
| `tolerance` | positive finite `number` | `1e-8` | Maximum per-node score change accepted as convergence |
| `maxIterations` | positive integer | `1000` | Power-iteration backstop; exceeding it throws |
| `workingMemory` | PostgreSQL memory string | inherited | Same transaction-scoped override described above |

Personalized seeds are qualified by the full `(kind, id)` identity so same-ID
nodes of different kinds remain distinct. Seed weights must be finite and
positive; duplicates are combined and the vector is normalized. A seed outside
the temporal/node-kind scope throws `ConfigurationError` instead of silently
losing teleport mass.

Dangling-node mass is redistributed through the same teleport vector, keeping
the scores normalized to approximately one. Parallel physical edges retain
their multiplicity. With `direction: "both"`, a physical self-loop contributes
once rather than once per expansion direction.

PageRank uses double-precision arithmetic on both backends. Repeated runs on
SQLite are deterministic; on PostgreSQL a plan change between runs can reorder
floating-point summation and shift scores by a few last bits, which can reorder
near-tied rows. SQLite and PostgreSQL scores are expected to agree within the
requested numerical tolerance rather than bit-for-bit. Exact score ties use
portable binary `(id, kind)` ordering. As with WCC, an exhausted iteration
budget throws `GraphAlgorithmConvergenceError`—partial scores are never
returned.

Convergence needs roughly `ln(1/tolerance) / ln(1/dampingFactor)` rounds in the
worst case. With the default `tolerance` and `maxIterations`, damping factors
above roughly `0.985` cannot converge in time — every round still runs against
the full working table before the budget-exhaustion error is thrown — so raise
`maxIterations` (or loosen `tolerance`) alongside a high damping factor. The
tolerance is also absolute: typical scores are on the order of `1/N`, so
reliably ranking the low-score tail of a large graph calls for a
proportionally smaller tolerance.

## labelPropagation

Runs deterministic synchronous Community Detection using Label Propagation
(CDLP) over the undirected projection of selected edge kinds. Each visible node
starts with its own `(id, kind)` identity as its label. A round adopts the most
frequent label among the node's visible neighbors from the previous round;
equal vote counts resolve to the minimum label under portable binary ordering.

```typescript
const memberships = await store.algorithms.labelPropagation({
  edges: ["knows", "worksAt"],
  nodeKinds: ["Person", "Company"], // optional; all kinds by default
  maxIterations: 1000, // default
  onMaxIterations: "throw", // default; "return" accepts the fixed-round labeling
});
// [{ id, kind, labelId, labelKind }, ...]
```

The graph is a neighbor set for voting: parallel edges and repeated selected
edge kinds do not multiply a vote, and self-loops do not make a node its own
neighbor. An isolated in-scope node therefore retains its initial label.
Labels and vote counts are exact integers, and edge-kind chunks are accumulated
before a label is staged, so results do not depend on bind limits or chunk
order. Changed-node frontiers restrict each later round to nodes whose neighbor
labels may have changed.

Synchronous voting has no self-vote, so structures whose neighborhoods mirror
each other never converge — they alternate between two labelings forever. This
covers every tree-shaped component (an isolated edge pair, a path, a star, an
org-chart hierarchy), every even-length cycle, and complete bipartite blocks;
empirically most sparse random graphs contain at least one such component.
One oscillating component anywhere in the selection prevents global
convergence, and raising `maxIterations` cannot help. Dense neighborhoods
built on odd cycles — triangles, cliques, and communities of them — converge.

`onMaxIterations` selects the completion contract:

- `"throw"` (default) returns only a converged labeling. A detected
  period-two oscillation throws `GraphAlgorithmConvergenceError` immediately
  rather than burning the remaining budget, and exhausting `maxIterations`
  throws the same typed error. Partial labelings are never returned.
- `"return"` yields the labeling after exactly `maxIterations` synchronous
  rounds (or at convergence, whichever comes first) — the fixed-round
  contract of the LDBC Graphalytics CDLP benchmark. Synchronous rounds are
  deterministic and chunk-independent, so this labeling is exact and
  identical on SQLite and PostgreSQL. Use it for tree-shaped or mixed data
  where a converged labeling need not exist; a detected oscillation
  fast-forwards to the parity-exact final labeling instead of running every
  remaining round.

Like WCC and PageRank, label propagation requires
`backend.capabilities.graphAnalytics?.supported === true`, runs in one
repeatable snapshot, honors temporal and recorded-time views, and accepts the
transaction-scoped `workingMemory` option.

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
SQLite and PostgreSQL connections that permit temporary tables advertise
support. Cloudflare D1, Durable Objects SQLite, `neon-http`, and other
restricted backends throw `UnsupportedBackendCapabilityError` before temporary
state is created. If propagation has not converged after `maxIterations`, TypeGraph throws
`GraphAlgorithmConvergenceError` rather than returning a partial partition.

Each round expands only the indexed frontier of nodes whose label changed in
the previous round. Candidate labels remain staged until every edge-kind chunk
has run, preserving synchronous and bind-limit-independent iteration semantics;
only changed rows are written back. Late convergence rounds therefore avoid
rescanning the full edge set and do not churn unchanged working rows.

PostgreSQL refreshes planner statistics for a sufficiently large temporary
working table and refreshes them again after multiplicative growth. This avoids
plans based on PostgreSQL's initial one-row estimate for a new temporary table.
The policy is automatic, applies to WCC, label propagation, PageRank, and growing traversal frontiers, and is
a no-op on SQLite.

Iterative operations (WCC, label propagation, PageRank, and the working-table traversals) accept an opt-in
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
operation and does not take a node identifier. Global PageRank is also
whole-graph; personalized PageRank instead takes explicit `{ id, kind, weight? }`
seed identities.

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
reachability, neighborhoods, degree, weakly connected components,
deterministic label propagation, and global and personalized PageRank. They
do **not** cover:

- Strongly connected components
- Topological sort
- Centrality measures beyond degree (betweenness, closeness, eigenvector)
- Modularity-optimizing community detection such as Leiden or Louvain

For those, export edges via `.query().traverse()` or `store.subgraph()` and
use a specialized library such as
[graphology](https://graphology.github.io/) in memory. See
[Limitations](/limitations#graph-analytics-limits) for the full list
of excluded analytics.
