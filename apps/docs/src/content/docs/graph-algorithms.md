---
title: Graph Algorithms
description: Shortest path, reachability, neighborhoods, and degree on store.algorithms
---

Graph queries like "are Alice and Bob connected?" or "who is within two hops
of this node?" are common enough that writing them as recursive CTEs by hand
gets repetitive. TypeGraph exposes the high-utility algorithms as a small
facade on the store:

```typescript
store.algorithms.shortestPath(alice, bob, { edges: ["knows"] });
store.algorithms.reachable(alice, { edges: ["knows"] });
store.algorithms.canReach(alice, bob, { edges: ["knows"] });
store.algorithms.neighbors(alice, { edges: ["knows"], depth: 2 });
store.algorithms.degree(alice, { edges: ["knows"] });
```

Each call compiles to a single `WITH RECURSIVE` CTE (or a plain `COUNT` for
`degree`), using the same path-tracking and cycle-detection machinery as
`.recursive()` and `store.subgraph()`. The algorithms work identically on
SQLite and PostgreSQL.

## When to Reach for Algorithms

| You want to... | Use |
|----------------|-----|
| Find the fewest-hop route between two nodes | `shortestPath` |
| List every node reachable from a source | `reachable` |
| Check whether a node is reachable at all | `canReach` |
| Get the k-hop neighborhood of a node | `neighbors` |
| Count incident edges (in, out, or both) | `degree` |
| Filter, sort, or project over traversal results | `.query().traverse()` / `.recursive()` |
| Hydrate an entity plus all its relationships | `store.subgraph()` |

The algorithms return lightweight `{ id, kind, depth }` records rather than
fully hydrated nodes. Use `store.nodes.<Kind>.getByIds(...)` when you need
the full node data.

## Shared Options

Every traversal algorithm takes the same base options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `edges` | `readonly EdgeKinds<G>[]` | *(required)* | Edge kinds to follow |
| `maxHops` | `number` | `10` | Maximum traversal depth (1 – 1000) |
| `direction` | `"out" \| "in" \| "both"` | `"out"` | Edge direction |
| `cyclePolicy` | `"prevent" \| "allow"` | `"prevent"` | Skip visited nodes per path |
| `temporalMode` | `TemporalMode` | `graph.defaults.temporalMode` | Filter applied to nodes and edges along the traversal — see [Temporal Behavior](#temporal-behavior) |
| `asOf` | `string` (ISO-8601) | *(none)* | Snapshot timestamp, required when `temporalMode: "asOf"` |

`direction: "both"` treats edges as undirected. `cyclePolicy: "allow"` skips
cycle tracking and relies solely on `maxHops` to terminate — use it only
when you know the graph is acyclic or you want maximum raw performance.

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

Fast boolean check that short-circuits with `LIMIT 1` so the database stops
traversing as soon as it finds the target.

```typescript
const connected = await store.algorithms.canReach(alice, bob, {
  edges: ["knows"],
  maxHops: 6,
});
```

Use this when you only care whether a path exists — it's cheaper than
`shortestPath` because it never decodes the path.

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

## Passing Nodes or IDs

Every algorithm accepts either a raw ID string or any object with an
`id: string` field — `Node`, `NodeRef`, the lightweight records returned by
these algorithms, and `store.subgraph()` results all work:

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

Cycles are prevented by default. The underlying CTE tracks visited nodes
per path (the same mechanism described in
[Cycle Detection](/queries/recursive#cycle-detection) for `.recursive()`).
Switch to `cyclePolicy: "allow"` only when you're confident the traversal
terminates via `maxHops` alone.

## Depth Limits

`maxHops` is capped at `MAX_EXPLICIT_RECURSIVE_DEPTH` (1000) to prevent
runaway queries. The default of 10 covers typical connectivity questions on
most graphs. Graphs with branching factor *B* produce O(*B*^depth) rows
before cycle detection can prune them, so raise `maxHops` deliberately.

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
  asOf: "2023-01-15T00:00:00Z",
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
- `asOf` is required when `temporalMode: "asOf"` and ignored in every
  other mode.
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

These algorithms cover shortest path, reachability, neighborhoods, and
degree. They do **not** cover:

- Weighted shortest path (Dijkstra / A*)
- Connected components or strongly connected components
- Topological sort
- Centrality measures beyond degree (betweenness, closeness, eigenvector)
- PageRank or community detection

For those, export edges via `.query().traverse()` or `store.subgraph()` and
use a specialized library such as
[graphology](https://graphology.github.io/) in memory. See
[Limitations](/limitations#no-built-in-graph-analytics) for the full list
of excluded analytics.
