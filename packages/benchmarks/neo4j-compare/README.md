# TypeGraph vs. Neo4j microbenchmark

A minimal head-to-head that runs the same graph shape and the same query
shapes through TypeGraph (SQLite in-process via `better-sqlite3`, or
PostgreSQL via a local pool) and Neo4j 5.26 Community, using matching
methodology (2 warmup iterations, 15 samples, median reported).

**This is a microbenchmark, not LDBC SNB.** It measures a small, stable
graph on a single machine. Use the numbers to anchor order-of-magnitude
claims, not to make universal statements about either system.

## Graph shape

Identical on both sides, seeded from the same xorshift32 RNG with seed 42:

- 1,200 `:User` nodes (id, name, city, ~1KB bio)
- 6,000 `:Post` nodes (id, title, ~4KB body) — 5 per user
- 1,199 `:NEXT` relationships forming a linear chain (`user_0` → `user_1` → …)
- 12,000 `:FOLLOWS` relationships (10 per user)
- 6,000 `:AUTHORED` relationships (1 per post)

**Total: 7,200 nodes + 19,199 relationships + 26k raw items including
post rows with 4KB bodies.**

## What gets measured

| Query | Description |
|---|---|
| `forward traversal` | 1-hop: `user_0`'s follows |
| `cached execute` | Same query text repeated — plan cache hit |
| `prepared execute` | Parameterized `$userId` — plan cache + param binding |
| `reverse traversal` | 1-hop reverse: who follows `user_0` |
| `2-hop traversal` | `user_0` → follows → authored (posts) |
| `3-hop traversal` | `user_500` → follows → follows → authored |
| `aggregate follow count` | COUNT per user over follows |
| `aggregate distinct follow count` | COUNT DISTINCT variant |
| `10-hop recursive` | `:NEXT*10..10` along the linear chain |
| `100-hop recursive` | `:NEXT*100..100` along the linear chain |
| `1000-hop recursive` | `:NEXT*1000..1000` along the linear chain |

## What's NOT measured

- **Inverse-edge traversal** (`expand: "inverse"`): TypeGraph ontology
  feature without a direct Cypher analogue.
- **Subgraph extraction** (`store.subgraph()`): TypeGraph's single-recursive-CTE
  fan-out doesn't map cleanly to Cypher and would need a careful
  port; left out of the v1 harness.
- **Write-path throughput**: seeding times are printed but the benchmark
  doesn't stress bulk writes under contention.

## Fairness caveats

Read this before citing the numbers.

1. **Transport asymmetry.** TypeGraph uses `better-sqlite3`, which is
   synchronous and in-process. Neo4j is a separate server process reached
   over the Bolt protocol on localhost. Every Neo4j query pays a
   TCP round-trip that the TypeGraph side does not. For sub-millisecond
   queries, this overhead dominates — it is a real architectural
   difference that shipping products also face, but it's not a pure
   engine-to-engine comparison.

2. **Cycle semantics differ slightly.** TypeGraph's benchmark uses
   `cyclePolicy: "allow"` (no cycle tracking). Cypher's variable-length
   path enforces relationship uniqueness by default (no repeated edge).
   The `:NEXT` chain is linear, so the traversal space is identical
   either way.

3. **Single node, small graph.** Neo4j's architectural advantages
   (index-free adjacency, native graph storage) show up more clearly
   on graphs with 100M+ edges and deeper traversals. This benchmark
   does not probe that regime.

4. **Warmup may not be enough** for Neo4j's page cache on larger
   graphs. The harness touches every node and edge once before
   measuring, which is sufficient for this size.

5. **JVM cold start.** Neo4j runs on the JVM; the first invocation
   of each query shape is ~50–100% slower than the stable steady
   state because the JIT hasn't kicked in. The per-query warmup
   (2 iterations) handles this for each query shape individually,
   but if you're comparing the very first `pnpm bench` run to
   TypeGraph, expect Neo4j numbers to look ~2× worse than the truth.
   Run `pnpm bench` twice and use the second run's numbers. TypeGraph
   (SQLite via `better-sqlite3`) has no JIT and stabilizes on the
   first run.

## Running the benchmark

### 1. TypeGraph side

From the repo root:

```bash
pnpm --filter @nicia-ai/typegraph-benchmarks bench
```

Record the output.

### 2. Neo4j side

From this directory (`packages/benchmarks/neo4j-compare`):

```bash
# Start Neo4j 5.x Community in Docker
docker compose up -d

# Wait a few seconds for it to come up. You can confirm at http://localhost:7474
# (user: neo4j, pass: benchpass)

# Install the Neo4j driver + tsx
# This directory is intentionally not a workspace member — use --ignore-workspace.
pnpm install --ignore-workspace

# Seed the same graph shape
pnpm seed

# Run the benchmark
pnpm bench
```

### 3. Compare

Paste the two outputs side by side. The shape of each output matches, so
diffing them is straightforward.

## Tear down

```bash
docker compose down -v
```

The `-v` removes the volume so the next run starts clean.

## Configuration

Environment variables (optional):

- `NEO4J_URL` (default `bolt://localhost:7687`)
- `NEO4J_USER` (default `neo4j`)
- `NEO4J_PASSWORD` (default `benchpass`)
- `NEO4J_DATABASE` (default `neo4j`)

The compose file allocates 1GB heap + 1GB pagecache, which is more than
enough for the benchmark graph (~30MB on disk). If you want to test a
different configuration, edit `docker-compose.yml`.
