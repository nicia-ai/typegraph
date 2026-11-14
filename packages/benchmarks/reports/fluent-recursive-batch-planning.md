# Fluent recursive batch planner costs

Measured on PostgreSQL 18.6 (`pgvector/pgvector:pg18`), x86_64 Linux, using the bundled Docker server with default
planner settings. The fixture has eight Person nodes and seven knows edges in a chain. Each fluent query starts at
an ID (cycling through the eight nodes), traverses knows recursively with maxHops 2, and selects the friend's name.
This deliberately small fixture isolates statement growth from graph size. Timings are local observations, not
service-level guarantees.

## Reproduce

Start the bundled server with `docker compose -f packages/typegraph/docker-compose.yml up -d --wait`, then run:

```sh
POSTGRES_URL=postgresql://typegraph:typegraph@localhost:5432/typegraph_test \
  node --import tsx packages/typegraph/scripts/measure-recursive-batch-planning.ts \
  > /tmp/fluent-recursive-plans.jsonl
```

The script creates and drops its own schema and uses a fresh backend session for each size/mode pair. It composes
the same compiler output, source/row CTEs, ordinal window, JSON aggregates, UNION ALL envelope, and final ordering
as batchOnce, deliberately outside its admission guard. It verifies the 25-read SQL against captured batchOnce
compilation before measuring. This allows reproducing the oversized shapes after the guard ships. Run this
measurement on an isolated server with memory headroom. It prints full EXPLAIN (ANALYZE, BUFFERS, MEMORY, FORMAT
JSON), SQL byte/bind counts, and Linux backend VmHWM/VmRSS after every sample. The accompanying JSON retains all
sample summaries, including planning and execution buffer counters; rerunning emits the full plan trees.

## Unnamed statements

Six consecutive EXPLAIN ANALYZE executions per shape, on the same session. Planner memory is Memory Used, in KiB;
peak RSS is the session's kernel high-water mark after all six samples. Timing is the median of all six samples,
including the first.

| Reads | SQL bytes | Binds | Planner KiB | Median planning ms | Peak RSS KiB |
| --- | --- | --- | --- | --- | --- |
| 25 | 90,305 | 450 | 25,267 | 46.07 | 71,060 |
| 100 | 362,381 | 1,800 | 102,374 | 382.73 | 207,220 |
| 500 | 1,819,181 | 9,000 | 543,406 | 6,079.43 | 989,812 |

At 500 reads the batch passes the 500-read and bind limits, yet uses about 531 MiB of planner memory and peaks at
967 MiB RSS. Planning dominates execution (205–668 ms execution versus 5.6–8.3 seconds planning). Costs are
substantial even with only 15 stored graph rows. Unnamed execution does not guarantee immediate RSS return to the
OS: this session still reported 787,780 KiB after its sixth execution.

## Named prepared statements

Each iteration first executes the SELECT using pg's statement name, then runs EXPLAIN ANALYZE EXECUTE with the same
values. Thus six iterations execute the SELECT twelve times; this intentionally exercises PostgreSQL's automatic
custom-to-generic plan switch. Each shape ended with five custom and seven generic uses. EXPLAIN EXECUTE's own
parse/argument overhead remains visible even when the cached SELECT plan is reused.

| Reads | Maximum planner KiB | Median planning ms, first 3 samples | Planning ms, cached samples 4–6 | Peak RSS KiB | Final resident KiB |
| --- | --- | --- | --- | --- | --- |
| 25 | 27,972 | 40.81 | 0.26–0.52 | 66,456 | 56,788 |
| 100 | 113,166 | 409.97 | 1.82–1.96 | 204,664 | 157,608 |
| 500 | 597,118 | 9,366.06 | 8.06–53.79 | 976,920 | 966,940 |

Caching lowers later planning latency but does not avoid building a large plan or keeping substantial memory on the
pooled connection. A named statement therefore does not remove the need for admission control.

## Policy

Use the existing conservative allowance of 25 plans for the combined total of independent fluent recursive stages
and subgraph groups. This fixture costs about 25 MiB of planner memory at that boundary; the earlier subgraph
fixture in #833 cost about 32 MB. These are different measurements, not an assumption of equivalent cost. The
allowance bounds plan multiplicity, not total query memory or execution cost.

Compiler metadata marks each emitted fluent recursive stage and propagates through SQL composition, including set
operations, relations, projections, and nested expressions. Subgraphs count after compatible roots combine. A mixed
batch gets one combined allowance, not 25 fluent stages plus another 25 subgraphs. PostgreSQL refuses excess plans
before execution with ConfigurationError; SQLite retains its existing request/bind limits. This preserves
batchOnce's exact-one-statement contract. Fluent plan fusion is deferred because arbitrary filters, chained stages,
ordering, projections, and set operations require a separate compatibility design; callers can explicitly split
batches or use compatible subgraph helpers when those fit their reads.
