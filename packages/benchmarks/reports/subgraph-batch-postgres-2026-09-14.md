# Subgraph batching: initial local PostgreSQL measurement

Measured on 2026-09-14 against local PostgreSQL through node-postgres, with
eight iterations after two warmups. These are local database measurements, not
remote-network results or release guardrails.

| Shape | Mode | Median total | Statements | Raw rows | Encoded bytes |
| --- | --- | ---: | ---: | ---: | ---: |
| 75% overlap, full 2,048-byte payload | direct | 5.33 ms | 24 | 115 | 174,385 |
| same | batchOnceUnfused | 6.52 ms | 1 | 8 | 182,259 |
| same | batchOnceShared | 3.00 ms | 1 | 1 | 130,226 |
| 0% overlap, full 256-byte payload | direct | 3.09 ms | 24 | 160 | 58,952 |
| same | batchOnceUnfused | 6.72 ms | 1 | 8 | 69,961 |
| same | batchOnceShared | 4.29 ms | 1 | 1 | 84,363 |
| 75% overlap, identity projection, seeded 2,048-byte payload | direct | 2.11 ms | 24 | 115 | 17,900 |
| same | batchOnceUnfused | 3.91 ms | 1 | 8 | 21,741 |
| same | batchOnceShared | 2.05 ms | 1 | 1 | 23,840 |

The same overlapping full-payload shape was also run with a 20 ms delay
injected before every `backend.execute` call:

| Mode | Median total | Statements | Sum of injected delays |
| --- | ---: | ---: | ---: |
| direct | 47.97 ms | 24 | 480 ms |
| batchOnceUnfused | 27.70 ms | 1 | 20 ms |
| batchOnceShared | 29.43 ms | 1 | 20 ms |

This is a simulated client-side roundtrip delay, not a remote PostgreSQL
measurement. Direct executions run concurrently, so their 24 injected delays
overlap: the summed 480 ms is intentionally much larger than wall time. The
simulation isolates the statement-count effect but does not model server load,
network throughput, or connection-pool contention.

All shapes use eight roots, depth two, and branching factor two. Reproduce a
row against `POSTGRES_URL` by changing the shape arguments:

```bash
pnpm exec tsx src/subgraph-batch-bench.ts --backend=postgres \
  --postgres-driver=pg --roots=8 --depth=2 --branching=2 --overlap=75 \
  --projection=full --payload-bytes=2048 --iterations=8 --warmup=2
```

For overlapping full payloads, opt-in sharing reduced encoded bytes by 28.6%
and total time by 54.0% relative to the default one-statement batch. With no
overlap it increased encoded bytes by 20.6%, although this local run was 36.2%
faster than the unfused SQL shape. Identity-only sharing was 47.7% faster than
the unfused control but encoded 9.7% more bytes. Together with SQLite, these
results support an explicit opt-in: overlap and payload determine transfer
benefit, and local planner timing does not predict remote latency.

Backend duration is the sum of client-observed `backend.execute` durations,
not server execution time. Concurrent direct calls overlap, so this sum can
exceed total wall time. Encoded bytes are UTF-8 JSON size at the backend
boundary, not database-protocol wire bytes. Heap deltas are omitted because
short-run, non-forced-GC measurements were noisy.
